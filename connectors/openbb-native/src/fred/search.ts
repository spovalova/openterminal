// economy/fred_search, provider fred, and the search the release tables and TIPS routes use. Ported from
// openbb_fred/models/search.py and the standard FRED search model (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of a DataFrame and pydantic models, and a search term that is not a valid JavaScript regular
// expression is refused where Python's `re` might have accepted it.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { apiKey, buildUrl, fredGet, GEO_ROOT_URL, text, useCache } from './helpers.js'

type Json = Record<string, any>

/** FredSearchQueryParams after transform_query. */
type SearchQuery = {
  query?: string | undefined
  search_type: string
  release_id?: number | undefined
  limit?: number | undefined
  offset: number
  order_by: string
  sort_order: string
  filter_variable?: string | undefined
  filter_value?: string | undefined
  tag_names?: string | undefined
  exclude_tag_names?: string | undefined
  series_id?: string | undefined
  use_cache: boolean
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))
const nonNegative = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: Input should be greater than or equal to 0 (got ${v})`)
  return n
}

/** The parameters as OpenBB's `transform_query` leaves them: the search type decided, defaults applied. */
function transformQuery(raw: Record<string, unknown>): SearchQuery {
  const p = { ...raw }
  const falsy = (v: unknown) => v === undefined || v === null || v === '' || v === 0
  if ((!falsy(p.release_id) && falsy(p.search_type)) || (falsy(p.query) && falsy(p.release_id) && falsy(p.series_id))) {
    p.search_type = 'release'
  } else if (falsy(p.query) && (['full_text', 'series_id'].includes(String(p.search_type)) || falsy(p.search_type)) && falsy(p.series_id)) {
    throw new Error("A query is required for search_type 'full_text' or 'series_id'.")
  }
  if (!falsy(p.exclude_tag_names) && falsy(p.tag_names)) throw new Error("Field 'exclude_tag_names' requires 'tag_names' to be set.")
  return {
    query: str(p.query),
    search_type: str(p.search_type) ?? 'full_text',
    release_id: nonNegative(p.release_id, 'release_id'),
    limit: nonNegative(p.limit, 'limit'),
    offset: nonNegative(p.offset, 'offset') ?? 0,
    order_by: str(p.order_by) ?? 'observation_end',
    sort_order: str(p.sort_order) ?? 'desc',
    filter_variable: str(p.filter_variable),
    filter_value: str(p.filter_value),
    tag_names: str(p.tag_names),
    exclude_tag_names: str(p.exclude_tag_names),
    series_id: str(p.series_id),
    use_cache: p.use_cache === undefined ? true : p.use_cache !== false && p.use_cache !== 'false',
  }
}

/** The rows the API answers with, before the models rename and type them. */
async function extract(ctx: NativeCtx, key: string, q: SearchQuery): Promise<Json[]> {
  if (q.series_id !== undefined) {
    const results: Json[] = []
    await Promise.all(
      q.series_id.split(',').map(async (id) => {
        const response = await fredGet(ctx, buildUrl('series/group', key, { series_id: id }, GEO_ROOT_URL), { useCache: q.use_cache })
        const group = response?.series_group
        if (group) results.push({ ...group, series_id: id })
      }),
    )
    if (results.length > 0) return results
    throw new Error('No results found for the provided series_id(s).')
  }
  if (q.search_type === 'release' && q.release_id === undefined) {
    const response = await fredGet(ctx, buildUrl('releases', key), { useCache: q.use_cache })
    const results = response?.releases
    if (results && results.length > 0) return results
    throw new Error('Unexpected result while retrieving the list of releases from the FRED API.')
  }
  const path = q.release_id !== undefined ? 'release/series' : 'series/search'
  // The fields in declaration order, the query under FRED's name for it; those that are None are left out.
  const params: Record<string, string | number | undefined> = {
    ...(q.release_id === undefined ? { search_text: q.query } : {}),
    search_type: q.search_type,
    release_id: q.release_id,
    offset: q.offset,
    ...(q.release_id !== undefined && q.order_by === 'search_rank' ? {} : { order_by: q.order_by }),
    sort_order: q.sort_order,
    filter_variable: q.filter_variable,
    filter_value: q.filter_value,
    tag_names: q.tag_names,
    exclude_tag_names: q.exclude_tag_names,
  }
  const response = await fredGet(ctx, buildUrl(path, key, params), { useCache: q.use_cache })
  if (response && typeof response === 'object' && !Array.isArray(response) && 'error_code' in response) {
    throw new Error(`FRED API Error -> Status Code: ${response.error_code} -> ${response.error_message ?? ''}`)
  }
  if (response && typeof response === 'object' && !Array.isArray(response) && 'count' in response) return response.seriess ?? []
  throw new Error(`Unexpected response format. Expected a dictionary, got ${Array.isArray(response) ? "<class 'list'>" : typeof response}`)
}

/** Python's `str()` of a cell, for the search terms. */
function cellText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined
  if (v === true) return 'True'
  if (v === false) return 'False'
  return String(v)
}

/** FredSearchData's `last_updated` validator: dateutil's reading of FRED's `2025-09-30 15:13:03-05`. */
function lastUpdated(v: unknown): string | undefined {
  if (!v) return undefined
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(String(v).trim())
  if (!m) throw new Error(`Unknown string format: ${v}`)
  const time = m[2]!.length === 5 ? `${m[2]}:00` : m[2]!
  const zone = m[3]
  if (!zone) return `${m[1]}T${time}`
  if (zone === 'Z') return `${m[1]}T${time}Z`
  const digits = zone.slice(1).replace(':', '')
  const hours = digits.slice(0, 2)
  const minutes = digits.slice(2, 4) || '00'
  return Number(hours) === 0 && Number(minutes) === 0 ? `${m[1]}T${time}Z` : `${m[1]}T${time}${zone[0]}${hours}:${minutes}`
}

/** The model's field names for the API's keys (`__alias_dict__`), and its types for the values. */
const RENAMES: Record<string, string> = { link: 'url', min_date: 'observation_start', max_date: 'observation_end', season: 'seasonal_adjustment', id: 'series_id' }

function toData(raw: Json, releaseListing: boolean): Row {
  const row: Row = {}
  for (const [k, v] of Object.entries(raw)) {
    const name = k === 'id' && releaseListing ? 'release_id' : (RENAMES[k] ?? k)
    if (v === null || v === undefined) continue
    if (name === 'last_updated') row[name] = lastUpdated(v)
    else if (name === 'release_id' || name === 'series_group') row[name] = String(v)
    else row[name] = v
  }
  return row
}

/** FredSearchFetcher.fetch_data: the series (or releases) that match, as OpenBB's search model returns them. */
export async function searchSeries(ctx: NativeCtx, key: string, raw: Record<string, unknown>): Promise<Row[]> {
  const q = transformQuery(raw)
  const data = await extract(ctx, key, q)
  if (data.length === 0) throw new Error('The request was returned empty.')
  const releaseListing = q.search_type === 'release' && q.release_id === undefined
  let rows = data.map((r) => ({ ...r }))

  // Every term (`;`-separated) must appear, as a regular expression, in some column of a row.
  const terms = [...(q.query ? q.query.split(';').map((t) => t.trim()) : []), ...(q.tag_names && q.search_type !== 'series_id' ? q.tag_names.split(';').map((t) => t.trim()) : [])]
  if (terms.length > 0 && q.series_id === undefined && q.search_type !== 'series_id') {
    const patterns = terms.map((t) => {
      try {
        return new RegExp(t, 'i')
      } catch {
        throw new Error(`nothing to repeat or invalid regular expression in search term: ${t}`)
      }
    })
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    rows = rows.filter((r) => patterns.every((re) => columns.some((c) => {
      const cell = cellText(r[c])
      return cell !== undefined && re.test(cell)
    })))
    if (rows.length === 0) throw new Error('No results found for the provided query.')
  }

  if (rows.some((r) => q.order_by in r)) {
    const column = q.order_by
    const ascending = q.sort_order === 'asc'
    const missing = (v: unknown) => v === null || v === undefined
    // A missing value sorts last either way; equal values keep their order.
    rows = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const x = a.r[column]
        const y = b.r[column]
        if (missing(x) || missing(y)) return missing(x) && missing(y) ? a.i - b.i : missing(x) ? 1 : -1
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
        return (ascending ? c : -c) || a.i - b.i
      })
      .map((x) => x.r)
  }
  if (q.limit !== undefined && rows.length > q.limit) rows = rows.slice(0, q.limit)
  return rows.map((r) => toData(r, releaseListing))
}

export async function fredSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  return searchSeries(ctx, key, {
    query: text(params, 'query'),
    search_type: text(params, 'search_type'),
    release_id: text(params, 'release_id'),
    limit: text(params, 'limit'),
    offset: text(params, 'offset'),
    order_by: text(params, 'order_by'),
    sort_order: text(params, 'sort_order'),
    filter_variable: text(params, 'filter_variable'),
    filter_value: text(params, 'filter_value'),
    tag_names: text(params, 'tag_names'),
    exclude_tag_names: text(params, 'exclude_tag_names'),
    series_id: text(params, 'series_id'),
    use_cache: useCache(params),
  })
}
