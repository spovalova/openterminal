// XBRL schema, linkbase and instance parsing, provider sec. Ported from openbb_sec/utils/xbrl_taxonomy_helper.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: documents are bytes (Python's BytesIO), parsed with ./xml-element.ts
// instead of ElementTree, and the filing downloads in `parseInstance` go through ctx.http and the SEC rate limit.
//
// API for the filing part (the Python names in camelCase; dict keys keep Python's snake_case; None is null):
//   new XBRLParser(labels?, ctx?)    parser.labels / documentation / element_properties / linkbase_errors
//   parseSchema(bytes)               → [elements, roles, embeddedLinkbase: XmlElement | null, imports]
//   parseSchemaElements(bytes)       → XBRLNode[] (flat)
//   parseLabelLinkbase(bytes, style) → { element_id: { role: text } }   (also fills labels / documentation)
//   parseReferenceLinkbase(bytes)    → number of citations added to documentation
//   loadSchemaElementProperties(bytes) → number loaded into element_properties
//   parsePresentation(bytes, style)  → XBRLNode[] (tree)           parseCalculation(bytes, style) → { child_id: {order, weight, parent_tag} }
//   async parseInstance(bytes, baseUrl?) → [contexts, units, facts]   (needs `ctx` when baseUrl is given)
//   getLabelUrlForImport(schemaLocation) → string | null,  TaxonomyStyle, TaxonomyCategory, XBRLNode, OpenBBError
// Errors surface as OpenBBError with Python's messages ("Failed to parse schema: …").
import { HEADERS, cachedRequest } from '../helpers.js'
import type { NativeCtx } from '../../types.js'
import { parseElementTree, XmlElement } from './xml-element.js'

/** `openbb_core.app.model.abstract.error.OpenBBError`. */
export class OpenBBError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenBBError'
  }
}

export const LINKBASE_FETCH_ATTEMPTS = 3
export const LINKBASE_RETRY_BACKOFF_S = 1.0

/** `NS`: constants for XBRL namespaces. */
export const NS: Readonly<Record<string, string>> = {
  link: 'http://www.xbrl.org/2003/linkbase',
  xlink: 'http://www.w3.org/1999/xlink',
  xbrli: 'http://www.xbrl.org/2003/instance',
  xs: 'http://www.w3.org/2001/XMLSchema',
  xsd: 'http://www.w3.org/2001/XMLSchema',
}

/** `XSD_NS`: additional namespaces for XSD parsing. */
export const XSD_NS: Readonly<Record<string, string>> = { ...NS, xsd: 'http://www.w3.org/2001/XMLSchema', xbrli: 'http://www.xbrl.org/2003/instance' }

/** `TaxonomyStyle`: how a taxonomy's labels and linkbases are laid out (the member names are the enum's names). */
export const TaxonomyStyle = {
  FASB_STANDARD: 'FASB_STANDARD',
  SEC_EMBEDDED: 'SEC_EMBEDDED',
  SEC_STANDALONE: 'SEC_STANDALONE',
  EXTERNAL: 'EXTERNAL',
  STATIC: 'STATIC',
} as const
export type TaxonomyStyle = (typeof TaxonomyStyle)[keyof typeof TaxonomyStyle]

/** `TaxonomyCategory`: the SEC filer category a taxonomy belongs to (the values). */
export const TaxonomyCategory = {
  OPERATING_COMPANY: 'operating_company',
  INVESTMENT_COMPANY: 'investment_company',
  SELF_REGULATORY_ORG: 'self_regulatory_org',
  SBS_REPOSITORY: 'sbs_repository',
  NRSRO: 'nrsro',
  COMMON_REFERENCE: 'common_reference',
} as const
export type TaxonomyCategory = (typeof TaxonomyCategory)[keyof typeof TaxonomyCategory]

/** `TAXONOMY_LABEL_URLS`: schema location pattern → the URL of its label linkbase. */
const TAXONOMY_LABEL_URLS: [string, (url: string) => string][] = [
  ['xbrl.fasb.org/us-gaap', (url) => url.replace('us-gaap-', 'us-gaap-lab-').replace('.xsd', '.xml')],
  ['xbrl.fasb.org/srt', (url) => url.replace('srt-', 'srt-lab-').replace('.xsd', '.xml')],
  ...['dei', 'country', 'currency', 'stpr', 'snj', 'exch', 'naics', 'sic', 'fnd'].map((t): [string, (url: string) => string] => [`xbrl.sec.gov/${t}`, (url) => url.replace('.xsd', '_lab.xsd')]),
]

/** `get_label_url_for_import`: the label linkbase of an imported schema, or null when it has no separate file. */
export function getLabelUrlForImport(schemaLocation: string): string | null {
  for (const [pattern, urlFunc] of TAXONOMY_LABEL_URLS) if (schemaLocation.includes(pattern)) return urlFunc(schemaLocation)
  return null
}

/** One line item in a presentation tree (`XBRLNode`); fields keep Python's names. */
export class XBRLNode {
  element_id: string
  label: string
  order: number
  level: number
  parent_id: string | null
  preferred_label: string | null
  documentation: string | null
  xbrl_type: string | null
  period_type: string | null
  balance_type: string | null
  abstract: boolean
  substitution_group: string | null
  nillable: boolean | null
  children: XBRLNode[]

