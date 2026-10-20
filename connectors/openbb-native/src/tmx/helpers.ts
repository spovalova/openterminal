// Ported from openbb_tmx/utils/{helpers,cache,session,quotemedia}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// rows instead of DataFrames, the GraphQL and QuoteMedia transports go through ctx.http and ctx.cache instead of the
// aiohttp session and the on-disk response cache, and the few pydantic coercions the models rely on are small functions.
import { BROWSER_UA } from '../http.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'

export const GQL_URL = 'https://app-money.tmx.com/graphql'
export const QM_APP_URL = 'https://app.quotemedia.com'
export const QM_WEBMASTER_ID = '101020'

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** An OpenBB failure the models raise (`OpenBBError`, `EmptyDataError`): the route has no answer for these params. */
export class TmxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TmxError'
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Values

export const isNil = (v: unknown): v is null | undefined => v === null || v === undefined

/** Python truthiness for the JSON values the feeds return. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (typeof v === 'number') return !Number.isNaN(v)
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/** `float(v)` for a number or a numeric string. */
export function toFloat(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const s = v.trim()
    const n = Number(s)
    if (s !== '' && !Number.isNaN(n)) return n
  }
  throw new TmxError(`could not convert ${JSON.stringify(v)} to float`)
}

/** Pydantic's lax `float | None` field: numbers pass, numeric strings convert, empty is missing. */
export function optFloat(v: unknown): number | undefined {
  if (isNil(v) || v === '') return undefined
  return toFloat(v)
}

/** `float(v) / 100 if v else None`, the percent validators. */
export function percent(v: unknown): number | undefined {
  return truthy(v) ? toFloat(v) / 100 : undefined
}

/** Python's `round(x, nd)`: the exact binary value, ties to even. */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x
  const exact = Math.abs(x).toFixed(Math.min(100, nd + 40))
  const [whole, frac = ''] = exact.split('.')
  const tail = frac.slice(nd)
  if (/^50*$/.test(tail)) {
    // An exact tie: round half to even on the digit before it.
    const keep = (whole + frac.slice(0, nd)).replace(/^0+(?=\d)/, '')
    const lastEven = Number(keep.slice(-1)) % 2 === 0
    const kept = Number(`${whole}.${frac.slice(0, nd) || '0'}`)
    const bump = lastEven ? 0 : 10 ** -nd
    return Math.sign(x) * Number((kept + bump).toFixed(nd))
  }
  return Number(x.toFixed(nd))
}

/** A row without its null and undefined members, as the API leaves them out. */
export function compact(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v
  return out
}

/**
 * `Data.__alias_dict__`: field → source key. `_use_alias` renames source keys to fields; when two fields name the same
 * source key the last one wins, and keys the dict does not mention stay as they are.
 */
export function applyAliases(row: Row, aliasDict: Record<string, string>): Row {
  const rev = new Map<string, string>()
  for (const [field, source] of Object.entries(aliasDict)) rev.set(source, field)
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[rev.get(k) ?? k] = v
  return out
}

/** `to_snake_case` from openbb_core.provider.utils.helpers. */
export function toSnakeCase(text: string): string {
  const s1 = text.replace(/(.)([A-Z][a-z]+)/g, '$1_$2')
  return s1.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replaceAll(' ', '_').replaceAll('__', '_')
}

/** `to_snake_case` from openbb_tmx/utils/financials.py: a QuoteMedia statement key in snake case. */
export function statementSnakeCase(name: string): string {
  return name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_').replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, '_').toLowerCase()
}

/** Run `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Params

/** The comma-separated symbols of a param, as the models split `query.symbol`. */
export function listParam(params: NativeParams, key = 'symbol'): string[] {
  const v = params[key]
  const list = Array.isArray(v) ? v : String(v ?? '').split(',')
  return list.map((s) => String(s)).filter((s) => s !== '')
}

export function strParam(params: NativeParams, key: string): string | undefined {
  const v = params[key]
  if (v === undefined || v === null || v === '') return undefined
  return Array.isArray(v) ? v.join(',') : String(v)
}

/**
 * An extra (provider-specific) param as OpenBB's `Query.filter_extra_params` passes it on: a value equal to the route's
 * default is dropped, because FastAPI always sends the default, so the provider's own default applies. The catalog's
 * default is the route's.
 */
export function extraParam(params: NativeParams, key: string, routeDefault: string | number | boolean): string | undefined {
  const v = strParam(params, key)
  return v === undefined || v === String(routeDefault) ? undefined : v
}

/** The params with every extra param that equals its route default removed (see `extraParam`). */
export function withoutRouteDefaults(params: NativeParams, routeDefaults: Record<string, string | number | boolean>): NativeParams {
  const out = { ...params }
  for (const [key, routeDefault] of Object.entries(routeDefaults)) if (extraParam(params, key, routeDefault) === undefined) delete out[key]
  return out
}

