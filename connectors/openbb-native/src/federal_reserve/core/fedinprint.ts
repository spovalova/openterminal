// federal_reserve/{boston,chicago,ny,stl}/publications and publication_series, provider federal_reserve. Ported from
// openbb_federal_reserve/utils/fedinprint.py and the models/regional/*_publications.py and *_publication_series.py
// models (OpenBB Platform 5.0.0, Apache-2.0); modified: plain fetches instead of curl_cffi sessions (Fed in Print
// answers them), ctx.cache instead of the on-disk cache, the district registry trimmed to the districts ported here.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import districtsJson from './assets/fedinprint-districts.json' with { type: 'json' }
import { cmp, DAY_MS, EmptyDataError, request, str, unescapeHtml } from './helpers.js'

const BASE = 'https://fedinprint.org'
const SEARCH_URL = `${BASE}/search`
const PAGE_SIZE = 10
const RESOLVE_TTL_MS = 30 * DAY_MS

type District = { provider: string; series: [string, string][] }
const REGISTRY = districtsJson as unknown as Record<string, District>

/** St. Louis keeps its own series list (utils/st_louis.py `ST_LOUIS_SERIES`) rather than the registry's. */
const ST_LOUIS: District = {
  provider: 'Federal Reserve Bank of St. Louis',
  series: [
    ['working_papers', 'Working Papers'],
    ['review', 'Review'],
    ['speech', 'Speech'],
    ['economic_synopses', 'Economic Synopses'],
    ['national_economic_trends', 'National Economic Trends'],
    ['page_one_economics', 'Page One Economics Newsletter'],
    ['burgundy_books', 'Burgundy Books'],
    ['bridges', 'Bridges'],
    ['monetary_trends', 'Monetary Trends'],
    ['proceedings', 'Proceedings'],
    ['community_development', 'Community Development Publications and Reports'],
    ['central_banker', 'Central Banker'],
    ['regional_economic_development', 'Regional Economic Development'],
    ['inside_the_vault', 'Inside the Vault'],
    ['annual_report', 'Annual Report'],
    ['international_economic_trends', 'International Economic Trends'],
    ['liber8', 'Liber8 Economic Information Newsletter'],
    ['in_the_balance', 'In the Balance'],
    ['economic_equity_insights', 'Economic Equity Insights'],
    ['quarterly_debt_monitor', 'Quarterly Debt Monitor'],
    ['demographics_of_wealth', 'Demographics of Wealth'],
  ],
}

const PDF_META = /citation_pdf_url"\s*content="([^"]+)"/
const FILE_HREF = /File\(s\).*?href="([^"]+)"/s
const BLOCK = /search-result-detail">\s*<p>(.*?)<\/p>/gs
const TYPE = /content-type">\s*(\S.*?)\s*<\/span>/s
const LINK = /href="(\/item\/[^"]+)"\s+class="title">\s*(.*?)\s*<\/a>/s
const META = /class="meta">\s*(.*?)\s*(?:,|<br|<\/span>)/s
const BYLINE = /class="byline">(.*?)<\/span>/s
const DATE = /\((\d{4})(?:-(\d{2})(?:-(\d{2}))?)?\)/
const FACET_COUNT = /data-facet-value="hasparentname_literal_array:([^"]+)".*?<span class="text-muted">\s*([\d,]+)&nbsp;items/gs
const CMS_HOST = /^(https?:\/\/)([a-z0-9-]+)cm\.ws\.frb\.org/

type Fetch = (url: string) => Promise<string>
type Candidate = { series: string; date: string; title: string; url: string }

const cleanLabel = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** A search URL sorted newest first at an offset (`urlencode`: spaces as +). */
function searchUrl(facets: string[], start: number): string {
  const q = new URLSearchParams()
  for (const f of facets) q.append('facets[]', f)
  q.append('sort', 'sort_date_text desc')
  q.append('start', String(start))
  return `${SEARCH_URL}?${q.toString()}`
}

function getter(ctx: NativeCtx): Fetch {
  return (url) => ctx.http.text(url, request({ timeoutMs: 180_000 }))
}

/** A search-result block as a candidate record; blocks without a content type are web-only items and are skipped. */
function parseBlock(block: string, series: string): Candidate | undefined {
  if (!TYPE.test(block)) return undefined
  const link = LINK.exec(block)
  if (!link) return undefined
  const title = unescapeHtml(link[2]!.replace(/\s+/g, ' ').trim())
  const meta = META.exec(block)
  const parsedSeries = meta ? cleanLabel(unescapeHtml(meta[1]!)) : ''
  const byline = BYLINE.exec(block)
  let published = ''
  if (byline) {
    const stamp = DATE.exec(byline[1]!)
    if (stamp) published = `${stamp[1]}-${stamp[2] ?? '01'}-${stamp[3] ?? '01'}`
  }
  return { series: series || parsedSeries, date: published, title, url: `${BASE}${link[1]}` }
}

