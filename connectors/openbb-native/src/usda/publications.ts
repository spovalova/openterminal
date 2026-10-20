// usda/publications, provider usda. Ported from openbb_government_us/usda/models/ers_publications.py
// and utils/ers_publications.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models,
// listings are memoised through ctx.cache.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { ERS_BASE, omitNone, optInt, optString } from './helpers.js'
import { optList } from './helpers-c.js'
import { SERIES_CODES, SERIES_GROUPS } from './publications-data.js'

const API_URL = `${ERS_BASE}/api/publications/v1.0`
const MAX_ITEMS_PER_PAGE = 50
const LISTING_TTL_MS = 21600 * 1000
const DEFAULT_SERIES = 'outlook-reports'

type ApiRow = Record<string, unknown>
type Publication = {
  id: string
  title: unknown
  release_date: string
  series_code: unknown
  series_name: unknown
  report_number: unknown
  url: string
  authors: unknown[]
  short_description: unknown
  topics: unknown[]
}

/** `coerce_sentinel`: the source writes 0 where a value is missing. */
const coerceSentinel = (value: unknown): unknown => (value === 0 ? null : value)

/** `resolve_series`: groups expand to their series codes; codes match case-insensitively; duplicates dropped. */
function resolveSeries(requested: string[]): string[] {
  if (requested.length === 0) throw new Error(`No publication series requested. Valid groups are: ${Object.keys(SERIES_GROUPS).sort().join(', ')}`)
  const lookup = new Map(Object.keys(SERIES_CODES).map((code) => [code.toLowerCase(), code]))
  const codes: string[] = []
  const unknown: string[] = []
  for (const token of requested) {
    const group = SERIES_GROUPS[token.toLowerCase()]
    if (group) {
      codes.push(...group)
      continue
    }
    const code = lookup.get(token.toLowerCase())
    if (code === undefined) unknown.push(token)
    else codes.push(code)
  }
  if (unknown.length) {
    throw new Error(`Invalid publication series: ${unknown.join(', ')}. Valid groups are: ${Object.keys(SERIES_GROUPS).sort().join(', ')}. Valid series codes are: ${Object.keys(SERIES_CODES).sort().join(', ')}`)
  }
  return [...new Set(codes)]
}

function normalizeRow(row: ApiRow): Publication {
  const seriesValue = coerceSentinel(row.series)
  const series = seriesValue !== null && typeof seriesValue === 'object' && !Array.isArray(seriesValue) ? (seriesValue as ApiRow) : {}
  const related = Array.isArray(row.relatedTopics) ? (row.relatedTopics as (ApiRow | null)[]) : []
  return {
    id: row.id as string,
    title: row.title,
    release_date: row.releaseDate as string,
    series_code: coerceSentinel(series.code),
    series_name: coerceSentinel(series.name),
    report_number: coerceSentinel(row.reportNumber),
    url: `${ERS_BASE}${String(row.url)}`,
    authors: Array.isArray(row.authors) ? (row.authors as ApiRow[]).map((a) => a.name) : [],
    short_description: coerceSentinel(row.shortDescription),
    topics: related.filter((t) => t).map((t) => t!.name),
  }
}

/** Every page of one series (`fetch_series_rows`), newest first, de-duplicated by id. */
async function fetchSeriesRows(ctx: NativeCtx, code: string): Promise<ApiRow[]> {
  const page = async (n: number): Promise<{ rows: ApiRow[]; pager?: { total_items?: number } }> => {
    const response = await ctx.http.json<{ rows?: ApiRow[]; pager?: { total_items?: number } }>(API_URL, { query: { series: code, items_per_page: MAX_ITEMS_PER_PAGE, sort_by: 'releaseDate', sort_order: 'DESC', page: n } })
    if (response === null || typeof response !== 'object' || !('rows' in response)) throw new Error(`Unexpected ERS publications response for series ${code} -> ${JSON.stringify(response).slice(0, 200)}`)
    return response as { rows: ApiRow[]; pager?: { total_items?: number } }
  }
  const first = await page(0)
  const rows = new Map<string, ApiRow>(first.rows.map((r) => [r.id as string, r]))
  const pages = Math.ceil(Number(first.pager?.total_items ?? 0) / MAX_ITEMS_PER_PAGE)
  for (let n = 1; n < pages; n++) for (const r of (await page(n)).rows) rows.set(r.id as string, r)
  return [...rows.values()]
}

export async function publications(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const codes = resolveSeries(optList(params, 'series') ?? [DEFAULT_SERIES])
  const startDate = optString(params, 'start_date')
  const endDate = optString(params, 'end_date')
  const limit = optInt(params, 'limit')

  const fetched = await Promise.all(codes.map((code) => ctx.cache(`usda:publications:${code}`, LISTING_TTL_MS, () => fetchSeriesRows(ctx, code))))
  const records = new Map<string, Publication>()
  for (const rows of fetched) for (const row of rows) records.set(row.id as string, normalizeRow(row))
  let results = [...records.values()]
  if (startDate !== undefined) results = results.filter((r) => r.release_date >= startDate)
  if (endDate !== undefined) results = results.filter((r) => r.release_date <= endDate)
  // Newest first; ties by id, also descending.
  results.sort((a, b) => (a.release_date === b.release_date ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.release_date < b.release_date ? 1 : -1))
  const rows = limit ? results.slice(0, limit) : results
  return rows.map((row) =>
    omitNone({
      id: row.id,
      title: row.title,
      release_date: row.release_date,
      series_code: row.series_code,
      series_name: row.series_name,
      report_number: row.report_number,
      url: row.url,
      authors: row.authors.filter((a) => a).join(', ') || null,
      short_description: row.short_description,
      topics: row.topics.filter((t) => t).join(', ') || null,
    }),
  )
}