/** A Literal param: the value (or the fallback when absent), or the error pydantic raises for anything else. */
export function oneOf<T extends string>(params: NativeParams, key: string, allowed: readonly T[], fallback: T): T {
  const v = strParam(params, key)
  if (v === undefined) return fallback
  if (!(allowed as readonly string[]).includes(v)) throw new TmxError(`Input should be ${allowed.map((a) => `'${a}'`).join(', ')} (${key}: ${v})`)
  return v as T
}

export function boolParam(params: NativeParams, key: string, fallback: boolean): boolean {
  const v = params[key]
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'boolean') return v
  return String(v).toLowerCase() === 'true'
}

export function numParam(params: NativeParams, key: string): number | undefined {
  const v = params[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n
}

/** `normalize_symbol`: the symbol in the form the TMX API expects. */
export function normalizeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase()
  if (['^', '/', '$'].includes(s.slice(0, 1)) || s.includes(':')) return s
  return s.replaceAll('-', '.').replaceAll('.TO', '').replaceAll('.TSX', '')
}

/** The older models' own spelling of the same clean-up. */
export function cleanSymbol(symbol: string): string {
  return symbol.toUpperCase().replaceAll('-', '.').replaceAll('.TO', '').replaceAll('.TSX', '')
}

const ABSENT_URLS = new Set(['', 'nan', 'none', 'null', 'n/a', '-'])

/** `normalize_url`: a website as an absolute URL, or undefined when none was published. */
export function normalizeUrl(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  if (ABSENT_URLS.has(text.toLowerCase())) return undefined
  if (text.includes('://')) return text
  return `https://${text.replace(/^\/+/, '')}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDay(d)
}

/** Python's `date.weekday()`: Monday is 0. */
export function weekday(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}

/**
 * The windows `rrule(WEEKLY, interval=n, dtstart=start, until=end)` makes of a range: a window every `stepDays`, each
 * ending the day before the next starts, the last one ending on `end`. (The models compare the rrule's datetimes with
 * a date, so the end date is always appended.)
 */
export function dateChunks(start: string, end: string, stepDays: number): [string, string][] {
  const dates: string[] = []
  for (let d = start; d <= end; d = addDays(d, stepDays)) dates.push(d)
  if (dates.length === 0) throw new TmxError('The start date is after the end date.')
  dates.push(end)
  const chunks: [string, string][] = []
  for (let i = 0; i < dates.length - 1; i++) chunks.push([dates[i]!, addDays(dates[i + 1]!, -1)])
  chunks[chunks.length - 1]![1] = end
  return chunks
}

function zoneParts(ms: number, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' })
  const out: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value
  return out
}

/** An instant as an aware ISO string in a zone: `2026-09-01T09:30:00-04:00`. */
export function toZonedIso(ms: number, tz: string): string {
  const p = zoneParts(ms, tz)
  const offset = (p.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00'
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`
}

/** The instant (epoch seconds) a wall-clock time has in a zone. */
export function zonedEpoch(day: string, hour: number, minute: number, tz: string): number {
  const wall = Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)
  let guess = wall
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, tz)
    const asUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)
    guess += wall - asUtc
  }
  return Math.floor(guess / 1000)
}

/** The calendar day in a zone for an instant. */
export function zonedDay(ms: number, tz: string): string {
  const p = zoneParts(ms, tz)
  return `${p.year}-${p.month}-${p.day}`
}

// ---------------------------------------------------------------------------------------------------------------------
// TMX GraphQL

/**
 * Post one GraphQL operation to TMX Money and return its `data` (`amake_gql_request`). Errors in the response raise,
 * as the Python does.
 */
export async function gql<T = Row>(ctx: NativeCtx, operation: string, query: string, variables: Row = {}, symbol?: string): Promise<T | null | undefined> {
  const referer = symbol ? `https://money.tmx.com/en/quote/${symbol}` : 'https://money.tmx.com/'
  const body = JSON.stringify({ operationName: operation, variables, query })
  const headers = {
    authority: 'app-money.tmx.com',
    Accept: '*/*',
    'Accept-Language': 'en-CA,en-US;q=0.7,en;q=0.3',
    'Content-Type': 'application/json',
    locale: 'en',
    Origin: 'https://money.tmx.com',
    Referer: referer,
    'User-Agent': BROWSER_UA,
  }
  let text = ''
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.http.response(GQL_URL, { method: 'POST', headers, body, timeoutMs: 120_000 })
    text = await res.text()
    if (attempt < 2 && (res.status === 429 || res.status >= 500) && !text.trimStart().startsWith('{')) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      continue
    }
    break
  }
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    throw new TmxError(`Unexpected TMX response for ${operation}.`)
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TmxError(`Unexpected TMX response for ${operation}.`)
  const errors = (result as Row).errors
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.filter(Boolean).map((e) => String((e as Row).message ?? '')).join('; ')
    throw new TmxError(`TMX GraphQL error for ${operation} -> ${messages}`)
  }
  return (result as Row).data as T | null | undefined
}

