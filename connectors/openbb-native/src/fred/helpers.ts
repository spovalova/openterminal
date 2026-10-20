// The FRED request layer, provider fred. Ported from openbb_fred/utils/api.py, rate_limiter.py, cache.py, query.py and
// fred_helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: responses are cached in memory through ctx.cache
// for the lifetime OpenBB's disk cache gives each endpoint (there is no disk cache here), requests are not spaced
// 0.6 s apart (fan-outs run six at a time and a 429 is retried with OpenBB's back-off instead), and error messages
// never carry the request URL (it holds the API key).
import { urlencode, type QueryValue } from '../lib/urlencode.js'
import type { NativeCtx, NativeParams } from '../types.js'
import { MissingCredential } from '../types.js'

export const ROOT_URL = 'https://api.stlouisfed.org/fred'
export const GEO_ROOT_URL = 'https://api.stlouisfed.org/geofred'
export const V2_ROOT_URL = 'https://api.stlouisfed.org/fred/v2'

type Json = Record<string, any>

/** The key every route of the provider needs, checked before anything else as OpenBB's query executor does. */
export function apiKey(ctx: NativeCtx): string {
  const key = ctx.credential('fred_api_key')
  if (!key) throw new MissingCredential('fred', 'fred_api_key')
  return key
}

/** `build_url`: the endpoint's URL with the parameters that are set (not null), then the key and the JSON file type. */
export function buildUrl(path: string, key: string | undefined, params: Record<string, QueryValue> = {}, root: string = ROOT_URL): string {
  const query: Record<string, QueryValue> = {}
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query[k] = v
  query.api_key = key || ''
  query.file_type = 'json'
  return `${root}/${path.replace(/^\/+/, '')}?${urlencode(query)}`
}

/** The headers OpenBB sends where it sends any (`headers`); `key` adds the bearer token of the v2 endpoints. */
export function requestHeaders(key?: string): Record<string, string> {
  const sent: Record<string, string> = { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', Connection: 'keep-alive' }
  if (key !== undefined) sent.Authorization = `Bearer ${key}`
  return sent
}

// ---- transport: the throttled, retrying, cached GET of rate_limiter.py -------------------------------------------

const MAX_RETRIES = 4
const MIN_INTERVAL_MS = 600
const DEFAULT_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 30_000
const RATE_LIMIT_MESSAGE = 'FRED API rate limit exceeded (HTTP 429). Please wait a moment and try again.'
const HOUR = 3600
const DAY = 24 * HOUR
const DEFAULT_TTL = HOUR
/** Lifetime of a cached answer by endpoint (cache.py TTL_BY_PATH), in seconds; the longest matching prefix wins. */
const TTL_BY_PATH: Record<string, number> = {
  '/fred/series/observations': 4 * HOUR,
  '/fred/series/search': DAY,
  '/fred/series/updates': HOUR,
  '/fred/series': DAY,
  '/fred/release/tables': 6 * HOUR,
  '/fred/release/series': DAY,
  '/fred/releases': DAY,
  '/fred/category': 7 * DAY,
  '/geofred/series/group': 7 * DAY,
  '/geofred/series/data': DAY,
  '/geofred/regional/data': DAY,
}


/** The URL with the key taken out, as the cache key and in anything a person may read. */
export function redact(url: string): string {
  return url.replace(/([?&])api_key=[^&]*/g, '$1api_key=__redacted__')
}

function ttlFor(url: string): number {
  const path = url.split('?', 1)[0]!.replace('https://api.stlouisfed.org', '')
  const matches = Object.keys(TTL_BY_PATH).filter((p) => path.startsWith(p))
  const best = matches.sort((a, b) => b.length - a.length)[0]
  return best === undefined ? DEFAULT_TTL : TTL_BY_PATH[best]!
}

/** An answer that is not worth keeping: nothing or an empty container (`_is_cacheable`). */
const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'object' && Object.keys(v as object).length === 0) || v === '' || (Array.isArray(v) && v.length === 0)

class NotCacheable<T> {
  constructor(public readonly value: T) {}
}

export type GetOptions = {
  /** Read and write the response cache (`use_cache`, default true). */
  useCache?: boolean | undefined
  headers?: Record<string, string>
  /** Reads the response itself (the calendar's pages) instead of the JSON decoder with the rate-limit check. */
  raw?: boolean
}