/** One page of a Reserve Bank's publications from the search result pages, newest first (the item pages are not fetched). */
async function search(provider: string, get: Fetch, seriesFacet: string | undefined, minYear: string, start: number, limit: number): Promise<Candidate[]> {
  const facets = [`provider_literal_array:${provider}`]
  if (seriesFacet) facets.push(`hasparentname_literal_array:${seriesFacet}`)
  const label = seriesFacet ? cleanLabel(seriesFacet) : ''
  const pagesNeeded = Math.ceil(limit / PAGE_SIZE) + 1
  const offsets = Array.from({ length: pagesNeeded }, (_, i) => start + i * PAGE_SIZE)
  const pages = await Promise.all(offsets.map((o) => get(searchUrl(facets, o))))

  const seen = new Set<string>()
  const records: Candidate[] = []
  let stop = false
  for (const page of pages) {
    if (stop) break
    for (const m of page.matchAll(BLOCK)) {
      const record = parseBlock(m[1]!, label)
      if (!record) continue
      if (minYear && record.date && record.date.slice(0, 4) < minYear) {
        stop = true
        break
      }
      if (seen.has(record.url)) continue
      seen.add(record.url)
      records.push(record)
      if (records.length >= limit) {
        stop = true
        break
      }
    }
  }
  records.sort((a, b) => cmp(b.date || '', a.date || '') || cmp(b.title, a.title))
  return records.slice(0, limit)
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isFile(url: string): boolean {
  const low = url.toLowerCase()
  const h = host(url)
  return low.endsWith('.pdf') || h === 'doi.org' || h.endsWith('.doi.org') || low.includes('/files/')
}

function firstFileLink(page: string): string {
  const meta = PDF_META.exec(page)
  if (meta) return unescapeHtml(meta[1]!)
  const href = FILE_HREF.exec(page)
  return href ? unescapeHtml(href[1]!) : ''
}

/** An item page resolved to its direct document URL, or undefined. */
async function resolveFile(itemUrl: string, get: Fetch): Promise<string | undefined> {
  let link = firstFileLink(await get(itemUrl))
  if (!link) return undefined
  if (host(link) === 'fraser.stlouisfed.org' && !link.includes('/files/')) {
    const inner = firstFileLink(await get(link))
    if (inner) link = inner
  }
  return isFile(link) ? link.replace(CMS_HOST, '$1www.$2.org') : undefined
}

/** `_safe_resolve`: a resolved mapping is cached for 30 days; a failure or a page without a file is not. */
async function safeResolve(ctx: NativeCtx, url: string): Promise<string | undefined> {
  try {
    return await ctx.cache(`fed:fedinprint:resolve:${url}`, RESOLVE_TTL_MS, async () => {
      const resolved = await resolveFile(url, getter(ctx))
      if (!resolved) throw new Error('no file')
      return resolved
    })
  } catch {
    return undefined
  }
}

/** Resolve item URLs to documents newest first, in chunks of 10, until `limit` documents are found. */
async function resolveRecords(ctx: NativeCtx, records: Candidate[], limit: number, workers = 10): Promise<Candidate[]> {
  const viewable: Candidate[] = []
  for (let index = 0; index < records.length && viewable.length < limit; index += workers) {
    const chunk = records.slice(index, index + workers)
    const targets = await Promise.all(chunk.map((r) => safeResolve(ctx, r.url)))
    chunk.forEach((r, i) => {
      if (targets[i]) viewable.push({ ...r, url: targets[i]! })
    })
  }
  return viewable.slice(0, limit)
}

function registry(district: string): District {
  const d = district === 'stl' ? ST_LOUIS : REGISTRY[district]
  if (!d) throw new Error(`unknown district ${district}`)
  return d
}

async function listPublications(ctx: NativeCtx, district: string, series: string | undefined, startDate: string | undefined, start: number, limit: number): Promise<Candidate[]> {
  const reg = registry(district)
  const facets = new Map(reg.series)
  const slug = series && facets.has(series) ? series : undefined
  const minYear = startDate ? startDate.slice(0, 4) : ''
  const facet = slug ? facets.get(slug) : reg.series[0]?.[1]
  if (facet === undefined) return []
  const need = start + limit
  const candidates = await search(reg.provider, getter(ctx), facet, minYear, 0, need * 2 + PAGE_SIZE)
  return (await resolveRecords(ctx, candidates, need)).slice(start)
}

async function listSeries(ctx: NativeCtx, district: string): Promise<Row[]> {
  const reg = registry(district)
  const page = await getter(ctx)(searchUrl([`provider_literal_array:${reg.provider}`], 0))
  const counts = new Map<string, number>()
  for (const m of page.matchAll(FACET_COUNT)) counts.set(cleanLabel(m[1]!), Number(m[2]!.replace(/,/g, '')))
  return reg.series.map(([slug, facet]) => ({ series: slug, name: cleanLabel(facet), count: counts.get(cleanLabel(facet)) ?? 0 }))
}

/** `<district>/publications`: the Fed in Print catalog for one Reserve Bank. */
export function publicationsHandler(district: string): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx) => {
    const start = str(params, 'start_date')
    const end = str(params, 'end_date')
    const limit = params.limit === undefined ? 20 : Number(params.limit)
    const offset = params.offset === undefined ? 0 : Number(params.offset)
    const catalog = await listPublications(ctx, district, str(params, 'series'), start, offset, limit)
    if (catalog.length === 0) throw new EmptyDataError('The request was returned empty.')
    return catalog
      .filter((r) => (!start || (r.date && r.date >= start)) && (!end || (r.date && r.date <= end)))
      .map((r): Row => ({ ...(r.date ? { date: r.date } : {}), series: r.series, title: r.title, url: r.url }))
  }
}

/** `<district>/publication_series`: the district's document series with live counts. */
export function publicationSeriesHandler(district: string): NativeHandler {
  return async (_params: NativeParams, ctx: NativeCtx) => {
    const data = await listSeries(ctx, district)
    if (data.length === 0) throw new EmptyDataError('The request was returned empty.')
    return data
  }
}