  constructor(init: { element_id: string; label: string; order: number; level: number; parent_id: string | null } & Partial<Omit<XBRLNode, 'toDict'>>) {
    this.element_id = init.element_id
    this.label = init.label
    this.order = init.order
    this.level = init.level
    this.parent_id = init.parent_id
    this.preferred_label = init.preferred_label ?? null
    this.documentation = init.documentation ?? null
    this.xbrl_type = init.xbrl_type ?? null
    this.period_type = init.period_type ?? null
    this.balance_type = init.balance_type ?? null
    this.abstract = init.abstract ?? false
    this.substitution_group = init.substitution_group ?? null
    this.nillable = init.nillable ?? null
    this.children = init.children ?? []
  }

  /** `to_dict`: the node and its children as plain objects. */
  toDict(): Record<string, unknown> {
    return {
      element_id: this.element_id,
      label: this.label,
      documentation: this.documentation,
      order: this.order,
      level: this.level,
      preferred_label: this.preferred_label,
      xbrl_type: this.xbrl_type,
      period_type: this.period_type,
      balance_type: this.balance_type,
      abstract: this.abstract,
      substitution_group: this.substitution_group,
      nillable: this.nillable,
      children: this.children.map((c) => c.toDict()),
    }
  }
}

/** An `<xs:element>` as `parse_schema` returns it. */
export type SchemaElement = {
  name: string | null
  xbrl_type: string | null
  xsi_nil: string | null
  period_type: string | null
  balance_type: string | null
  abstract: boolean
  substitution_group: string | null
}

/** A role type from a schema's appinfo (`parse_schema`'s roles). */
export type SchemaRole = { name: string | null; short_name: string; document_number: string; group: string; sub_group: string | null; long_name: string }

export type SchemaImport = { namespace: string; schemaLocation: string }

/** `element_properties` entries. */
export type ElementProperties = {
  xbrl_type: string | null
  period_type: string | null
  balance_type: string | null
  abstract: boolean
  substitution_group: string | null
  nillable: boolean | null
}

export type InstanceContext = { entity?: string; period_type?: string; start?: string | null; end?: string | null; dimensions?: Record<string, string> }

export type PresentationEntry = { table: string; parent: string | null | undefined; order: number | null; preferred_label: string | null }

export type InstanceFact = {
  tag: string
  label: string
  documentation: string | null | undefined
  context_ref: string
  fact_id: string | null
  entity: string | null
  period_type: string | null
  start: string | null
  end: string | null
  unit: string | null
  decimals: string | null
  value: string | null
  dimensions?: Record<string, { member: string; label: string }>
  presentation?: PresentationEntry[]
}

const last = (s: string, sep: string): string => s.slice(s.lastIndexOf(sep) + 1)
const afterColon = (s: string): string => last(s, ':')

/** Python's `float(text)`: throws like `ValueError` on text that is not a number. */
export function pyFloat(text: string): number {
  const t = text.trim().replaceAll('_', '')
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t)
  const lower = t.toLowerCase()
  if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/.test(lower)) return NaN
  throw new Error(`could not convert string to float: '${text}'`)
}


/** Parses XML/XSD files into usable structures (`XBRLParser`). */
export class XBRLParser {
  labels: Record<string, string | null>
  documentation: Record<string, string | null> = {}
  element_properties: Record<string, ElementProperties> = {}
  linkbase_errors: Record<string, string> = {}

  /** `ctx` is only needed by `parseInstance` when it is given a `baseUrl` (it downloads the filing's linkbases). */
  constructor(
    labels?: Record<string, string | null>,
    private readonly ctx?: NativeCtx,
  ) {
    this.labels = labels ?? {}
  }

  private getXmlRoot(content: Uint8Array | string): XmlElement {
    return parseElementTree(content)
  }

  /** True for timeouts, connection errors, HTTP 429 and HTTP 5xx. */
  private static isTransientFetchError(exc: unknown): boolean {
    const status = (exc as { status?: unknown }).status
    if (typeof status === 'number') return status === 429 || status >= 500
    // fetch rejects with a TypeError on network failures and an AbortError / TimeoutError on timeouts
    return exc instanceof TypeError || (exc instanceof Error && (exc.name === 'AbortError' || exc.name === 'TimeoutError'))
  }

  /** `_fetch_filing_document`: download a filing document, retrying transient failures. */
  private async fetchFilingDocument(url: string): Promise<Uint8Array> {
    const ctx = this.ctx
    if (!ctx) throw new OpenBBError('XBRLParser needs a ctx to download filing documents')
    const get = () => cachedRequest(ctx, url, { kind: 'bytes', headers: HEADERS })
    for (let attempt = 0; attempt < LINKBASE_FETCH_ATTEMPTS - 1; attempt++) {
      try {
        return await get()
      } catch (exc) {
        if (!XBRLParser.isTransientFetchError(exc)) throw exc
        await ctx.sleep(LINKBASE_RETRY_BACKOFF_S * 2 ** attempt * 1000)
      }
    }
    return get()
  }

