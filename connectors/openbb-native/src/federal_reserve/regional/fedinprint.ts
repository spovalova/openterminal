// Fed in Print publication catalogs for the Reserve Banks, provider federal_reserve. Ported from
// openbb_federal_reserve/utils/fedinprint.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain HTTPS requests
// through ctx.http (the Python code uses a curl_cffi Chrome session; fedinprint.org does not need it), ctx.cache
// instead of the on-disk cache (a day for the catalogs), and no registry builder.
import { parse } from 'node-html-parser'
import { BROWSER_UA, NativeHttpError } from '../../http.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { DISTRICTS } from './fedinprint-registry.js'

const BASE = 'https://fedinprint.org'
const SEARCH_URL = `${BASE}/search`
const PAGE_SIZE = 10
const RESOLVE_TTL_MS = 30 * 86400 * 1000
const CATALOG_TTL_MS = 86400 * 1000

type Publication = { series: string; date: string; title: string; url: string }

/** Python's html.unescape: every named and numeric character reference. */
export function unescapeHtml(text: string): string {
  return text.includes('&') ? parse(text.replace(/</g, '&lt;'), { blockTextElements: {} }).text : text
}

async function fetchText(ctx: NativeCtx, url: string): Promise<string> {
  const get = () => ctx.http.response(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 180_000 })
  let res = await get()
  if (res.status === 403) res = await get()
  if (!res.ok) throw new NativeHttpError(res.status, url, (await res.text().catch(() => '')).slice(0, 200))
  return res.text()
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

/** Collapse whitespace in a raw facet value for display. */
function cleanLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** A faceted-search URL sorted newest-first at the given offset. */
function searchUrl(facets: string[], start: number): string {
  const qs = new URLSearchParams()
  for (const f of facets) qs.append('facets[]', f)
  qs.append('sort', 'sort_date_text desc')
  qs.append('start', String(start))
  return `${SEARCH_URL}?${qs.toString()}`
}