/** One throttled fetch with retry on a 429, returning the decoded JSON (`_fetch`). */
async function fetchOnce(ctx: NativeCtx, url: string, opts: GetOptions): Promise<any> {
  let attempt = 0
  for (;;) {
    const res = await ctx.http.response(url, opts.headers ? { headers: opts.headers } : {})
    let limited: number | undefined
    let payload: unknown
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      limited = Number.isFinite(retryAfter) && res.headers.get('retry-after') ? Math.max(retryAfter, 0) * 1000 : -1
    } else {
      const text = await res.text()
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`FRED returned a response that is not JSON (HTTP ${res.status})`)
      }
      if (!opts.raw && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const p = payload as Json
        const code = p.error_code || p.status_code
        const message = p.error_message || p.message || ''
        if (String(code) === '429' || String(message).toLowerCase().includes('too many requests')) limited = -1
      }
    }
    if (limited === undefined) return payload
    attempt++
    if (attempt > MAX_RETRIES) throw new Error(RATE_LIMIT_MESSAGE)
    const backoff = limited >= 0 ? limited : Math.min(DEFAULT_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
    await ctx.sleep(Math.max(backoff, MIN_INTERVAL_MS))
  }
}

/** GET a FRED URL: cached, deduplicated while in flight, retried on a 429 (`fred_get`). */
export async function fredGet(ctx: NativeCtx, url: string, opts: GetOptions = {}): Promise<any> {
  const copy = (v: unknown) => (v === null || typeof v !== 'object' ? v : structuredClone(v))
  if (opts.useCache === false) return fetchOnce(ctx, url, opts)
  try {
    return copy(
      await ctx.cache(`fred:${redact(url)}`, ttlFor(url) * 1000, async () => {
        const result = await fetchOnce(ctx, url, opts)
        if (isEmpty(result)) throw new NotCacheable(result)
        return result
      }),
    )
  } catch (err) {
    if (err instanceof NotCacheable) return err.value
    throw err
  }
}

/** Run `fn` over the items, at most `limit` at a time, results in order; every item runs, the first failure is raised. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const settled: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        settled[i] = { status: 'fulfilled', value: await fn(items[i]!, i) }
      } catch (reason) {
        settled[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  for (const s of settled) if (s.status === 'rejected') throw s.reason
  return settled.map((s) => (s as PromiseFulfilledResult<R>).value)
}

export const MAX_IN_FLIGHT = 6

/** `fred_get_many`: the URLs together, in order. */
export function fredGetMany(ctx: NativeCtx, urls: readonly string[], opts: GetOptions = {}): Promise<any[]> {
  return mapLimit(urls, MAX_IN_FLIGHT, (url) => fredGet(ctx, url, opts))
}

// ---- series observations -----------------------------------------------------------------------------------------

/** Python's `date.strftime` for a date given as text or Date, else the value, else null (`_as_date`). */
const asDate = (value: unknown): QueryValue => (value === undefined || value === null || value === '' ? null : (value as QueryValue))

/** The observations URL of one series (`observations_url`). */
export function observationsUrl(seriesId: string, key: string, start?: unknown, end?: unknown, params: Record<string, QueryValue> = {}): string {
  const { preferences: _p, use_cache: _u, ...rest } = params
  return buildUrl('series/observations', key, { series_id: seriesId, observation_start: asDate(start), observation_end: asDate(end), ...rest })
}

/** The observations a response carries, or the error it reports (`_observations`). */
function observationsOf(payload: unknown, seriesId: string): Json[] {
  if (!payload || (typeof payload === 'object' && Object.keys(payload as object).length === 0)) throw new Error(`No data exists for series id: ${seriesId}`)
  const p = payload as Json
  if (p && typeof p === 'object' && !Array.isArray(p) && p.error_message) throw new Error(String(p.error_message))
  return (Array.isArray(p) ? undefined : p.observations) ?? []
}

export type ObservationOptions = { start?: unknown; end?: unknown; useCache?: boolean | undefined; params?: Record<string, QueryValue> }

/** All observations of one series (`get_observations`). */
export async function getObservations(ctx: NativeCtx, seriesId: string, key: string, opts: ObservationOptions = {}): Promise<Json[]> {
  const url = observationsUrl(seriesId, key, opts.start, opts.end, opts.params)
  return observationsOf(await fredGet(ctx, url, { useCache: opts.useCache }), seriesId)
}

/** The observations of many series, in the order asked for (`get_observations_many`). */
export async function getObservationsMany(ctx: NativeCtx, seriesIds: readonly string[], key: string, opts: ObservationOptions = {}): Promise<Json[][]> {
  const urls = seriesIds.map((id) => observationsUrl(id, key, opts.start, opts.end, opts.params))
  const payloads = await fredGetMany(ctx, urls, { useCache: opts.useCache })
  return payloads.map((payload, i) => observationsOf(payload, seriesIds[i]!))
}

/** One observation as a number, or null for a date FRED published nothing for (`published_value`). */
export function publishedValue(value: unknown): number | null {
  if (value === '.' || value === '' || value === null || value === undefined) return null
  const n = toFloat(value)
  return n
}

