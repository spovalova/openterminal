// DTCC Public Price Dissemination search client. Ported from openbb_cftc/utils/search.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: dates are ISO strings, results are memoised with ctx.cache instead of the on-disk store.
import type { NativeCtx } from '../../types.js'
import { JURISDICTION, PPD_API_URL, SLICE_HEADERS } from './constants.js'
import { addDays, diffDays, todayOf, type D } from './dates.js'
import type { SliceRecord } from './curve.js'

export const SEARCH_ROW_CAP = 10000
export const SEARCH_MAX_RANGE_DAYS = 180
export const SEARCH_MAX_RETENTION_DAYS = 365
export const SEARCH_MAX_NOTIONAL = 999_999_999_999.0
export const SEARCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const SEARCH_ASSET_CLASSES: Record<string, string> = {
  rates: 'RATES',
  credits: 'CREDITS',
  equities: 'EQUITY',
  forex: 'FOREIGNEXCHANGE',
  commodities: 'COMMODITIES',
}

const SEARCH_ALIASES: Record<string, string> = {
  uniqueproductidentifiershortname: 'UPI FISN',
  uniqueproductidentifierunderliername: 'UPI Underlier Name',
  disseminationtimestamp: 'Dissemination Timestamp',
  callamountleg1: 'Call amount',
  callcurrencyleg1: 'Call currency',
  putamountleg1: 'Put amount',
  putcurrencyleg1: 'Put currency',
  settlementlocationleg1: 'Settlement location',
  strikepricecurrencyorcurrencypair: 'Strike price currency/currency pair',
}

/** Reduce a field name to its alphanumeric lowercase form (`_normalize_key`). */
const normalizeKey = (key: string): string => [...key.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join('')

const HEADER_BY_KEY = new Map<string, string>()
for (const header of SLICE_HEADERS as readonly string[]) HEADER_BY_KEY.set(normalizeKey(header), header)

/** Map an asset class key to its search payload value (`normalize_search_asset_class`). */
export function normalizeSearchAssetClass(assetClass: string): string {
  const key = (assetClass || '').trim().toLowerCase()
  const value = SEARCH_ASSET_CLASSES[key]
  if (value === undefined) throw new Error(`Invalid asset class: '${assetClass}'. Valid asset classes are: ${Object.keys(SEARCH_ASSET_CLASSES).join(', ')}`)
  return value
}

/** A date as a dissemination timestamp bound (`format_search_datetime`). */
export const formatSearchDatetime = (value: D, endOfDay = false): string => `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`

/** `urllib.parse.unquote`: percent escapes decoded as UTF-8 with replacement, bad escapes left alone. */
export function pyUnquote(text: string): string {
  if (!text.includes('%')) return text
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16)
    return new TextDecoder('utf-8').decode(bytes)
  })
}

/** A search record mapped onto the CSV headers the curve and FX paths read (`map_search_record`). */
export function mapSearchRecord(record: Record<string, unknown>): SliceRecord {
  const mapped: SliceRecord = {}
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeKey(key)
    const header = SEARCH_ALIASES[normalized] ?? HEADER_BY_KEY.get(normalized)
    if (header === undefined) continue
    mapped[header] = typeof value === 'string' ? pyUnquote(value) : (value as string | null | undefined)
  }
  return mapped
}

export type SearchPayload = Record<string, string | null>

/** A search payload; every field must be present, including the null ones (`build_search_payload`). */
export function buildSearchPayload(
  assetClass: string,
  o: { currency?: string | null; upiShortName?: string | null; upi?: string | null; productId?: string | null; underlyingAsset?: string | null; minNotional?: number; maxNotional?: number } = {},
): SearchPayload {
  const asset = normalizeSearchAssetClass(assetClass)
  const commodities = asset === 'COMMODITIES'
  return {
    jurisdiction: JURISDICTION,
    assetClass: asset,
    currency: commodities ? null : (o.currency ?? null),
    minNotionalAmount: String(Math.trunc(o.minNotional ?? 0)),
    maxNotionalAmount: String(Math.trunc(o.maxNotional ?? SEARCH_MAX_NOTIONAL)),
    displayType: 'w',
    disseminationDateTimeLow: null,
    disseminationDateTimeHigh: null,
    productId: commodities ? (o.productId ?? null) : null,
    underlyingAsset: commodities ? (o.underlyingAsset ?? null) : null,
    upi: commodities ? null : (o.upi ?? null),
    upiShortName: commodities ? null : (o.upiShortName ?? null),
    name: null,
    searchIndicator: 'post',
  }
}

