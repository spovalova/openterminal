// XBRL taxonomy browsing (FASB, SEC, IFRS and FRC taxonomies), provider sec. Ported from
// openbb_sec/utils/xbrl_taxonomy_helper.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the synchronous requests and
// disk cache are ctx.http and ctx.cache, so the client and manager methods are async; zip members are read with fflate;
// the IFRS date discovery is memoised through ctx.cache instead of a module variable.
import { unzipSync } from 'fflate'
import { BROWSER_UA } from '../../http.js'
import { cachedRequest } from '../helpers.js'
import type { NativeCtx } from '../../types.js'
import { FRC_MEMBER_FRAGMENTS, FRC_SUITE_ZIPS, IFRS_STANDARD_NAMES, IFRS_VERSION_DATES_FALLBACK, SEC_COMPONENT_NAMES, TAXONOMIES, type TaxonomyConfig } from './taxonomy-data.js'
import { OpenBBError, TaxonomyCategory, TaxonomyStyle, XBRLNode, XBRLParser, type SchemaRole } from './xbrl-parser.js'

export { TAXONOMIES, type TaxonomyConfig }

const WEEK_S = 3600 * 24 * 7

// FRC taxonomy suites: frc-core ships in every suite; the Detailed Profit & Loss (dpl) taxonomy entered in 2022.
const FRC_CORE_YEARS: number[] = Object.keys(FRC_SUITE_ZIPS)
  .map(Number)
  .sort((a, b) => b - a)
const FRC_DPL_YEARS: number[] = FRC_CORE_YEARS.filter((y) => y >= 2022)
const FRC_TAXONOMIES = new Set(['frc-core', 'frc-dpl'])

/** What `cached_text` / `cached_bytes` send when the caller gives no headers: a browser user agent. */
const FETCH_HEADERS = { 'User-Agent': BROWSER_UA }

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A taxonomy component's listing entry (`get_components_metadata`). */
export type ComponentMetadata = { name: string; label: string; description: string | null; category: string | null; url: string | null }

// ---------------------------------------------------------------------------------------------------------------
// IFRS dates
// ---------------------------------------------------------------------------------------------------------------

/**
 * `get_ifrs_version_dates`: IFRS year → date of the taxonomy directory. The SEC's edgartaxonomies.xml adds newer years
 * when it can be read (it refuses a browser user agent, so the hardcoded list is usually what is used).
 */
export function getIfrsVersionDates(ctx: NativeCtx): Promise<Record<number, string>> {
  return ctx.cache('sec:ifrs_version_dates', WEEK_S * 1000, async () => {
    const discovered: Record<number, string> = {}
    try {
      const text = await cachedRequest(ctx, 'https://www.sec.gov/info/edgar/edgartaxonomies.xml', { kind: 'text', headers: FETCH_HEADERS, expireS: WEEK_S })
      // e.g. https://xbrl.ifrs.org/taxonomy/2025-03-27/...
      for (const m of text.matchAll(/xbrl\.ifrs\.org\/taxonomy\/(\d{4}-\d{2}-\d{2})\//g)) discovered[Number(m[1]!.slice(0, 4))] = m[1]!
    } catch {
      // keep the fallback dates
    }
    return { ...IFRS_VERSION_DATES_FALLBACK, ...discovered }
  })
}

/** `_resolve_ifrs_url`: a URL inside the IFRS taxonomy of a year. */
async function resolveIfrsUrl(ctx: NativeCtx, year: number, path = ''): Promise<string> {
  const ifrsDates = await getIfrsVersionDates(ctx)
  const date = ifrsDates[year]
  if (!date) throw new OpenBBError(`IFRS taxonomy year ${year} is not available. Known years: [${Object.keys(ifrsDates).map(Number).sort((a, b) => b - a).join(', ')}]`)
  const base = `https://xbrl.ifrs.org/taxonomy/${date}/`
  return path ? `${base}${path}` : base
}

const sortedYearsDesc = (dates: Record<number, string>): number[] => Object.keys(dates).map(Number).sort((a, b) => b - a)

// ---------------------------------------------------------------------------------------------------------------
// FASBClient
// ---------------------------------------------------------------------------------------------------------------

/** Python's `sorted(strings)`: by code point. */
const sortStrings = (a: string[]): string[] => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))

/** Handles interaction with XBRL websites (FASB and SEC). */
export class FASBClient {
  /** dir_url → file names in the listing */
  private dirCache = new Map<string, string[]>()
  /** year → the FRC suite's zip bytes */
  private frcSuiteCache = new Map<number, Uint8Array>()

  constructor(private readonly ctx: NativeCtx) {}