  /** `_load_filing_document`: download and parse a filing document; null (and a note in `linkbase_errors`) when unavailable. */
  private async loadFilingDocument(kind: string, url: string): Promise<XmlElement | null> {
    try {
      return this.getXmlRoot(await this.fetchFilingDocument(url))
    } catch (exc) {
      this.linkbase_errors[kind] = `${exc instanceof Error ? exc.name : 'Error'}: ${exc instanceof Error ? exc.message : String(exc)}`
      return null
    }
  }

  /** `_parse_order`: a presentation arc's `order`, null when missing or not numeric. */
  private static parseOrder(value: string | undefined): number | null {
    try {
      return value ? pyFloat(value) : null
    } catch {
      return null
    }
  }

  /** `parse_schema`: elements, role types, the embedded linkbase (if any) and imports of an .xsd. */
  parseSchema(fileContent: Uint8Array | string): [Record<string, SchemaElement>, SchemaRole[], XmlElement | null, SchemaImport[]] {
    try {
      const root = this.getXmlRoot(fileContent)
      const elements: Record<string, SchemaElement> = {}
      const roles: SchemaRole[] = []
      let embeddedLinkbase: XmlElement | null = null
      const imports: SchemaImport[] = []
      // "xsd" and "xs" are the same namespace, so there is a single URI to read.
      const xsd = XSD_NS.xsd!
      const link = NS.link!
      const xbrli = XSD_NS.xbrli!

      for (const imp of root.findall(`{${xsd}}import`)) {
        const namespace = imp.get('namespace', '')
        const schemaLocation = imp.get('schemaLocation', '')
        if (namespace && schemaLocation) imports.push({ namespace, schemaLocation })
      }

      for (const elem of root.findall(`.//{${xsd}}element`)) {
        const elemId = elem.get('id')
        if (!elemId) continue
        const elemType = elem.get('type', '')
        const subGroupRaw = elem.get('substitutionGroup', '')
        elements[elemId] = {
          name: elem.get('name') ?? null,
          xbrl_type: elemType ? afterColon(elemType) : null,
          xsi_nil: elem.get('nillable') ?? null,
          period_type: elem.get(`{${xbrli}}periodType`) ?? null,
          balance_type: elem.get(`{${xbrli}}balance`) ?? null,
          abstract: elem.get('abstract') === 'true',
          substitution_group: subGroupRaw ? afterColon(subGroupRaw) : null,
        }
      }

      // Role types from annotation/appinfo
      for (const roleType of root.findall(`.//{${xsd}}annotation/{${xsd}}appinfo/{${link}}roleType`)) {
        const roleId = roleType.get('id') ?? null
        const definitionElem = roleType.find(`{${link}}definition`)
        const definition = definitionElem !== null && definitionElem.text ? definitionElem.text : ''
        // "doc_num - type - subtype - name" or "doc_num - type - name"
        const parts = definition.split(' - ')
        if (parts.length >= 3) {
          roles.push({
            name: roleId,
            short_name: parts[parts.length - 1]!,
            document_number: parts[0]!,
            group: parts.length > 1 ? parts[1]!.toLowerCase() : '',
            sub_group: parts.length > 3 ? parts[2]! : null,
            long_name: definition,
          })
        }
      }
      embeddedLinkbase = root.findall(`.//{${xsd}}annotation/{${xsd}}appinfo/{${link}}linkbase`)[0] ?? null
      return [elements, roles, embeddedLinkbase, imports]
    } catch (e) {
      throw new OpenBBError(`Failed to parse schema: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** `parse_schema_elements`: the top-level elements of an .xsd as flat nodes (reference taxonomies without a presentation). */
  parseSchemaElements(fileContent: Uint8Array | string): XBRLNode[] {
    try {
      const root = this.getXmlRoot(fileContent)
      const nodes: XBRLNode[] = []
      let orderCounter = 1.0
      const xbrli = XSD_NS.xbrli!
      for (const prefix of ['xs', 'xsd']) {
        const nsUri = XSD_NS[prefix] ?? 'http://www.w3.org/2001/XMLSchema'
        for (const elem of root.findall(`{${nsUri}}element`)) {
          const elemId = elem.get('id', '')
          const elemName = elem.get('name', '')
          if (!elemName) continue
          const label = (elemId in this.labels ? this.labels[elemId] : elemName) || elemName
          const doc = this.documentation[elemId] ?? null
          const props: Partial<ElementProperties> = this.element_properties[elemId] ?? {}
          const elemType = elem.get('type', '')
          const subGroupRaw = elem.get('substitutionGroup', '')
          const nillableAttr = elem.get('nillable')
          nodes.push(
            new XBRLNode({
              element_id: elemId,
              label,
              order: orderCounter,
              level: 0,
              parent_id: null,
              preferred_label: null,
              documentation: doc,
              xbrl_type: props.xbrl_type || (elemType ? afterColon(elemType) : null),
              period_type: props.period_type || elem.get(`{${xbrli}}periodType`) || null,
              balance_type: props.balance_type || elem.get(`{${xbrli}}balance`) || null,
              abstract: 'abstract' in props ? props.abstract! : elem.get('abstract') === 'true',
              substitution_group: props.substitution_group || (subGroupRaw ? afterColon(subGroupRaw) : null),
              nillable: 'nillable' in props ? (props.nillable ?? null) : nillableAttr ? nillableAttr === 'true' : null,
              children: [],
            }),
          )
          orderCounter += 1.0
        }
        if (nodes.length) break // found elements with this prefix, skip the other
      }
      return nodes
    } catch (e) {
      throw new OpenBBError(`Failed to parse schema elements: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** The linkbase to read: the document itself, or for embedded taxonomies the one inside an .xsd's annotation. */
  private linkbaseRoot(root: XmlElement, style: TaxonomyStyle): XmlElement | null {
    if (style === TaxonomyStyle.SEC_EMBEDDED && root.tag.endsWith('schema')) return root.findall('.//link:linkbase', NS)[0] ?? null
    return root
  }

  /** `parse_label_linkbase`: fills `labels` and `documentation`; returns element_id → { role: text }. */
  parseLabelLinkbase(fileContent: Uint8Array | string, style: TaxonomyStyle): Record<string, Record<string, string | null>> {
    try {
      const root = this.getXmlRoot(fileContent)
      const targetRoot = this.linkbaseRoot(root, style)
      if (targetRoot === null) return {} // "No embedded linkbase found in XSD labels."
      const xlink = NS.xlink!

      const locMap = new Map<string | undefined, string>()
      for (const loc of targetRoot.findall('.//link:loc', NS)) {
        const href = loc.get(`{${xlink}}href`)
        const labelKey = loc.get(`{${xlink}}label`)
        if (href && href.includes('#')) locMap.set(labelKey, href.split('#')[1]!)
      }

      const xmlLang = '{http://www.w3.org/XML/1998/namespace}lang'
      const resourceMap = new Map<string | undefined, Record<string, string | null>>()
      for (const res of targetRoot.findall('.//link:label', NS)) {
        // English-only: skip non-English label resources; resources with no xml:lang are kept.
        const lang = res.get(xmlLang)
        if (lang && !lang.toLowerCase().startsWith('en')) continue
        const role = res.get(`{${xlink}}role`)
        const roleShort = role ? last(role, '/') : 'label'
        const labelKey = res.get(`{${xlink}}label`)
        if (!resourceMap.has(labelKey)) resourceMap.set(labelKey, {})
        resourceMap.get(labelKey)![roleShort] = res.text
      }

      const newLabels: Record<string, Record<string, string | null>> = {}
      for (const arc of targetRoot.findall('.//link:labelArc', NS)) {
        const fromLoc = arc.get(`{${xlink}}from`)
        const toLabel = arc.get(`{${xlink}}to`)
        if (locMap.has(fromLoc) && resourceMap.has(toLabel)) {
          const elementId = locMap.get(fromLoc)!
          const labelData = resourceMap.get(toLabel)!
          const values = Object.values(labelData)
          if ('label' in labelData) this.labels[elementId] = labelData.label!
          else if (!('documentation' in labelData) && values.length) this.labels[elementId] = values[0]!
          if ('documentation' in labelData) this.documentation[elementId] = labelData.documentation!
          newLabels[elementId] = { ...(newLabels[elementId] ?? {}), ...labelData }
        }
      }
      return newLabels
    } catch (e) {
      throw new OpenBBError(`Failed to parse label linkbase: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** `parse_reference_linkbase`: regulatory citations as fallback documentation; returns how many elements got one. */
  parseReferenceLinkbase(fileContent: Uint8Array | string): number {
    try {
      const root = this.getXmlRoot(fileContent)
      const link = NS.link!
      const xlink = NS.xlink!
      const refLinks = root.iter(`{${link}}referenceLink`)
      if (!refLinks.length) return 0

      const locMap = new Map<string, string>()
      for (const refLink of refLinks) {
        for (const loc of refLink.findall('link:loc', NS)) {
          const labelKey = loc.get(`{${xlink}}label`, '')
          const href = loc.get(`{${xlink}}href`, '')
          if (href && href.includes('#')) locMap.set(labelKey, href.split('#')[1]!)
        }
      }

      const resourceMap = new Map<string, Record<string, string>[]>()
      for (const refLink of refLinks) {
        for (const ref of refLink.findall('link:reference', NS)) {
          const labelKey = ref.get(`{${xlink}}label`, '')
          const parts: Record<string, string> = {}
          for (const child of ref) {
            const tag = child.tag.includes('}') ? last(child.tag, '}') : child.tag
            if (child.text) parts[tag] = child.text.trim()
          }
          if (Object.keys(parts).length) resourceMap.set(labelKey, [...(resourceMap.get(labelKey) ?? []), parts])
        }
      }

      const elemRefs = new Map<string, Record<string, string>[]>()
      for (const refLink of refLinks) {
        for (const arc of refLink.findall('link:referenceArc', NS)) {
          const fromLoc = arc.get(`{${xlink}}from`, '')
          const toRef = arc.get(`{${xlink}}to`, '')
          const elementId = locMap.get(fromLoc)
          const refPartsList = resourceMap.get(toRef) ?? []
          if (elementId && refPartsList.length) elemRefs.set(elementId, [...(elemRefs.get(elementId) ?? []), ...refPartsList])
        }
      }

      let count = 0
      for (const [elementId, refs] of elemRefs) {
        if (elementId in this.documentation) continue // don't overwrite real documentation
        const citations: string[] = []
        for (const parts of refs) {
          const name = parts.Name ?? ''
          const section = parts.Section ?? ''
          if (!name) continue
          let cite = name
          if (section) cite += ` §${section}`
          const suffixParts = [parts.Subsection ?? '', parts.Paragraph ?? '', parts.Subparagraph ?? ''].filter(Boolean)
          if (suffixParts.length) cite += `(${suffixParts.join(')(')})`
          citations.push(cite)
        }
        if (citations.length) {
          const unique = [...new Set(citations)]
          this.documentation[elementId] = `Ref: ${unique.join('; ')}`
          count += 1
        }
      }
      return count
    } catch {
      return 0
    }
  }

  /** `load_schema_element_properties`: type, period type, balance, abstract, substitution group and nillable of every element. */
  loadSchemaElementProperties(fileContent: Uint8Array | string): number {
    try {
      const root = this.getXmlRoot(fileContent)
      const xbrli = XSD_NS.xbrli!
      let count = 0
      for (const elem of root.findall(`.//{${XSD_NS.xsd!}}element`)) {
        const elemId = elem.get('id')
        if (!elemId || elemId in this.element_properties) continue
        const elemType = elem.get('type', '')
        const subGroupRaw = elem.get('substitutionGroup', '')
        const nillableRaw = elem.get('nillable')
        this.element_properties[elemId] = {
          xbrl_type: elemType ? afterColon(elemType) : null,
          period_type: elem.get(`{${xbrli}}periodType`) ?? null,
          balance_type: elem.get(`{${xbrli}}balance`) ?? null,
          abstract: elem.get('abstract') === 'true',
          substitution_group: subGroupRaw ? afterColon(subGroupRaw) : null,
          nillable: nillableRaw !== undefined ? nillableRaw === 'true' : null,
        }
        count += 1
      }
      return count
    } catch {
      return 0
    }
  }

  /** `parse_presentation`: a presentation linkbase as a tree of nodes. */
  parsePresentation(fileContent: Uint8Array | string, style: TaxonomyStyle): XBRLNode[] {
    try {
      const root = this.getXmlRoot(fileContent)
      const targetRoot = this.linkbaseRoot(root, style)
      if (targetRoot === null) return [] // "No embedded linkbase found in XSD presentation."
      const xlink = NS.xlink!

      const locMap = new Map<string | undefined, string>()
      for (const loc of targetRoot.findall('.//link:loc', NS)) {
        const href = loc.get(`{${xlink}}href`)
        const label = loc.get(`{${xlink}}label`)
        // SEC locators often point to local files ("dei-2024.xsd#element"); only the fragment matters.
        if (href && href.includes('#')) locMap.set(label, href.split('#')[1]!)
      }

      const relationships: { parent: string; child: string; order: number; preferred_label: string | undefined }[] = []
      for (const arc of targetRoot.findall('.//link:presentationArc', NS)) {
        const parentLoc = arc.get(`{${xlink}}from`)
        const childLoc = arc.get(`{${xlink}}to`)
        const order = pyFloat(arc.get('order', '1.0'))
        const preferredLabel = arc.get('preferredLabel')
        if (locMap.has(parentLoc) && locMap.has(childLoc)) relationships.push({ parent: locMap.get(parentLoc)!, child: locMap.get(childLoc)!, order, preferred_label: preferredLabel })
      }

      // Roots are parents that are nobody's child. Python takes a set difference (an arbitrary order); this keeps
      // the order in which the parents first appear.
      const allChildren = new Set(relationships.map((r) => r.child))
      const roots = [...new Set(relationships.map((r) => r.parent))].filter((p) => !allChildren.has(p))

      const buildNode = (elementId: string, level = 0, parentId: string | null = null, preferredLabel: string | null = null): XBRLNode => {
        const label = this.labels[elementId] || elementId
        const doc = this.documentation[elementId] ?? null
        const props: Partial<ElementProperties> = this.element_properties[elementId] ?? {}
        const node = new XBRLNode({
          element_id: elementId,
          label,
          order: 0,
          level,
          parent_id: parentId,
          preferred_label: preferredLabel,
          documentation: doc,
          xbrl_type: props.xbrl_type ?? null,
          period_type: props.period_type ?? null,
          balance_type: props.balance_type ?? null,
          abstract: props.abstract ?? false,
          substitution_group: props.substitution_group ?? null,
          nillable: props.nillable ?? null,
          children: [],
        })
        // stable sort by order (NaN orders go last, as Python's float('inf') key would)
        const mine = relationships.filter((r) => r.parent === elementId)
        const key = (r: { order: number }): number => (Number.isNaN(r.order) ? Infinity : r.order)
        mine.sort((a, b) => key(a) - key(b) || 0)
        for (const rel of mine) {
          const child = buildNode(rel.child, level + 1, elementId, rel.preferred_label ?? null)
          child.order = rel.order
          node.children.push(child)
        }
        return node
      }
      return roots.map((r) => buildNode(r))
    } catch (e) {
      throw new OpenBBError(`Failed to parse presentation linkbase: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** `parse_calculation`: child element_id → { order, weight, parent_tag } from a calculation linkbase. */
  parseCalculation(fileContent: Uint8Array | string, style: TaxonomyStyle): Record<string, { order: number; weight: number; parent_tag: string }> {
    try {
      const root = this.getXmlRoot(fileContent)
      const targetRoot = this.linkbaseRoot(root, style)
      if (targetRoot === null) return {} // "No embedded linkbase found in XSD calculation."
      const xlink = NS.xlink!

      const locMap = new Map<string | undefined, string>()
      for (const loc of targetRoot.findall('.//link:loc', NS)) {
        const href = loc.get(`{${xlink}}href`)
        const label = loc.get(`{${xlink}}label`)
        if (href && href.includes('#')) locMap.set(label, href.split('#')[1]!)
      }

      const calculations: Record<string, { order: number; weight: number; parent_tag: string }> = {}
      for (const calcLink of targetRoot.findall('.//link:calculationLink', NS)) {
        for (const arc of calcLink.findall('link:calculationArc', NS)) {
          const parentLoc = arc.get(`{${xlink}}from`)
          const childLoc = arc.get(`{${xlink}}to`)
          const order = pyFloat(arc.get('order', '1.0'))
          const weight = pyFloat(arc.get('weight', '1'))
          if (locMap.has(parentLoc) && locMap.has(childLoc)) calculations[locMap.get(childLoc)!] = { order, weight, parent_tag: locMap.get(parentLoc)! }
        }
      }
      return calculations
    } catch (e) {
      throw new OpenBBError(`Failed to parse calculation linkbase: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** `_build_ns_prefix_map`: namespace URI → prefix from the xmlns declarations in the first 10,000 bytes. */
  static buildNsPrefixMap(rawContent: Uint8Array): Record<string, string> {
    const header = Buffer.from(rawContent.subarray(0, 10000)).toString('utf8')
    const nsMap: Record<string, string> = {}
    for (const m of header.matchAll(/xmlns:([\w-]+)=["']([^"']+)["']/g)) nsMap[m[2]!] = m[1]!
    return nsMap
  }

  /** `_resolve_ns_prefix`: the prefix of a namespace URI (declared, well known, or the URI's semantic segment). */
  static resolveNsPrefix(nsUri: string, nsPrefixMap: Record<string, string>): string {
    if (nsUri in nsPrefixMap) return nsPrefixMap[nsUri]!
    if (nsUri.includes('us-gaap')) return 'us-gaap'
    if (nsUri.includes('xbrl.sec.gov/dei')) return 'dei'
    if (nsUri.includes('fasb.org/srt')) return 'srt'
    // For URIs like http://xbrl.sec.gov/ecd/2024 take the segment before the trailing year or date.
    const parts = nsUri.replace(/\/+$/, '').split('/')
    for (const part of [...parts].reverse()) if (!/^\d{4}(-?\d{2}(-?\d{2})?)?$/.test(part)) return part
    return parts.length ? parts[parts.length - 1]! : 'unknown'
  }

  /** `_resolve_measure`: an XBRL measure without its namespace noise. */
  static resolveMeasure(measureText: string): string {
    if (!measureText) return ''
    const text = measureText.trim()
    if (text.startsWith('iso4217:')) return text
    if (text === 'xbrli:shares' || text === 'shares') return 'shares'
    if (text === 'xbrli:pure' || text === 'pure') return 'pure'
    return text
  }

  /** `_parse_units`: unit id → "iso4217:USD", "shares", "pure" or "num / den" for divides. */
  parseUnits(root: XmlElement): Record<string, string> {
    const xbrli = 'http://www.xbrl.org/2003/instance'
    const units: Record<string, string> = {}
    for (const unitElem of root.findall(`.//{${xbrli}}unit`)) {
      const unitId = unitElem.get('id')
      if (!unitId) continue
      const measure = unitElem.find(`{${xbrli}}measure`)
      if (measure !== null && measure.text) {
        units[unitId] = XBRLParser.resolveMeasure(measure.text)
        continue
      }
      const divide = unitElem.find(`{${xbrli}}divide`)
      if (divide !== null) {
        const numerator = divide.find(`{${xbrli}}unitNumerator`)
        const denominator = divide.find(`{${xbrli}}unitDenominator`)
        const numMeasures: string[] = []
        const denMeasures: string[] = []
        if (numerator !== null) for (const m of numerator.findall(`{${xbrli}}measure`)) if (m.text) numMeasures.push(XBRLParser.resolveMeasure(m.text))
        if (denominator !== null) for (const m of denominator.findall(`{${xbrli}}measure`)) if (m.text) denMeasures.push(XBRLParser.resolveMeasure(m.text))
        const numStr = numMeasures.length ? numMeasures.join(' * ') : '?'
        const denStr = denMeasures.length ? denMeasures.join(' * ') : '?'
        units[unitId] = `${numStr} / ${denStr}`
        continue
      }
      units[unitId] = unitId
    }
    return units
  }

  /**
   * `_parse_filing_labels`: follow the instance's schemaRef → company schema → linkbaseRef chain and read the filing's label
   * and presentation linkbases. Returns [labels_map: element_id → { role: text }, presentation_map: element_id → entries].
   */
  async parseFilingLabels(root: XmlElement, baseUrl: string): Promise<[Record<string, Record<string, string>>, Record<string, PresentationEntry[]>]> {
    const linkNs = 'http://www.xbrl.org/2003/linkbase'
    const xlinkNs = 'http://www.w3.org/1999/xlink'
    const labelsMap: Record<string, Record<string, string>> = {}
    const presentationMap: Record<string, PresentationEntry[]> = {}
    let schemaHref: string | undefined

    for (const ref of root.findall(`.//{${linkNs}}schemaRef`)) {
      schemaHref = ref.get(`{${xlinkNs}}href`)
      if (schemaHref) break
    }
    if (!schemaHref) return [labelsMap, presentationMap]

    const schemaUrl = schemaHref.startsWith('http') ? schemaHref : new URL(schemaHref, baseUrl).href
    const schemaRoot = await this.loadFilingDocument('schema', schemaUrl)
    if (schemaRoot === null) return [labelsMap, presentationMap]

    let labelUrl: string | null = null
    let preUrl: string | null = null
    for (const ref of schemaRoot.findall(`.//{${linkNs}}linkbaseRef`)) {
      const role = ref.get(`{${xlinkNs}}role`, '')
      const href = ref.get(`{${xlinkNs}}href`, '')
      if (!href) continue
      const fullUrl = href.startsWith('http') ? href : new URL(href, schemaUrl).href
      if (role.includes('labelLinkbaseRef') || role.includes('labelLinkbase')) labelUrl = fullUrl
      else if (role.includes('presentationLinkbaseRef') || role.includes('presentationLinkbase')) preUrl = fullUrl
    }

    const labRoot = labelUrl ? await this.loadFilingDocument('label', labelUrl) : null
    if (labRoot !== null) {
      const locMap = new Map<string, string>()
      for (const loc of labRoot.findall(`.//{${linkNs}}loc`)) {
        const href = loc.get(`{${xlinkNs}}href`, '')
        const locLabel = loc.get(`{${xlinkNs}}label`, '')
        if (href && href.includes('#')) locMap.set(locLabel, href.split('#')[1]!)
      }
      const resourceMap = new Map<string, Record<string, string>>()
      for (const res of labRoot.findall(`.//{${linkNs}}label`)) {
        const role = res.get(`{${xlinkNs}}role`, '')
        const roleShort = role ? last(role, '/') : 'label'
        const resLabel = res.get(`{${xlinkNs}}label`, '')
        if (!resourceMap.has(resLabel)) resourceMap.set(resLabel, {})
        resourceMap.get(resLabel)![roleShort] = res.text ?? ''
      }
      for (const arc of labRoot.findall(`.//{${linkNs}}labelArc`)) {
        const fromLoc = arc.get(`{${xlinkNs}}from`, '')
        const toLabel = arc.get(`{${xlinkNs}}to`, '')
        if (locMap.has(fromLoc) && resourceMap.has(toLabel)) {
          const elemId = locMap.get(fromLoc)!
          labelsMap[elemId] = { ...(labelsMap[elemId] ?? {}), ...resourceMap.get(toLabel)! }
        }
      }
    }

    const preRoot = preUrl ? await this.loadFilingDocument('presentation', preUrl) : null
    if (preRoot !== null) {
      for (const plink of preRoot.findall(`.//{${linkNs}}presentationLink`)) {
        const role = plink.get(`{${xlinkNs}}role`, '')
        const roleShort = role ? last(role, '/') : ''
        const preLocMap = new Map<string, string>()
        for (const loc of plink.findall(`{${linkNs}}loc`)) {
          const href = loc.get(`{${xlinkNs}}href`, '')
          const locLabel = loc.get(`{${xlinkNs}}label`, '')
          if (href && href.includes('#')) preLocMap.set(locLabel, href.split('#')[1]!)
        }
        for (const arc of plink.findall(`{${linkNs}}presentationArc`)) {
          const childId = preLocMap.get(arc.get(`{${xlinkNs}}to`, ''))
          if (childId !== undefined) {
            const pref = arc.get('preferredLabel', '')
            const entry: PresentationEntry = {
              table: roleShort,
              parent: preLocMap.get(arc.get(`{${xlinkNs}}from`, '')),
              order: XBRLParser.parseOrder(arc.get('order')),
              preferred_label: pref ? last(pref, '/') : null,
            }
            ;(presentationMap[childId] ??= []).push(entry)
          }
        }
      }
    }
    return [labelsMap, presentationMap]
  }

  /**
   * `parse_instance`: contexts, units and facts of an XBRL instance document. With `baseUrl` (the filing directory, ending
   * with "/") the filing's label and presentation linkbases are downloaded to label every fact (needs the parser's ctx).
   */
  async parseInstance(
    fileContent: Uint8Array | string,
    baseUrl?: string | null,
  ): Promise<[Record<string, InstanceContext>, Record<string, string>, Record<string, InstanceFact[]>]> {
    try {
      const root = this.getXmlRoot(fileContent)
      const xbrliNs = 'http://www.xbrl.org/2003/instance'
      const xbrldiNs = 'http://xbrl.org/2006/xbrldi'

      // Namespace prefixes from the xmlns declarations, for accurate tag normalisation (extensions, ecd, country, …).
      const bytes = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf8') : fileContent
      const nsPrefixMap = XBRLParser.buildNsPrefixMap(bytes)

      const contexts: Record<string, InstanceContext> = {}
      const facts: Record<string, InstanceFact[]> = {}
      const units = this.parseUnits(root)

      let labelsMap: Record<string, Record<string, string>> = {}
      let presentationMap: Record<string, PresentationEntry[]> = {}
      if (baseUrl !== undefined && baseUrl !== null) [labelsMap, presentationMap] = await this.parseFilingLabels(root, baseUrl)

      for (const context of root.findall(`.//{${xbrliNs}}context`)) {
        const contextId = context.get('id')
        if (!contextId) continue
        const ctxData: InstanceContext = {}

        const entity = context.find(`{${xbrliNs}}entity`)
        if (entity !== null) {
          const identifier = entity.find(`{${xbrliNs}}identifier`)
          if (identifier !== null && identifier.text) ctxData.entity = identifier.text.trim()
        }

        const period = context.find(`{${xbrliNs}}period`)
        if (period !== null) {
          const instant = period.find(`{${xbrliNs}}instant`)
          const startDate = period.find(`{${xbrliNs}}startDate`)
          const endDate = period.find(`{${xbrliNs}}endDate`)
          const forever = period.find(`{${xbrliNs}}forever`)
          if (instant !== null) {
            ctxData.period_type = 'instant'
            ctxData.start = null
            ctxData.end = instant.text
          } else if (forever !== null) {
            ctxData.period_type = 'forever'
            ctxData.start = null
            ctxData.end = null
          } else {
            ctxData.period_type = 'duration'
            ctxData.start = startDate !== null ? startDate.text : null
            ctxData.end = endDate !== null ? endDate.text : null
          }
        }

        // Dimensions from the segment (most common) or the scenario.
        const dimensions: Record<string, string> = {}
        const segment = entity !== null ? entity.find(`{${xbrliNs}}segment`) : null
        const scenario = context.find(`{${xbrliNs}}scenario`)
        for (const container of [segment, scenario]) {
          if (container === null) continue
          for (const explicit of container.findall(`{${xbrldiNs}}explicitMember`)) {
            const dim = explicit.get('dimension', '')
            const val = (explicit.text ?? '').trim()
            if (dim && val) dimensions[dim] = val
          }
          for (const typed of container.findall(`{${xbrldiNs}}typedMember`)) {
            const dim = typed.get('dimension', '')
            if (dim) {
              for (const child of typed) {
                const childTag = child.tag.includes('}') ? last(child.tag, '}') : child.tag
                dimensions[dim] = child.text ? `${childTag}:${child.text}` : childTag
              }
            }
          }
        }
        if (Object.keys(dimensions).length) ctxData.dimensions = dimensions
        contexts[contextId] = ctxData
      }

      for (const elem of root.iter()) {
        const contextRef = elem.get('contextRef')
        if (contextRef === undefined) continue

        let tag = elem.tag
        if (tag.includes('}')) {
          const close = tag.lastIndexOf('}')
          const ns = tag.slice(1, close)
          const local = tag.slice(close + 1)
          tag = `${XBRLParser.resolveNsPrefix(ns, nsPrefixMap)}_${local}`
        } else tag = tag.replaceAll(':', '_')

        const unitRef = elem.get('unitRef')
        const resolvedUnit = unitRef ? (units[unitRef] ?? unitRef) : null
        const ctx = contexts[contextRef] ?? {}

        const elemLabels = labelsMap[tag] ?? {}
        const label = elemLabels.label || tag
        const documentation = elemLabels.documentation
        const presEntries = presentationMap[tag]

        const factData: InstanceFact = {
          tag,
          label,
          documentation,
          context_ref: contextRef,
          fact_id: elem.get('id') ?? null,
          entity: ctx.entity ?? null,
          period_type: ctx.period_type ?? null,
          start: ctx.start ?? null,
          end: ctx.end ?? null,
          unit: resolvedUnit,
          decimals: elem.get('decimals') ?? null,
          value: elem.text,
        }

        const dims = ctx.dimensions
        if (dims && Object.keys(dims).length) {
          const resolvedDims: Record<string, { member: string; label: string }> = {}
          for (const [axis, member] of Object.entries(dims)) {
            const memberKey = member.replaceAll(':', '_')
            const memberLabels = labelsMap[memberKey] ?? {}
            resolvedDims[axis] = { member, label: memberLabels.label ?? member }
          }
          factData.dimensions = resolvedDims
        }
        if (presEntries?.length) factData.presentation = presEntries
        ;(facts[tag] ??= []).push(factData)
      }
      return [contexts, units, facts]
    } catch (e) {
      throw new OpenBBError(`Failed to parse instance document: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