/** A search-result block as a candidate record; blocks without a content type are web-only items. */
function parseBlock(block: string, series: string): Publication | undefined {
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

/** The citation PDF URL, or the `File(s)` link, from an item page. */
function firstFileLink(page: string): string {
  const meta = PDF_META.exec(page)
  if (meta) return unescapeHtml(meta[1]!)
  const href = FILE_HREF.exec(page)
  return href ? unescapeHtml(href[1]!) : ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Whether a URL points at a downloadable document rather than a page. */
function isFile(url: string): boolean {
  const low = url.toLowerCase()
  const host = hostOf(url)
  const isDoi = host === 'doi.org' || host.endsWith('.doi.org')
  return low.endsWith('.pdf') || isDoi || low.includes('/files/')
}

/** A Reserve Bank CMS staging host rewritten to its public equivalent. */
function publicUrl(url: string): string {
  return url.replace(/^(https?:\/\/)([a-z0-9-]+)cm\.ws\.frb\.org/, '$1www.$2.org')
}

/** An item page's direct document URL, or undefined (an HTML article without a file). */
async function resolveFile(ctx: NativeCtx, itemUrl: string): Promise<string | undefined> {
  let link = firstFileLink(await fetchText(ctx, itemUrl))
  if (!link) return undefined
  if (hostOf(link) === 'fraser.stlouisfed.org' && !link.includes('/files/')) {
    const inner = firstFileLink(await fetchText(ctx, link))
    if (inner) link = inner
  }
  return isFile(link) ? publicUrl(link) : undefined
}

/** One page of a Reserve Bank's publications, newest first (the fast path: no item pages). */
async function search(ctx: NativeCtx, provider: string, seriesFacet: string | undefined, minYear: string, start: number, limit: number): Promise<Publication[]> {
  const facets = [`provider_literal_array:${provider}`]
  if (seriesFacet) facets.push(`hasparentname_literal_array:${seriesFacet}`)
  const label = seriesFacet ? cleanLabel(seriesFacet) : ''

  const pagesNeeded = Math.ceil(limit / PAGE_SIZE) + 1
  const offsets = Array.from({ length: pagesNeeded }, (_, i) => start + i * PAGE_SIZE)
  const pages = await Promise.all(offsets.map((o) => fetchText(ctx, searchUrl(facets, o))))

  const seen = new Set<string>()
  const records: Publication[] = []
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
  // Newest first; ties by title descending, then in the order found.
  records.sort((a, b) => (a.date === b.date ? (a.title === b.title ? 0 : a.title < b.title ? 1 : -1) : a.date < b.date ? 1 : -1))
  return records.slice(0, limit)
}

/** The document count of each of a provider's series, by clean display label. */
async function seriesCounts(ctx: NativeCtx, provider: string): Promise<Map<string, number>> {
  const page = await fetchText(ctx, searchUrl([`provider_literal_array:${provider}`], 0))
  const out = new Map<string, number>()
  for (const m of page.matchAll(FACET_COUNT)) out.set(cleanLabel(m[1]!), Number(m[2]!.replace(/,/g, '')))
  return out
}

class Unresolved extends Error {}

/** An item URL resolved to its document; the mapping is immutable, so it is kept for 30 days. */
async function safeResolve(ctx: NativeCtx, url: string): Promise<string | undefined> {
  try {
    // Failures and items without a file are not kept: the next request tries again.
    return await ctx.cache(`fedinprint:resolve:${url}`, RESOLVE_TTL_MS, async () => {
      const resolved = await resolveFile(ctx, url)
      if (!resolved) throw new Unresolved()
      return resolved
    })
  } catch {
    return undefined
  }
}

/** Resolve item URLs to documents, dropping the items without a downloadable file, until `limit` are collected. */
async function resolveRecords(ctx: NativeCtx, records: Publication[], limit: number, workers = 10): Promise<Publication[]> {
  const viewable: Publication[] = []
  for (let index = 0; index < records.length && viewable.length < limit; index += workers) {
    const chunk = records.slice(index, index + workers)
    const targets = await Promise.all(chunk.map((r) => safeResolve(ctx, r.url)))
    chunk.forEach((record, i) => {
      const target = targets[i]
      if (target) viewable.push({ ...record, url: target })
    })
  }
  return viewable.slice(0, limit)
}

function district(name: string) {
  const d = DISTRICTS[name]
  if (!d) throw new Error(`fedinprint: unknown district ${name}`)
  return d
}

/** A page of a district's publications, resolved to direct documents. A known series is searched; otherwise the primary one. */
async function searchPublications(ctx: NativeCtx, name: string, series: string | undefined, minYear: string, start: number, limit: number): Promise<Publication[]> {
  const d = district(name)
  const facet = (series ? d.series.find(([slug]) => slug === series)?.[1] : undefined) ?? d.series[0]?.[1]
  if (facet === undefined) return []
  const need = start + limit
  const candidates = await search(ctx, d.provider, facet, minYear, 0, need * 2 + PAGE_SIZE)
  return (await resolveRecords(ctx, candidates, need)).slice(start)
}

/** The publications route (`federal_reserve/<district>/publications`): the catalog page with the date filters applied. */
export async function publications(name: string, params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const d = district(name)
  const series = typeof params.series === 'string' && d.series.some(([slug]) => slug === params.series) ? params.series : undefined
  const startDate = typeof params.start_date === 'string' ? params.start_date : undefined
  const endDate = typeof params.end_date === 'string' ? params.end_date : undefined
  const limit = typeof params.limit === 'number' ? params.limit : 20
  const offset = typeof params.offset === 'number' ? params.offset : 0
  const minYear = startDate ? startDate.slice(0, 4) : ''
  const catalog = await ctx.cache(`fedinprint:publications:${name}:${series ?? ''}:${minYear}:${offset}:${limit}`, CATALOG_TTL_MS, () => searchPublications(ctx, name, series, minYear, offset, limit))
  if (catalog.length === 0) throw new Error('The request was returned empty.')

  let records = catalog
  if (startDate) records = records.filter((r) => r.date && r.date >= startDate)
  if (endDate) records = records.filter((r) => r.date && r.date <= endDate)
  return records.map((r) => ({ ...(r.date ? { date: r.date } : {}), series: r.series, title: r.title, url: r.url }))
}

/** `publications` and `publication_series` handlers of one district, keyed by route. */
export function publicationRoutes(name: string): Record<string, NativeHandler> {
  return {
    [`federal_reserve/${name}/publications`]: (params, ctx) => publications(name, params, ctx),
    [`federal_reserve/${name}/publication_series`]: (_params, ctx) => publicationSeries(name, ctx),
  }
}

/** The publication_series route: a district's series with live document counts. */
export async function publicationSeries(name: string, ctx: NativeCtx): Promise<Row[]> {
  const d = district(name)
  const rows = await ctx.cache(`fedinprint:series:${name}`, CATALOG_TTL_MS, async () => {
    const counts = await seriesCounts(ctx, d.provider)
    return d.series.map(([slug, facet]) => ({ series: slug, name: cleanLabel(facet), count: counts.get(cleanLabel(facet)) ?? 0 }))
  })
  if (rows.length === 0) throw new Error('The request was returned empty.')
  return rows
}