  /** `list_files`: the plain file names linked from a directory listing page, sorted. */
  async listFiles(dirUrl: string): Promise<string[]> {
    if (!dirUrl.endsWith('/')) dirUrl += '/'
    let files = this.dirCache.get(dirUrl)
    if (!files) {
      const html = await this.fetchUrlContent(dirUrl)
      const raw = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)
      files = sortStrings(raw.filter((f) => f && !f.startsWith('/') && !f.startsWith('http') && !f.startsWith('?') && f !== '../'))
      this.dirCache.set(dirUrl, files)
    }
    return files
  }

  /** `find_file`: the first file in a directory whose name contains every fragment, as a full URL. */
  async findFile(dirUrl: string, ...fragments: string[]): Promise<string | null> {
    if (!dirUrl.endsWith('/')) dirUrl += '/'
    let files: string[]
    try {
      files = await this.listFiles(dirUrl)
    } catch {
      return null
    }
    for (const fname of files) if (fragments.every((frag) => fname.includes(frag))) return `${dirUrl}${fname}`
    return null
  }

  /** `get_available_years`: the years a taxonomy has been published for, newest first. */
  async getAvailableYears(taxonomy: string, config: TaxonomyConfig): Promise<number[]> {
    if (config.style === TaxonomyStyle.STATIC) {
      // Static taxonomies (e.g. rocr 2015) embed the year in the URL.
      const m = /\/(\d{4})\//.exec(config.base_url_template)
      return m ? [Number(m[1])] : []
    }
    if (config.style === TaxonomyStyle.EXTERNAL) {
      if (taxonomy === 'ifrs') return sortedYearsDesc(await getIfrsVersionDates(this.ctx))
      if (taxonomy === 'frc-core') return [...FRC_CORE_YEARS]
      if (taxonomy === 'frc-dpl') return [...FRC_DPL_YEARS]
      return []
    }
    const baseRoot = config.base_url_template.split('{year}')[0]!
    try {
      const content = await this.fetchUrlContent(baseRoot)
      const years = [...content.matchAll(/href="(\d{4})\/"/g)].map((m) => Number(m[1]))
      return years.sort((a, b) => b - a)
    } catch (e) {
      throw new OpenBBError(`Failed to fetch available years for ${taxonomy}: ${errMsg(e)}`)
    }
  }

  /** `get_components_for_year`: the statements or disclosures (presentation files) a taxonomy year has. */
  async getComponentsForYear(year: number, config: TaxonomyConfig): Promise<string[]> {
    if (config.style === TaxonomyStyle.STATIC) return ['standard']

    if (config.style === TaxonomyStyle.EXTERNAL) {
      // IFRS: the entry-point schema imports one role file per standard.
      if (config.base_url_template.includes('ifrs')) {
        try {
          const dates = await getIfrsVersionDates(this.ctx)
          const epUrl = await resolveIfrsUrl(this.ctx, year, `full_ifrs_entry_point_${dates[year]}.xsd`)
          const content = await this.fetchUrlContent(epUrl)
          const standards = sortStrings([...new Set([...content.matchAll(/full_ifrs\/linkbases\/([a-z]+_\d+)\/rol_/g)].map((m) => m[1]!))])
          return standards.length ? standards : ['standard']
        } catch (e) {
          throw new OpenBBError(`Failed to fetch IFRS components for ${year}: ${errMsg(e)}`)
        }
      }
      // Non-IFRS external taxonomies (FRC core/dpl): a single component
      return ['standard']
    }

    const baseUrl = config.base_url_template.replaceAll('{year}', String(year))

    if (config.style === TaxonomyStyle.FASB_STANDARD) {
      const stmUrl = `${baseUrl}stm/`
      try {
        const files = await this.listFiles(stmUrl)
        const components = new Set<string>()
        // "stm/us-gaap-stm-" → strip "stm/" to get the file name prefix "us-gaap-stm-"
        let prefix = config.presentation_file_template.split('{name}')[0]!
        if (prefix.startsWith('stm/')) prefix = prefix.slice(4)
        for (const fname of files) {
          if (fname.includes('-pre-') && fname.startsWith(prefix)) {
            // rest = "soc-pre-2023.xml" or "soc-pre-2019-01-31.xml"
            const comp = fname.slice(prefix.length).split('-pre-')[0]!
            if (comp) components.add(comp)
          }
        }
        return sortStrings([...components])
      } catch (e) {
        throw new OpenBBError(`Failed to fetch components for ${year}: ${errMsg(e)}`)
      }
    }

    if (config.style === TaxonomyStyle.SEC_EMBEDDED || config.style === TaxonomyStyle.SEC_STANDALONE) {
      try {
        const files = await this.listFiles(baseUrl)
        const components = new Set<string>()
        for (const fname of files) {
          if (config.presentation_pattern_regex) {
            // {year} becomes a catch-all date pattern; re.match anchors at the start only
            const yrPat = `${year}(?:-\\d{2}-\\d{2})?`
            const m = new RegExp(`^(?:${config.presentation_pattern_regex.replaceAll('{year}', yrPat)})`).exec(fname)
            if (m) components.add(m[1]!)
          }
        }
        if (components.size) return sortStrings([...components])
        // Fallback: if any file mentions this year, it is a single-component taxonomy
        if (files.some((f) => f.includes(String(year)))) return ['standard']
        return []
      } catch {
        return []
      }
    }
    return []
  }

  /** `fetch_file`: a file's bytes. */
  async fetchFile(url: string): Promise<Uint8Array> {
    try {
      return await cachedRequest(this.ctx, url, { kind: 'bytes', headers: FETCH_HEADERS })
    } catch (e) {
      throw new OpenBBError(`Failed to fetch ${url}: ${errMsg(e)}`)
    }
  }

  /** `_fetch_url_content`: directory listing or text file content. */
  private fetchUrlContent(url: string): Promise<string> {
    return cachedRequest(this.ctx, url, { kind: 'text', headers: FETCH_HEADERS, expireS: WEEK_S })
  }

  /** `_frc_suite_bytes`: the FRC taxonomy suite zip of a year. */
  private async frcSuiteBytes(year: number): Promise<Uint8Array> {
    const cached = this.frcSuiteCache.get(year)
    if (cached) return cached
    const url = FRC_SUITE_ZIPS[year]
    if (!url) throw new OpenBBError(`No FRC taxonomy suite is mapped for year ${year}.`)
    const raw = await cachedRequest(this.ctx, url, { kind: 'bytes', headers: FETCH_HEADERS, expireS: WEEK_S })
    this.frcSuiteCache.set(year, raw)
    return raw
  }

  /** `_frc_relpath`: a member's name without the release-specific suite root directory. */
  private static frcRelpath(name: string): string {
    const slash = name.indexOf('/')
    return slash >= 0 ? name.slice(slash + 1) : name
  }

  /** `find_frc_member`: the first suite member (by name) whose relative path has every fragment and none of `exclude`. */
  async findFrcMember(year: number, fragments: readonly string[], exclude: readonly string[] = []): Promise<string | null> {
    const archive = await this.frcSuiteBytes(year)
    const names: string[] = []
    unzipSync(archive, {
      filter: (file) => {
        names.push(file.name)
        return false
      },
    })
    for (const name of sortStrings(names)) {
      const rel = FASBClient.frcRelpath(name)
      if (rel && fragments.every((f) => rel.includes(f)) && !exclude.some((bad) => rel.includes(bad))) return rel
    }
    return null
  }

  /** `fetch_frc_member`: a suite member's bytes. */
  async fetchFrcMember(year: number, relpath: string): Promise<Uint8Array> {
    const archive = await this.frcSuiteBytes(year)
    let wanted: string | undefined
    unzipSync(archive, {
      filter: (file) => {
        if (wanted === undefined && FASBClient.frcRelpath(file.name) === relpath) wanted = file.name
        return false
      },
    })
    if (wanted !== undefined) {
      const name = wanted
      const files = unzipSync(archive, { filter: (file) => file.name === name })
      const data = files[name]
      if (data) return data
    }
    throw new OpenBBError(`FRC suite ${year} has no member '${relpath}'.`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// XBRLManager
// ---------------------------------------------------------------------------------------------------------------

const INDUSTRY_PREFIXES: Record<string, string> = { basi: 'Basic', bd: 'Broker-Dealer', ci: 'Commercial & Industrial', ins: 'Insurance', re: 'Real Estate' }

/** Python's `str.rstrip("/").rsplit("/", 1)[-1]`. */
const lastSegment = (uri: string): string => {
  const s = uri.replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

/** Main entry point for accessing XBRL taxonomies (`XBRLManager`); one instance per call. */
export class XBRLManager {
  readonly client: FASBClient
  readonly parser: XBRLParser
  private labelsLoadedFor = new Set<string>()
  private propertiesLoadedFor = new Set<string>()

  constructor(private readonly ctx: NativeCtx) {
    this.client = new FASBClient(ctx)
    this.parser = new XBRLParser(undefined, ctx)
  }

  private static key = (taxonomy: string, year: number): string => `${taxonomy}\u0000${year}`

  /** `_frc_member`: the suite member path for a taxonomy and file kind. */
  private frcMember(taxonomy: string, year: number, kind: string): Promise<string | null> {
    const [fragments, exclude] = FRC_MEMBER_FRAGMENTS[taxonomy]![kind]!
    return this.client.findFrcMember(year, fragments, exclude)
  }

  /** `_ensure_element_properties`: type, period type, balance, … of the taxonomy's elements, from its main schema. */
  private async ensureElementProperties(taxonomy: string, year: number): Promise<void> {
    const key = XBRLManager.key(taxonomy, year)
    if (this.propertiesLoadedFor.has(key)) return
    const config = TAXONOMIES[taxonomy]
    if (!config) return

    if (config.style === TaxonomyStyle.EXTERNAL && FRC_TAXONOMIES.has(taxonomy)) {
      const member = await this.frcMember(taxonomy, year, 'schema')
      if (member) {
        try {
          const content = await this.client.fetchFrcMember(year, member)
          if (this.parser.loadSchemaElementProperties(content) > 0) this.propertiesLoadedFor.add(key)
        } catch {
          // best effort
        }
      }
      return
    }

    const urls: string[] = []
    if (config.style === TaxonomyStyle.EXTERNAL && taxonomy === 'ifrs') {
      const date = (await getIfrsVersionDates(this.ctx))[year]
      if (date) urls.push(`https://xbrl.ifrs.org/taxonomy/${date}/full_ifrs/full_ifrs-cor_${date}.xsd`)
    } else if (config.style === TaxonomyStyle.STATIC) {
      urls.push(config.base_url_template + config.label_file_pattern)
    } else {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      if (config.style === TaxonomyStyle.FASB_STANDARD) {
        const eltsUrl = `${baseUrl}elts/`
        const found = (await this.client.findFile(eltsUrl, `${taxonomy}-`, String(year), '.xsd')) ?? (await this.client.findFile(eltsUrl, taxonomy, String(year), '.xsd'))
        if (found) urls.push(found)
      } else {
        for (const frags of [
          [`${taxonomy}-`, String(year), '.xsd'],
          [`${taxonomy}-entire-`, String(year), '.xsd'],
          [taxonomy, String(year), '.xsd'],
        ]) {
          const found = await this.client.findFile(baseUrl, ...frags)
          if (found) urls.push(found)
        }
      }
    }

    for (const url of urls) {
      try {
        const content = await this.client.fetchFile(url)
        if (this.parser.loadSchemaElementProperties(content) > 0) {
          this.propertiesLoadedFor.add(key)
          return
        }
      } catch {
        continue
      }
    }
  }

  /** `_get_roles_for_taxonomy`: role definitions of a taxonomy, to enrich component listings. */
  private async getRolesForTaxonomy(taxonomy: string, year: number): Promise<SchemaRole[]> {
    const config = TAXONOMIES[taxonomy]
    if (!config) return []

    const urls: string[] = []
    if (config.style === TaxonomyStyle.FASB_STANDARD) {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      const short = taxonomy.replaceAll('-gaap', '')
      const eltsUrl = `${baseUrl}elts/`
      const foundRoles = (await this.client.findFile(eltsUrl, `${short}-roles-`, String(year), '.xsd')) ?? (await this.client.findFile(eltsUrl, 'roles', String(year), '.xsd'))
      if (foundRoles) urls.push(foundRoles)
      const foundMain = (await this.client.findFile(eltsUrl, `${taxonomy}-`, String(year), '.xsd')) ?? (await this.client.findFile(eltsUrl, taxonomy, String(year), '.xsd'))
      if (foundMain) urls.push(foundMain)
    } else if (config.style === TaxonomyStyle.SEC_EMBEDDED || config.style === TaxonomyStyle.SEC_STANDALONE) {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      for (const frags of [
        [`${taxonomy}-${year}`, '.xsd'],
        [`${taxonomy}-entire-`, String(year), '.xsd'],
        [`${taxonomy}-sub-`, String(year), '.xsd'],
      ]) {
        const found = await this.client.findFile(baseUrl, ...frags)
        if (found) urls.push(found)
      }
    } else if (config.style === TaxonomyStyle.STATIC) {
      urls.push(config.base_url_template + config.label_file_pattern)
    }

    for (const url of urls) {
      try {
        const content = await this.client.fetchFile(url)
        const [, roles] = this.parser.parseSchema(content)
        if (roles.length) return roles
      } catch {
        continue
      }
    }
    return []
  }

  /** `get_components_metadata`: the components of a taxonomy year with label, description and category. */
  async getComponentsMetadata(taxonomy: string, year: number): Promise<ComponentMetadata[]> {
    const config = TAXONOMIES[taxonomy]
    if (!config) return []
    const components = await this.listAvailableComponents(taxonomy, year)
    if (!components.length) return []

    // --- Strategy 1: FASB, where role ids match component names ---
    if (config.style === TaxonomyStyle.FASB_STANDARD) {
      const roles = await this.getRolesForTaxonomy(taxonomy, year)
      const roleByName = new Map<string | null, SchemaRole>(roles.map((r) => [r.name, r]))
      const results: ComponentMetadata[] = []
      for (const comp of components) {
        let role = roleByName.get(comp)
        let prefixLabel = ''
        // No direct match: strip the first segment as an industry prefix (e.g. "basi-com" → "com").
        if (role === undefined && comp.includes('-')) {
          const dash = comp.indexOf('-')
          const prefix = comp.slice(0, dash)
          role = roleByName.get(comp.slice(dash + 1))
          if (role !== undefined) prefixLabel = INDUSTRY_PREFIXES[prefix] ?? prefix.toUpperCase()
        }
        if (role) {
          const short = role.short_name ?? comp
          results.push({ name: comp, label: prefixLabel ? `${short} (${prefixLabel})` : short, description: role.long_name ?? null, category: role.group ?? null, url: null })
        } else results.push({ name: comp, label: comp, description: null, category: null, url: null })
      }
      return results
    }

    // --- Strategy 2: IFRS, per-standard role files and known names ---
    if (config.style === TaxonomyStyle.EXTERNAL && taxonomy === 'ifrs') {
      const date = (await getIfrsVersionDates(this.ctx))[year]
      const results: ComponentMetadata[] = []
      for (const comp of components) {
        const label = IFRS_STANDARD_NAMES[comp] ?? comp.replaceAll('_', ' ').toUpperCase()
        let description: string | null = null
        let category: string | null = null
        if (date) {
          const roleUrl = `https://xbrl.ifrs.org/taxonomy/${date}/full_ifrs/linkbases/${comp}/rol_${comp}_${date}.xsd`
          try {
            const content = await this.client.fetchFile(roleUrl)
            const [, rolesList] = this.parser.parseSchema(content)
            if (rolesList.length) {
              const descriptions = rolesList.map((r) => r.long_name ?? '')
              description = descriptions
                .slice(0, 5)
                .filter(Boolean)
                .join('; ')
              const firstDef = rolesList[0]!.long_name ?? ''
              category = firstDef.includes('Statement') ? 'statement' : firstDef.includes('Notes') ? 'notes' : 'disclosure'
            }
          } catch {
            // no role file for this standard
          }
        }
        results.push({ name: comp, label, description: description || label, category, url: null })
      }
      return results
    }

    // --- Strategy 3: SEC multi-component: map roles to components through the roleRefs their files use ---
    const allRoles = await this.getRolesForTaxonomy(taxonomy, year)
    const roleByUri = new Map<string, SchemaRole>()
    for (const r of allRoles) roleByUri.set((r.name ?? '').toLowerCase(), r)

    const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
    const results: ComponentMetadata[] = []
    for (const comp of components) {
      let compRoles: SchemaRole[] = []
      const compUrls: string[] = []
      const foundTc = await this.client.findFile(baseUrl, `${taxonomy}-${comp}-`, String(year), '.xsd')
      if (foundTc) compUrls.push(foundTc)
      const foundC = await this.client.findFile(baseUrl, `${comp}-${year}`, '.xsd')
      if (foundC) compUrls.push(foundC)
      if (!compUrls.length) {
        // Broader search: any file containing the component name
        const foundBroad = await this.client.findFile(baseUrl, comp, String(year), '.xsd')
        if (foundBroad) compUrls.push(foundBroad)
      }

      for (const compUrl of compUrls) {
        try {
          const content = await this.client.fetchFile(compUrl)
          const respText = new TextDecoder('utf-8').decode(content)
          const roleUris = [...respText.matchAll(/roleURI="([^"]*)"/g)].map((m) => m[1]!)
          const presRoles = [...respText.matchAll(/<link:presentationLink[^>]*role="([^"]*)"/g)].map((m) => m[1]!)
          // Python iterates a set, whose order is arbitrary; the order of first appearance is used here.
          const usedUris = [...new Set([...roleUris, ...presRoles])]
          for (const uri of usedUris) {
            // e.g. http://xbrl.sec.gov/rr/role/RiskReturn → RiskReturn
            const role = roleByUri.get(lastSegment(uri).toLowerCase())
            if (role) compRoles.push(role)
          }
          if (compRoles.length) break
        } catch {
          continue
        }
      }

      if (compRoles.length) {
        // Sort by document number; the sort is stable
        compRoles = [...compRoles].sort((a, b) => ((a.document_number ?? '999999') < (b.document_number ?? '999999') ? -1 : (a.document_number ?? '999999') > (b.document_number ?? '999999') ? 1 : 0))
        const first = compRoles[0]!
        const descriptionParts = compRoles.map((r) => r.long_name ?? '')
        results.push({
          name: comp,
          label: compRoles.length === 1 ? (first.short_name ?? comp) : `${compRoles[0]!.short_name ?? comp} (+${compRoles.length - 1} more)`,
          description: descriptionParts
            .slice(0, 5)
            .filter(Boolean)
            .join('; '),
          category: first.group ?? null,
          url: null,
        })
      } else {
        const known = SEC_COMPONENT_NAMES[taxonomy]?.[comp]
        if (known) results.push({ name: comp, label: known.label, description: known.description ?? known.label, category: known.category ?? null, url: null })
        else results.push({ name: comp, label: comp.toUpperCase(), description: null, category: null, url: null })
      }
    }
    return results
  }

  /** `_ensure_labels`: labels and documentation of a taxonomy year, from the best source available. */
  private async ensureLabels(taxonomy: string, year: number): Promise<void> {
    const key = XBRLManager.key(taxonomy, year)
    if (this.labelsLoadedFor.has(key)) return
    const config = TAXONOMIES[taxonomy]
    if (!config) return

    // --- IFRS: dedicated label and documentation files ---
    if (config.style === TaxonomyStyle.EXTERNAL && taxonomy === 'ifrs') {
      const date = (await getIfrsVersionDates(this.ctx))[year]
      if (!date) return
      const base = `https://xbrl.ifrs.org/taxonomy/${date}`
      const urls = [`${base}/full_ifrs/labels/lab_full_ifrs-en_${date}.xml`, `${base}/full_ifrs/labels/lab_ias_1-en_${date}.xml`, `${base}/full_ifrs/labels/doc_full_ifrs-en_${date}.xml`, `${base}/full_ifrs/labels/doc_ias_1-en_${date}.xml`]
      let loadedAny = false
      for (const url of urls) {
        try {
          const labelsBefore = Object.keys(this.parser.labels).length
          const docsBefore = Object.keys(this.parser.documentation).length
          const content = await this.client.fetchFile(url)
          this.parser.parseLabelLinkbase(content, TaxonomyStyle.FASB_STANDARD)
          if (Object.keys(this.parser.labels).length > labelsBefore || Object.keys(this.parser.documentation).length > docsBefore) loadedAny = true
        } catch {
          continue
        }
      }
      if (loadedAny) this.labelsLoadedFor.add(key)
      return
    }

    // --- FRC core / dpl: the label linkbase inside the suite zip ---
    if (config.style === TaxonomyStyle.EXTERNAL && FRC_TAXONOMIES.has(taxonomy)) {
      const member = await this.frcMember(taxonomy, year, 'label')
      if (member) {
        try {
          const content = await this.client.fetchFrcMember(year, member)
          this.parser.parseLabelLinkbase(content, TaxonomyStyle.SEC_EMBEDDED)
          if (Object.keys(this.parser.labels).length) this.labelsLoadedFor.add(key)
        } catch {
          // best effort
        }
      }
      return
    }

    // Candidate URLs, in order
    const urlsToTry: string[] = []
    if (config.style === TaxonomyStyle.STATIC) urlsToTry.push(config.base_url_template + config.label_file_pattern)
    else {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      // Primary: resolve the label file from the directory listing
      if (config.label_file_pattern) {
        if (config.style === TaxonomyStyle.FASB_STANDARD) {
          const found = (await this.client.findFile(`${baseUrl}elts/`, taxonomy, 'lab', String(year))) ?? (await this.client.findFile(`${baseUrl}elts/`, 'lab', String(year)))
          if (found) urlsToTry.push(found)
        } else {
          const found = (await this.client.findFile(baseUrl, taxonomy, 'lab', String(year))) ?? (await this.client.findFile(baseUrl, 'lab', String(year)))
          if (found) urlsToTry.push(found)
        }
      }
      // Fallbacks for SEC taxonomies
      if (config.style !== TaxonomyStyle.FASB_STANDARD) {
        for (const frags of [
          [`${taxonomy}-${year}`, '.xsd'],
          [`${taxonomy}-entire-`, String(year), '.xsd'],
          [`${taxonomy}-sub-`, String(year), '.xsd'],
          [`${taxonomy}-std-`, String(year)],
          [taxonomy, 'doc', String(year)],
        ]) {
          const found = await this.client.findFile(baseUrl, ...frags)
          if (found) urlsToTry.push(found)
        }
      }
    }

    let loadedAny = false
    for (const url of urlsToTry) {
      try {
        const labelsBefore = Object.keys(this.parser.labels).length
        const docsBefore = Object.keys(this.parser.documentation).length
        const content = await this.client.fetchFile(url)
        this.parser.parseLabelLinkbase(content, TaxonomyStyle.SEC_EMBEDDED)
        if (Object.keys(this.parser.labels).length > labelsBefore || Object.keys(this.parser.documentation).length > docsBefore) loadedAny = true
      } catch {
        continue
      }
    }

    // Dedicated documentation files: FASB uses *-doc-{year}.xml (SEC's *_doc.xsd is already in the list above).
    const docUrls: string[] = []
    if (config.style === TaxonomyStyle.FASB_STANDARD) {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      const foundDoc = (await this.client.findFile(`${baseUrl}elts/`, taxonomy, 'doc', String(year))) ?? (await this.client.findFile(`${baseUrl}elts/`, 'doc', String(year)))
      if (foundDoc) docUrls.push(foundDoc)
    }
    for (const url of docUrls) {
      try {
        const docsBefore = Object.keys(this.parser.documentation).length
        const content = await this.client.fetchFile(url)
        this.parser.parseLabelLinkbase(content, TaxonomyStyle.FASB_STANDARD)
        if (Object.keys(this.parser.documentation).length > docsBefore) loadedAny = true
      } catch {
        continue
      }
    }

    if (loadedAny) this.labelsLoadedFor.add(key)

    // Reference fallback: SEC taxonomies often have no documentation labels but embed referenceLink citations.
    if (config.style === TaxonomyStyle.SEC_EMBEDDED || config.style === TaxonomyStyle.SEC_STANDALONE) {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      let foundRef = (await this.client.findFile(baseUrl, `${taxonomy}-${year}`, '.xsd')) ?? (await this.client.findFile(baseUrl, taxonomy, 'ref', String(year)))
      // Broader: any .xsd containing the taxonomy name and year
      if (!foundRef) foundRef = await this.client.findFile(baseUrl, taxonomy, String(year), '.xsd')
      if (foundRef) {
        try {
          const refContent = await this.client.fetchFile(foundRef)
          this.parser.parseReferenceLinkbase(refContent)
        } catch {
          // best effort
        }
      }
    }
  }

  /** `_load_frc_core_labels`: FRC core labels, so frc-dpl's `core_*` references resolve. */
  private async loadFrcCoreLabels(year: number): Promise<void> {
    const frcKey = XBRLManager.key('frc-core', year)
    if (this.labelsLoadedFor.has(frcKey)) return
    const member = await this.frcMember('frc-core', year, 'label')
    if (!member) return
    try {
      const labelsBefore = Object.keys(this.parser.labels).length
      const content = await this.client.fetchFrcMember(year, member)
      this.parser.parseLabelLinkbase(content, TaxonomyStyle.SEC_EMBEDDED)
      if (Object.keys(this.parser.labels).length > labelsBefore) this.labelsLoadedFor.add(frcKey)
    } catch {
      // best effort
    }
  }

  /** `_parse_entire_file`: a taxonomy's `*-entire-{year}.xsd`, following its local imports when it only wraps them. */
  private async parseEntireFile(taxonomy: string, year: number, config: TaxonomyConfig): Promise<XBRLNode[]> {
    const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
    const entireUrl = await this.client.findFile(baseUrl, `${taxonomy}-entire-`, String(year), '.xsd')
    if (!entireUrl) return [] // no -entire- file in the directory listing
    let content: Uint8Array
    try {
      content = await this.client.fetchFile(entireUrl)
    } catch {
      return []
    }

    // Direct parse works when the linkbases are embedded directly
    const nodes = this.parser.parsePresentation(content, config.style)
    if (nodes.length) return nodes

    // Otherwise follow the xs:import references that are local files
    const [, , , imports] = this.parser.parseSchema(content)
    const allNodes: XBRLNode[] = []
    for (const imp of imports) {
      const loc = imp.schemaLocation ?? ''
      if (loc.startsWith('http') || !loc) continue
      const importUrl = new URL(loc, entireUrl).href
      try {
        const subContent = await this.client.fetchFile(importUrl)
        allNodes.push(...this.parser.parsePresentation(subContent, config.style))
      } catch {
        continue
      }
    }
    return allNodes
  }

  /** `_get_frc_structure`: frc-dpl's presentation tree, else the schema's elements as a flat list. */
  private async getFrcStructure(taxonomy: string, year: number): Promise<XBRLNode[]> {
    let nodes: XBRLNode[] = []
    if (taxonomy === 'frc-dpl') {
      const presentation = await this.frcMember(taxonomy, year, 'presentation')
      if (presentation) {
        try {
          const content = await this.client.fetchFrcMember(year, presentation)
          nodes = this.parser.parsePresentation(content, TaxonomyStyle.SEC_EMBEDDED)
        } catch {
          // fall back to the schema
        }
      }
    }
    if (!nodes.length) {
      const schema = await this.frcMember(taxonomy, year, 'schema')
      if (schema) {
        const content = await this.client.fetchFrcMember(year, schema)
        nodes = this.parser.parseSchemaElements(content)
      }
    }
    return nodes
  }

  /** `_get_ifrs_structure`: one IFRS standard's presentation tree, or the core schema's flat element list. */
  private async getIfrsStructure(year: number, component: string): Promise<XBRLNode[]> {
    const ifrsDates = await getIfrsVersionDates(this.ctx)
    const date = ifrsDates[year]
    if (!date) throw new OpenBBError(`IFRS taxonomy not available for year ${year}. Known years: [${sortedYearsDesc(ifrsDates).join(', ')}]`)

    if (component !== 'standard') {
      const epUrl = await resolveIfrsUrl(this.ctx, year, `full_ifrs_entry_point_${date}.xsd`)
      let epText: string
      try {
        epText = new TextDecoder('utf-8').decode(await this.client.fetchFile(epUrl))
      } catch (e) {
        throw new OpenBBError(`Failed to fetch IFRS entry point for ${year}: ${errMsg(e)}`)
      }
      // presentationLinkbaseRef hrefs of this standard, e.g. full_ifrs/linkbases/ias_1/pre_ias_1_2025-03-27_role-210000.xml
      const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      let presHrefs = [...epText.matchAll(new RegExp(`href="(full_ifrs/linkbases/${escaped}/pre_[^"]+\\.xml)"`, 'g'))].map((m) => m[1]!)
      // Otherwise try the dimension presentations
      if (!presHrefs.length) presHrefs = [...epText.matchAll(/href="(full_ifrs\/dimensions\/pre_[^"]+\.xml)"/g)].map((m) => m[1]!)

      const allNodes: XBRLNode[] = []
      for (const href of presHrefs) {
        const fullUrl = new URL(href, epUrl).href
        try {
          const content = await this.client.fetchFile(fullUrl)
          allNodes.push(...this.parser.parsePresentation(content, TaxonomyStyle.FASB_STANDARD))
        } catch {
          continue
        }
      }
      if (allNodes.length) return allNodes
    }

    // Fallback: the flat element list of the core schema
    const coreUrl = await resolveIfrsUrl(this.ctx, year, `full_ifrs/full_ifrs-cor_${date}.xsd`)
    try {
      return this.parser.parseSchemaElements(await this.client.fetchFile(coreUrl))
    } catch (e) {
      throw new OpenBBError(`Failed to fetch IFRS core schema for ${year}: ${errMsg(e)}`)
    }
  }

  /** `get_structure`: the presentation structure of a taxonomy component. */
  async getStructure(taxonomy: string, year: number, component: string): Promise<XBRLNode[]> {
    const config = TAXONOMIES[taxonomy]
    if (!config) throw new Error(`Unsupported taxonomy: ${taxonomy}. Available: ${Object.keys(TAXONOMIES).sort().join(', ')}`)

    await this.ensureLabels(taxonomy, year)
    await this.ensureElementProperties(taxonomy, year)

    // FASB taxonomies reference elements from srt, dei, country and currency; load those labels and properties as well.
    if (config.style === TaxonomyStyle.FASB_STANDARD) {
      for (const dep of ['srt', 'dei', 'country', 'currency']) {
        if (dep in TAXONOMIES) {
          await this.ensureLabels(dep, year)
          await this.ensureElementProperties(dep, year)
        }
      }
    }

    // FRC dpl references elements from FRC core (core_* namespace)
    if (taxonomy === 'frc-dpl') await this.loadFrcCoreLabels(year)

    if (config.style === TaxonomyStyle.EXTERNAL && taxonomy === 'ifrs') return this.getIfrsStructure(year, component)
    if (config.style === TaxonomyStyle.EXTERNAL && FRC_TAXONOMIES.has(taxonomy)) return this.getFrcStructure(taxonomy, year)

    // --- The URL to fetch ---
    let fullUrl: string
    if (config.style === TaxonomyStyle.STATIC) {
      fullUrl = config.base_url_template + config.presentation_file_template
    } else if (config.style === TaxonomyStyle.FASB_STANDARD) {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      const stmUrl = `${baseUrl}stm/`
      // Progressively broader fragment sets handle the naming conventions of different years.
      const found = (await this.client.findFile(stmUrl, `${taxonomy}-stm-${component}-pre-`, String(year))) ?? (await this.client.findFile(stmUrl, component, '-pre-', String(year))) ?? (await this.client.findFile(stmUrl, component, 'pre', String(year)))
      if (!found) {
        const available = (await this.client.listFiles(stmUrl)).filter((f) => f.includes(component))
        throw new OpenBBError(`No presentation file found for ${taxonomy}/${year}/${component}. Available files in stm/: [${available.map((f) => `'${f}'`).join(', ')}]`)
      }
      fullUrl = found
    } else if (component === 'standard' && (config.style === TaxonomyStyle.SEC_EMBEDDED || config.style === TaxonomyStyle.SEC_STANDALONE)) {
      // "standard" SEC components: the *-entire-{year}.xsd holds (or imports) the full presentation hierarchy.
      try {
        const nodes = await this.parseEntireFile(taxonomy, year, config)
        if (nodes.length) return nodes
      } catch {
        // fall through to the main schema
      }
      // The main schema and a flat element list (reference taxonomies: country, currency, exch, …)
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      const found = (await this.client.findFile(baseUrl, `${taxonomy}-${year}`, '.xsd')) ?? (await this.client.findFile(baseUrl, taxonomy, String(year), '.xsd'))
      if (!found) throw new OpenBBError(`No schema file found for ${taxonomy}/${year} in listing.`)
      fullUrl = found
    } else {
      const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
      const found = (await this.client.findFile(baseUrl, `${taxonomy}-${component}-`, String(year))) ?? (await this.client.findFile(baseUrl, `${taxonomy}-${component}-pre-`, String(year))) ?? (await this.client.findFile(baseUrl, component, String(year)))
      if (!found) throw new OpenBBError(`No presentation file found for ${taxonomy}/${year}/${component}. Check available components with list_available_components().`)
      fullUrl = found
    }

    try {
      const content = await this.client.fetchFile(fullUrl)
      let nodes = this.parser.parsePresentation(content, config.style)

      // Flat element fallback for reference/enumeration taxonomies without a presentation linkbase.
      if (!nodes.length && (config.style === TaxonomyStyle.SEC_EMBEDDED || config.style === TaxonomyStyle.SEC_STANDALONE)) {
        if (fullUrl.endsWith('.xsd')) nodes = this.parser.parseSchemaElements(content)
        else {
          const baseUrl = config.base_url_template.replaceAll('{year}', String(year))
          const foundSchema = (await this.client.findFile(baseUrl, `${taxonomy}-${year}`, '.xsd')) ?? (await this.client.findFile(baseUrl, taxonomy, String(year), '.xsd'))
          if (foundSchema) nodes = this.parser.parseSchemaElements(await this.client.fetchFile(foundSchema))
        }
      }

      // Aggregation: an empty wrapper that only imports sub-schemas (sbs "sbsef") collects its child components.
      if (!nodes.length) {
        const allComps = await this.listAvailableComponents(taxonomy, year)
        const children = allComps.filter((c) => c !== component && c.startsWith(`${component}-`))
        for (const child of children) nodes.push(...(await this.getStructure(taxonomy, year, child)))
      }
      return nodes
    } catch (e) {
      throw new OpenBBError(`Failed to get structure for ${taxonomy} ${year} ${component}: ${errMsg(e)}`)
    }
  }

  /** `list_available_taxonomies`: every registered taxonomy with its metadata, optionally for one filer category. */
  listAvailableTaxonomies(category?: string | null): Record<string, { label: string; description: string; category: string; style: string; has_label_linkbase: string; sec_reference_url: string }> {
    let catFilter: string | null = null
    if (category !== undefined && category !== null) {
      const valid = Object.values(TaxonomyCategory) as string[]
      if (!valid.includes(category)) throw new Error(`Invalid category: '${category}'. Valid values: [${valid.map((v) => `'${v}'`).join(', ')}]`)
      catFilter = category
    }
    const result: Record<string, { label: string; description: string; category: string; style: string; has_label_linkbase: string; sec_reference_url: string }> = {}
    for (const [key, config] of Object.entries(TAXONOMIES)) {
      if (catFilter !== null && config.category !== catFilter) continue
      result[key] = { label: config.label, description: config.description, category: config.category, style: config.style, has_label_linkbase: config.has_label_linkbase ? 'True' : 'False', sec_reference_url: config.sec_reference_url }
    }
    return result
  }

  /** `list_available_components`. */
  async listAvailableComponents(taxonomy: string, year: number): Promise<string[]> {
    const config = TAXONOMIES[taxonomy]
    if (!config) return []
    return this.client.getComponentsForYear(year, config)
  }

  /** `get_available_years`. */
  async getAvailableYears(taxonomy: string): Promise<number[]> {
    const config = TAXONOMIES[taxonomy]
    if (!config) return []
    return this.client.getAvailableYears(taxonomy, config)
  }
}