const BROWSER_HEADERS = (accept: 'json' | 'text' | 'binary', referer = 'https://money.tmx.com/'): Record<string, string> => ({
  Accept: { json: 'application/json, text/plain, */*', text: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', binary: '*/*' }[accept],
  'Accept-Language': 'en-CA,en-US;q=0.7,en;q=0.3',
  Origin: referer.replace(/\/+$/, ''),
  Referer: referer,
  'User-Agent': BROWSER_UA,
})

/** `get_data_from_url` for a JSON file. */
export function getJson<T = unknown>(ctx: NativeCtx, url: string, referer?: string): Promise<T> {
  return ctx.http.json<T>(url, { headers: BROWSER_HEADERS('json', referer) })
}

/** `get_data_from_url` for a page or a delimited download. */
export function getText(ctx: NativeCtx, url: string, referer?: string): Promise<string> {
  return ctx.http.text(url, { headers: BROWSER_HEADERS('text', referer) })
}

/** Memoise a download unless the caller asked for a fresh one (`use_cache: false`). */
export function cached<T>(ctx: NativeCtx, useCache: boolean, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  return useCache ? ctx.cache(key, ttlMs, load) : load()
}

// ---------------------------------------------------------------------------------------------------------------------
// QuoteMedia (statements, option chains, symbology, the screener)

const TOKEN_TTL_MS = 25 * 60 * 1000

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function qmHeaders(token?: string): Record<string, string> {
  return {
    Accept: '*/*',
    'Accept-Language': 'en',
    Origin: 'https://money.tmx.com',
    Referer: 'https://money.tmx.com/',
    'User-Agent': BROWSER_UA,
    ...(token ? { 'Datatool-Token': token } : {}),
  }
}

/** Mint a datatool token for one QuoteMedia tool (`_mint_token`). */
export async function mintQmToken(ctx: NativeCtx, tool: string): Promise<string> {
  const sid = /^[0-9a-f]{64}$/.test(tool) ? tool : await sha256Hex(tool)
  const url = `${QM_APP_URL}/auth/g/authenticate/dataTool/v0/${QM_WEBMASTER_ID}/${sid}`
  const res = await ctx.http.response(url, { method: 'POST', body: '', headers: qmHeaders(), timeoutMs: 60_000 })
  const payload = (await res.json().catch(() => undefined)) as Row | undefined
  const token = payload?.token
  if (typeof token !== 'string' || !token) throw new TmxError(`QuoteMedia did not authorize the ${tool} tool.`)
  return token
}

/** A datatool token for one QuoteMedia tool (`get_token`), reused for 25 minutes. */
export function qmToken(ctx: NativeCtx, tool: string): Promise<string> {
  return ctx.cache(`tmx:qm-token:${tool}`, TOKEN_TTL_MS, () => mintQmToken(ctx, tool))
}

/** Python's `urllib.parse.urlencode` (quote_plus), with `safe` characters left as they are. */
export function urlencode(params: Record<string, string | number | boolean>, safe = ''): string {
  const enc = (s: string): string => {
    let out = ''
    for (const b of new TextEncoder().encode(s)) {
      const ch = String.fromCharCode(b)
      if (/[A-Za-z0-9_.\-~]/.test(ch) || safe.includes(ch)) out += ch
      else if (ch === ' ') out += '+'
      else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    }
    return out
  }
  return Object.entries(params)
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
    .join('&')
}

/** `get_datatool`: call a QuoteMedia datatool endpoint and return its `results`. */
export async function qmDatatool(ctx: NativeCtx, endpoint: string, tool: string, params: Record<string, string | number | boolean | null | undefined>): Promise<Row> {
  const query: Record<string, string | number | boolean> = { webmasterId: QM_WEBMASTER_ID, qmodTool: tool }
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) query[k] = v === true ? 'true' : v === false ? 'false' : v
  const url = `${QM_APP_URL}/datatool/${endpoint}?${urlencode(query, ',')}`
  const token = await qmToken(ctx, tool)
  const response = await ctx.http.json<Row>(url, { headers: qmHeaders(token) })
  if (!response || typeof response !== 'object' || !('results' in response)) throw new TmxError(`No QuoteMedia results for ${endpoint}.`)
  return response.results as Row
}

export { DAY_MS, HOUR_MS }