/** Python's `float(x)` where it is caught: a number, or null when the text is not one. */
export function toFloat(value: unknown): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return null
  const text = value.trim()
  return /^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(text) ? Number(text.replaceAll('_', '')) : null
}

/** pydantic's `to_snake`, which OpenBB's models apply to the name of every declared field when they are written out. */
export function aliasSnake(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([0-9])([A-Z])/g, '$1_$2')
    .replace(/([a-z])([0-9])/g, '$1_$2')
    .replaceAll('-', '_')
    .toLowerCase()
}

// ---- parameters --------------------------------------------------------------------------------------------------

/** A parameter as the text OpenBB's models receive: lists joined with commas, empty as absent. */
export function text(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  if (v === undefined || v === null) return undefined
  const s = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(',') : String(v)
  return s === '' ? undefined : s
}

/** `use_cache: bool = True`. */
export function useCache(params: NativeParams): boolean {
  return params.use_cache === undefined ? true : params.use_cache !== false && params.use_cache !== 'false'
}

/** The current UTC date as `YYYY-MM-DD` (OpenBB reads the server's local date; a recording must replay anywhere). */
export function today(ctx: NativeCtx, plusDays = 0): string {
  const d = new Date(ctx.now().getTime() + plusDays * 86400_000)
  return d.toISOString().slice(0, 10)
}

/** `join_dates`: a date, or comma-separated dates, as sorted-as-given `YYYY-MM-DD` text; undefined when none. */
export function joinDates(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const items = Array.isArray(value) ? value : String(value).split(',')
  const dates: string[] = []
  for (const item of items) {
    const t = String(item).trim()
    if (!t) continue
    const d = parseDate(t)
    if (!d) throw new Error(`Invalid date: ${item}`)
    dates.push(d)
  }
  return dates.length > 0 ? dates.join(',') : undefined
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
/** A month by its name or its three-letter abbreviation, 1 to 12; 0 when it is neither. */
const monthNumber = (name: string): number => {
  const n = name.toLowerCase().replace(/\.$/, '')
  return MONTH_NAMES.findIndex((m) => m === n || (n.length === 3 && m.startsWith(n))) + 1
}

/** pandas.to_datetime(text).date() for the date formats FRED and people write; undefined when it is none of them. */
export function parseDate(t: string): string | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t)
  if (iso) return fmt(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(t)
  if (compact) return fmt(Number(compact[1]), Number(compact[2]), Number(compact[3]))
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (slash) return fmt(Number(slash[3]), Number(slash[1]), Number(slash[2]))
  const ym = /^(\d{4})-(\d{1,2})$/.exec(t)
  if (ym) return fmt(Number(ym[1]), Number(ym[2]), 1)
  if (/^\d{4}$/.test(t)) return fmt(Number(t), 1, 1)
  // "Sep 2025", "September-2025", "Sep-30-2025", "Sep 30, 2025", "30 Sep 2025"
  const monthYear = /^([A-Za-z]+\.?)[\s-]+(\d{4})$/.exec(t)
  if (monthYear && monthNumber(monthYear[1]!)) return fmt(Number(monthYear[2]), monthNumber(monthYear[1]!), 1)
  const monthDayYear = /^([A-Za-z]+\.?)[\s-]+(\d{1,2})(?:,\s*|[\s-]+)(\d{4})$/.exec(t)
  if (monthDayYear && monthNumber(monthDayYear[1]!)) return fmt(Number(monthDayYear[3]), monthNumber(monthDayYear[1]!), Number(monthDayYear[2]))
  const dayMonthYear = /^(\d{1,2})[\s-]+([A-Za-z]+\.?)[\s-]+(\d{4})$/.exec(t)
  if (dayMonthYear && monthNumber(dayMonthYear[2]!)) return fmt(Number(dayMonthYear[3]), monthNumber(dayMonthYear[2]!), Number(dayMonthYear[1]))
  return undefined
}

function fmt(y: number, m: number, d: number): string | undefined {
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined
  return date.toISOString().slice(0, 10)
}

/** The release-table periods a `date` parameter asks for: month starts, or `[undefined]` for the latest (`observation_dates`). */
export function observationDates(value: unknown): (string | undefined)[] {
  const joined = joinDates(value)
  if (!joined) return [undefined]
  return [...new Set(joined.split(',').map((d) => `${d.slice(0, -2)}01`))].sort()
}

/** The release tables URL for one element of a release (`release_tables_url`). */
export function releaseTablesUrl(releaseId: unknown, elementId: unknown, key: string, observationDate?: string): string {
  return buildUrl('release/tables', key, { release_id: releaseId as QueryValue, element_id: elementId as QueryValue, observation_date: observationDate, include_observation_values: 'true' })
}