type SearchBody = { errorList?: ({ errorMessage?: string } | string)[]; tradeList?: Record<string, unknown>[] } | null

/** POST a search payload and return its trade list (`post_search`). */
async function postSearch(ctx: NativeCtx, payload: SearchPayload): Promise<Record<string, unknown>[]> {
  const url = `${PPD_API_URL}/search/webdisplay`
  let body: SearchBody
  try {
    body = await ctx.http.json<SearchBody>(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': SEARCH_USER_AGENT } })
  } catch (err) {
    throw new Error(`Failed to query the PPD search endpoint -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`Unexpected PPD search response: ${JSON.stringify(body)}`)
  const errors = body.errorList ?? []
  if (errors.length > 0) throw new Error('The PPD search endpoint rejected the query -> ' + errors.map((e) => (typeof e === 'object' && e !== null && e.errorMessage ? e.errorMessage : JSON.stringify(e))).join('; '))
  return body.tradeList ?? []
}

const dateRange = (start: D, end: D): D[] => Array.from({ length: diffDays(end, start) + 1 }, (_v, i) => addDays(start, i))

/** Split a range into consecutive sub-windows of at most `maxDays` days each (`_chunk_windows`). */
function chunkWindows(start: D, end: D, maxDays: number): [D, D][] {
  const chunks: [D, D][] = []
  let low = start
  while (low <= end) {
    const high = addDays(low, maxDays - 1) < end ? addDays(low, maxDays - 1) : end
    chunks.push([low, high])
    low = addDays(high, 1)
  }
  return chunks
}

/** Group dates into contiguous runs, so only gaps are re-fetched (`_contiguous_runs`). */
function contiguousRuns(days: D[]): [D, D][] {
  const runs: [D, D][] = []
  for (const day of [...days].sort()) {
    const last = runs[runs.length - 1]
    if (last && day === addDays(last[1], 1)) last[1] = day
    else runs.push([day, day])
  }
  return runs
}

/** Query a window, splitting past the cap: by date, then by notional on a single day (`search_window`). */
async function searchWindow(ctx: NativeCtx, payload: SearchPayload, start: D, end: D): Promise<Record<string, unknown>[]> {
  const window = { ...payload, disseminationDateTimeLow: formatSearchDatetime(start), disseminationDateTimeHigh: formatSearchDatetime(end, true) }
  const rows = await postSearch(ctx, window)
  if (rows.length < SEARCH_ROW_CAP) return rows
  if (start !== end) {
    const midpoint = addDays(start, Math.floor(diffDays(end, start) / 2))
    const [left, right] = await Promise.all([searchWindow(ctx, payload, start, midpoint), searchWindow(ctx, payload, addDays(midpoint, 1), end)])
    return [...left, ...right]
  }
  return searchDayByNotional(ctx, payload, start)
}

/** Log-spaced notional band edges spanning low to high inclusive (`_notional_band_edges`). */
function notionalBandEdges(low: number, high: number, count = 32): number[] {
  const lo = Math.max(low, 1)
  if (high <= lo) return []
  const ratio = Math.pow(high / lo, 1.0 / count)
  const edges = new Set<number>([low, high])
  let value = lo
  for (let i = 0; i < count - 1; i++) {
    value *= ratio
    edges.add(Math.trunc(value))
  }
  return [...edges].sort((a, b) => a - b)
}

const fmt = (n: number): string => n.toLocaleString('en-US')

/** Split a single capped day across a fixed set of geometric notional bands (`_search_day_by_notional`). */
async function searchDayByNotional(ctx: NativeCtx, payload: SearchPayload, day: D): Promise<Record<string, unknown>[]> {
  const low = Math.trunc(Number(payload.minNotionalAmount || 0))
  const high = Math.trunc(Number(payload.maxNotionalAmount || Math.trunc(SEARCH_MAX_NOTIONAL)))
  const edges = notionalBandEdges(low, high)
  if (edges.length < 2) throw new Error(`The PPD search for ${day} returned the ${SEARCH_ROW_CAP}-record cap within a single notional value, so it cannot be narrowed further by notional.`)
  const bands: Record<string, unknown>[][] = []
  for (let i = 0; i + 1 < edges.length; i++) bands.push(await searchNotionalBand(ctx, payload, day, edges[i]!, edges[i + 1]!))
  return bands.flat()
}

/** Query one notional band of a single day, refusing a band that still caps (`_search_notional_band`). */
async function searchNotionalBand(ctx: NativeCtx, payload: SearchPayload, day: D, low: number, high: number): Promise<Record<string, unknown>[]> {
  const window = { ...payload, disseminationDateTimeLow: formatSearchDatetime(day), disseminationDateTimeHigh: formatSearchDatetime(day, true), minNotionalAmount: String(low), maxNotionalAmount: String(high) }
  const rows = await postSearch(ctx, window)
  if (rows.length >= SEARCH_ROW_CAP) throw new Error(`The PPD search for ${day} returned the ${SEARCH_ROW_CAP}-record cap within the ${fmt(low)} to ${fmt(high)} notional band; narrow the date or notional range.`)
  return rows
}

/** A stable key of a payload's non-window fields (`_cache_key`). */
function cacheKey(payload: SearchPayload): string {
  const sorted = Object.keys(payload).filter((k) => k !== 'disseminationDateTimeLow' && k !== 'disseminationDateTimeHigh').sort()
  return JSON.stringify(sorted.map((k) => [k, payload[k]]))
}

/** A dissemination window's records, mapped onto the slice's CSV headers (`search_trades`). */
export async function searchTrades(
  ctx: NativeCtx,
  assetClass: string,
  startDate: D,
  endDate: D,
  o: { currency?: string | null; upiShortName?: string | null; upi?: string | null; productId?: string | null; underlyingAsset?: string | null; minNotional?: number } = {},
): Promise<SliceRecord[]> {
  if (endDate < startDate) throw new Error(`The search window ends before it starts: ${startDate} to ${endDate}.`)
  const today = todayOf(ctx.now())
  const horizon = addDays(today, -(SEARCH_MAX_RETENTION_DAYS - 1))
  const start = startDate > horizon ? startDate : horizon
  if (start > endDate) throw new Error(`The search window predates the ${SEARCH_MAX_RETENTION_DAYS}-day search horizon; use source='slice' for older data.`)
  const payload = buildSearchPayload(assetClass, o)
  const days = dateRange(start, endDate)
  const ttl = endDate < today ? 3600_000 : 300_000
  return ctx.cache(`ppd-search:${cacheKey(payload)}:${start}:${endDate}`, ttl, async () => {
    const fetched = new Map<D, SliceRecord[]>(days.map((d) => [d, []]))
    const windows = contiguousRuns(days).flatMap(([lo, hi]) => chunkWindows(lo, hi, SEARCH_MAX_RANGE_DAYS))
    const results = await Promise.all(windows.map(([lo, hi]) => searchWindow(ctx, payload, lo, hi)))
    const seen = new Set<string>()
    for (const records of results) {
      for (const record of records) {
        const row = mapSearchRecord(record)
        const day = String(row['Dissemination Timestamp'] ?? '').slice(0, 10)
        const bucket = fetched.get(day)
        if (bucket === undefined) continue
        const identifier = row['Dissemination Identifier']
        if (identifier) {
          if (seen.has(identifier)) continue
          seen.add(identifier)
        }
        bucket.push(row)
      }
    }
    return days.flatMap((d) => fetched.get(d) ?? [])
  })
}

