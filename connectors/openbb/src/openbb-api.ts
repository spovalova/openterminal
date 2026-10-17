// Helpers for talking to a local OpenBB Platform REST API (`openbb-api`, FastAPI on 127.0.0.1:6900):
// config, URL building, the result envelope, a circuit breaker for when it is not running, and the
// time and provider maps. Handlers live in index.ts; nothing here knows about frames.
// Probed against OpenBB 5.0.0 on 2026-10-17; see docs/notes/openbb-probe.md.
import { HttpError, type Ctx, type Interval, type Kind, type Range } from '@terminal/core'
import { z } from 'zod'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:6900'
export const API_PREFIX = '/api/v1'

/** One command installs the unified routers (equity/..., news/...) and the yfinance provider; openbb-api builds on first start. */
export const INSTALL_HINT = 'pip install "openbb[routers]" openbb-yfinance\nopenbb-api'

export const ConfigSchema = z.object({
  /** Where openbb-api listens. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  /** OpenBB provider per kind; unset kinds use DEFAULT_PROVIDERS. Any provider installed on the OpenBB side works, keyed ones need their key in ~/.openbb_platform/user_settings.json. */
  providers: z.object({ search: z.string().min(1), quote: z.string().min(1), ohlcv: z.string().min(1), news: z.string().min(1), earnings: z.string().min(1) }).partial().default({}),
  /** Basic auth, only when openbb-api runs with --login. */
  username: z.string().optional(),
  password: z.string().optional(),
})
export type Config = z.infer<typeof ConfigSchema>

/**
 * Keyless providers that answered each kind best in the probe. yfinance has no equity search and its company news
 * returns 204; nasdaq search carries the listing exchange, nasdaq news and earnings carry publisher and session.
 */
export const DEFAULT_PROVIDERS: Record<Kind, string> = { search: 'nasdaq', quote: 'yfinance', ohlcv: 'yfinance', news: 'nasdaq', earnings: 'nasdaq' }

export function providerFor(config: Config, kind: Kind): string {
  return config.providers[kind] ?? DEFAULT_PROVIDERS[kind]
}

/** Providers whose unified routes take `symbol=A,B`. Others are called once per symbol. */
export const MULTI_SYMBOL_PROVIDERS: ReadonlySet<string> = new Set(['yfinance', 'nasdaq', 'tmx', 'fmp', 'polygon', 'intrinio', 'tiingo'])

/** Our interval names → the provider's token, where they differ. Unknown providers get ours unchanged. */
const PROVIDER_INTERVALS: Record<string, Partial<Record<Interval, string>>> = {
  yfinance: { '1w': '1W' },
  fmp: { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1hour', '1d': '1day', '1w': '1week' },
  polygon: { '1w': '1W' },
}
export function toProviderInterval(provider: string, interval: Interval): string {
  return PROVIDER_INTERVALS[provider]?.[interval] ?? interval
}

// ---- envelope and errors ----

export type Envelope<T> = { results: T[] | null; provider?: string; warnings?: unknown; extra?: unknown }

export const notRunning = (baseUrl: string): string => `OpenBB API not running at ${baseUrl}. Install and start it:\n${INSTALL_HINT}`

/** FastAPI puts validation errors in `detail` as a list and other errors as a string. */
export function describeHttpError(err: HttpError): string {
  let detail = err.body
  try {
    const parsed = JSON.parse(err.body) as { detail?: unknown }
    const d = parsed.detail
    if (typeof d === 'string') detail = d
    else if (Array.isArray(d)) detail = d.map((x) => (x && typeof x === 'object' && 'msg' in x ? String((x as { msg: unknown }).msg) : JSON.stringify(x))).join('; ')
  } catch {
    // not JSON, keep the body
  }
  const path = new URL(err.url).pathname.replace(API_PREFIX, '')
  return `OpenBB ${err.status} on ${path}: ${detail.slice(0, 300)}`
}

/** fetch throws a TypeError("fetch failed") with an ECONNREFUSED cause when nothing listens on the port. */
export function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof HttpError) return false
  const cause = (err as { cause?: unknown }).cause
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : ''
  return err.name === 'TypeError' || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(`${err.message} ${code}`)
}

// ---- circuit breaker ----

/** After a connection failure, every call fails immediately for this long so the registry falls back at no cost. */
export const BREAKER_MS = 30_000
export const REQUEST_TIMEOUT_MS = 15_000

let downUntil = 0
export const resetBreaker = (): void => {
  downUntil = 0
}
export const isDown = (now: number = Date.now()): boolean => now < downUntil

export type GetOptions = { now?: () => number; bypassBreaker?: boolean; timeoutMs?: number }

export function buildUrl(baseUrl: string, path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return `${baseUrl.replace(/\/+$/, '')}${API_PREFIX}${path}${s ? `?${s}` : ''}`
}

export function authHeaders(config: Config): Record<string, string> {
  if (!config.username || !config.password) return {}
  return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}` }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * GET one unified route and return its `results`. A 204 or a null `results` is an empty list.
 * Connection failures trip the breaker; HTTP errors become one readable line.
 */
export async function get<T>(ctx: Ctx<Config>, path: string, params: Record<string, string | number | undefined>, opts: GetOptions = {}): Promise<T[]> {
  const now = opts.now ?? Date.now
  const { baseUrl } = ctx.config
  if (!opts.bypassBreaker && isDown(now())) throw new Error(notRunning(baseUrl))
  const url = buildUrl(baseUrl, path, params)
  let body: unknown
  try {
    body = await ctx.http.get(url, { signal: withTimeout(ctx.signal, opts.timeoutMs ?? REQUEST_TIMEOUT_MS), headers: authHeaders(ctx.config) })
  } catch (err) {
    if (err instanceof HttpError) throw new Error(describeHttpError(err), { cause: err })
    if (ctx.signal?.aborted) throw err
    if (isConnectionFailure(err)) {
      downUntil = now() + BREAKER_MS
      ctx.log(`not reachable at ${baseUrl}; skipping it for ${BREAKER_MS / 1000}s`)
      throw new Error(notRunning(baseUrl), { cause: err })
    }
    throw err
  }
  downUntil = 0
  if (body === '' || body === null || body === undefined) return []
  if (typeof body !== 'object') throw new Error(`OpenBB returned a non-JSON body for ${path}`)
  const env = body as Envelope<T>
  if (!('results' in env)) throw new Error(`OpenBB response for ${path} has no results field`)
  return env.results ?? []
}

/** coverage/providers is `{ provider: [routes] }`, not an envelope. A success clears the breaker; a connection failure explains how to start the API. */
export async function probeProviders(ctx: Ctx<Config>, timeoutMs = 2_000): Promise<string[]> {
  const url = buildUrl(ctx.config.baseUrl, '/coverage/providers', {})
  let body: unknown
  try {
    body = await ctx.http.get(url, { signal: withTimeout(ctx.signal, timeoutMs), headers: authHeaders(ctx.config) })
  } catch (err) {
    if (err instanceof HttpError) throw new Error(describeHttpError(err), { cause: err })
    if (isConnectionFailure(err)) throw new Error(notRunning(ctx.config.baseUrl), { cause: err })
    throw err
  }
  downUntil = 0
  return body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as object) : []
}

// ---- time ----

export const NY = 'America/New_York'
const partsFormat = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

export function nyParts(at: Date): Parts {
  const out: Partial<Parts> = {}
  for (const p of partsFormat.formatToParts(at)) {
    if (p.type === 'year') out.year = Number(p.value)
    else if (p.type === 'month') out.month = Number(p.value)
    else if (p.type === 'day') out.day = Number(p.value)
    else if (p.type === 'hour') out.hour = Number(p.value) % 24
    else if (p.type === 'minute') out.minute = Number(p.value)
    else if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value] ?? 0
  }
  return out as Parts
}

/** The instant at which the New York wall clock reads the given date and time (DST aware). */
export function nyWallToUtc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  for (let i = 0; i < 2; i++) {
    const p = nyParts(new Date(guess))
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0)
    guess += Date.UTC(year, month - 1, day, hour, minute, 0) - asUtc
  }
  return guess
}

/**
 * OpenBB dates → epoch ms. Daily and weekly rows are `YYYY-MM-DD` (New York midnight); intraday rows are
 * zone-less `YYYY-MM-DDTHH:MM:SS` in exchange time (New York); anything with a zone is parsed as such.
 */
export function parseOpenbbTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/.exec(value)
  if (m) {
    const ms = nyWallToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))
    return ms + Math.round(Number(m[6] ?? 0) * 1000)
  }
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

export function nyDate(at: Date): string {
  const { year, month, day } = nyParts(at)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function minusMonths(at: Date, months: number): Date {
  const d = new Date(at.getTime())
  d.setUTCMonth(d.getUTCMonth() - months)
  return d
}

/** Calendar date (New York) of the most recent regular session: today if a weekday past 09:30 ET, else the previous weekday. */
export function lastSessionDate(now: Date): string {
  let at = now
  const p = nyParts(at)
  if (p.weekday >= 1 && p.weekday <= 5 && (p.hour > 9 || (p.hour === 9 && p.minute >= 30))) return nyDate(at)
  for (let i = 0; i < 7; i++) {
    at = new Date(at.getTime() - 86_400_000)
    const q = nyParts(at)
    if (q.weekday >= 1 && q.weekday <= 5) return nyDate(at)
  }
  return nyDate(at)
}

/** Our range → `start_date` for equity/price/historical, matching the yahoo connector's windows. */
export function rangeStartDate(range: Range, now: Date): string {
  switch (range) {
    case '1d':
      return lastSessionDate(now)
    case '5d':
      return nyDate(new Date(now.getTime() - 7 * 86_400_000))
    case '1mo':
      return nyDate(minusMonths(now, 1))
    case '3mo':
      return nyDate(minusMonths(now, 3))
    case '6mo':
      return nyDate(minusMonths(now, 6))
    case '1y':
      return nyDate(minusMonths(now, 12))
    case '5y':
      return nyDate(minusMonths(now, 60))
  }
}

// ---- field maps ----

/** nasdaq search "Listing Exchange" codes. */
const LISTING_EXCHANGES: Record<string, string> = { Q: 'NASDAQ', N: 'NYSE', A: 'NYSE American', P: 'NYSE Arca', Z: 'Cboe BZX', V: 'IEX' }

export function exchangeName(row: Record<string, unknown>): string | null {
  const direct = row.exchange
  if (typeof direct === 'string' && direct) return direct
  const code = row['Listing Exchange'] ?? row.listing_exchange
  if (typeof code === 'string' && code) return LISTING_EXCHANGES[code] ?? code
  return null
}

/** Provider session words (nasdaq `reporting_time`, yfinance `timing`, fmp `time`) → catalog `session`. */
export function toSession(value: unknown): 'bmo' | 'amc' | null {
  if (typeof value !== 'string') return null
  const v = value.toLowerCase()
  if (v === 'bmo' || v.includes('pre') || v.includes('before')) return 'bmo'
  if (v === 'amc' || v.includes('after') || v.includes('post')) return 'amc'
  return null
}

/** nasdaq `market_status` → catalog `market_state`; providers without one give null. */
export function toMarketState(value: unknown): 'PRE' | 'REGULAR' | 'POST' | 'CLOSED' | null {
  if (typeof value !== 'string') return null
  const v = value.toLowerCase()
  if (v.includes('pre')) return 'PRE'
  if (v.includes('after') || v.includes('post')) return 'POST'
  if (v.includes('open') || v.includes('regular')) return 'REGULAR'
  if (v.includes('closed')) return 'CLOSED'
  return null
}

export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Percent change: providers give a fraction (`change_percent: -0.0563`); fall back to last and previous close. */
export function changePct(row: Record<string, unknown>, price: number | null): number | null {
  const direct = num(row.change_percent)
  if (direct !== null) return Math.round(direct * 100 * 1e4) / 1e4
  const prev = num(row.prev_close)
  if (price === null || prev === null || prev === 0) return null
  return Math.round(((price - prev) / prev) * 100 * 1e4) / 1e4
}

/**
 * Run `fn` once with every symbol when the provider takes a comma-separated list, else once per symbol in parallel.
 * A failing symbol is logged and skipped; the call only throws when every call failed.
 */
export async function bySymbols<R>(ctx: Ctx<Config>, provider: string, symbols: string[], fn: (symbolParam: string) => Promise<R[]>): Promise<R[]> {
  const batches = MULTI_SYMBOL_PROVIDERS.has(provider) ? [symbols.join(',')] : symbols
  const results = await Promise.allSettled(batches.map(fn))
  const rows: R[] = []
  const failures: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rows.push(...r.value)
    else failures.push(`${batches[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
  })
  if (failures.length === results.length) throw new Error(failures.length === 1 ? failures[0]!.replace(/^[^:]+: /, '') : `openbb: every symbol failed (${failures.join('; ')})`)
  failures.forEach((f) => ctx.log(`skipped ${f}`))
  return rows
}
