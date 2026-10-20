// Shared helpers for provider yfinance. Independent implementation of OpenBB's output for these routes (not derived
// from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
//
// Yahoo answers only requests that look like a browser's: a Chrome user agent, a session cookie from fc.yahoo.com
// and, for most JSON endpoints, the crumb that goes with that cookie. The session is kept in ctx.cache.
import { NativeHttpError, type RequestOptions } from '../http.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'

export const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE_HEADERS = { 'user-agent': YAHOO_UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' }
const SESSION_TTL_MS = 30 * 60 * 1000
const BACKOFF_MS = [1500, 4000, 9000]

export const Q1 = 'https://query1.finance.yahoo.com'
export const Q2 = 'https://query2.finance.yahoo.com'

type Session = { cookie: string; crumb: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Run `attempt`; on HTTP 429 wait a little longer each time and try again (Yahoo rate-limits aggressively). */
export async function withBackoff<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof NativeHttpError) || err.status !== 429 || i >= BACKOFF_MS.length) throw err
      await sleep(BACKOFF_MS[i]!)
    }
  }
}

async function openSession(ctx: NativeCtx): Promise<Session> {
  return withBackoff(async () => {
    const first = await ctx.http.response('https://fc.yahoo.com', { headers: BASE_HEADERS })
    await first.arrayBuffer().catch(() => undefined)
    const cookie = first.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ')
    const res = await ctx.http.response(`${Q1}/v1/test/getcrumb`, { headers: { ...BASE_HEADERS, ...(cookie ? { cookie } : {}) } })
    const crumb = (await res.text()).trim()
    if (res.status === 429) throw new NativeHttpError(429, `${Q1}/v1/test/getcrumb`, crumb)
    if (!res.ok || !crumb || crumb.includes('<') || /too many requests/i.test(crumb)) throw new NativeHttpError(res.status, `${Q1}/v1/test/getcrumb`, crumb)
    return { cookie, crumb }
  })
}

/** The cookie and crumb, cached for half an hour; `generation` forces a new pair after Yahoo refused the old one. */
export function yahooSession(ctx: NativeCtx, generation = 0): Promise<Session> {
  return ctx.cache(`yfinance:session:${generation}`, SESSION_TTL_MS, () => openSession(ctx))
}

export type YahooRequest = Omit<RequestOptions, 'headers'> & { crumb?: boolean; headers?: Record<string, string> }

async function once(ctx: NativeCtx, url: string, opts: YahooRequest, generation: number): Promise<Response> {
  const { crumb: wantCrumb, headers, query, ...rest } = opts
  const session = await yahooSession(ctx, generation)
  const res = await ctx.http.response(url, { ...rest, query: { ...query, ...(wantCrumb ? { crumb: session.crumb } : {}) }, headers: { ...BASE_HEADERS, ...(session.cookie ? { cookie: session.cookie } : {}), ...headers } })
  return res
}

/** A Yahoo request with the session attached; refreshes the session once when Yahoo calls the crumb or cookie invalid. */
export async function yahooResponse(ctx: NativeCtx, url: string, opts: YahooRequest = {}): Promise<Response> {
  let generation = 0
  for (;;) {
    const res = await withBackoff(async () => {
      const r = await once(ctx, url, opts, generation)
      if (r.status === 429) throw new NativeHttpError(429, url, await r.text().catch(() => ''))
      return r
    })
    if ((res.status === 401 || res.status === 403) && generation < 2) {
      generation++
      continue
    }
    return res
  }
}

/** JSON from Yahoo; a non-2xx answer throws NativeHttpError with Yahoo's own error text. */
export async function yahooJson<T = Row>(ctx: NativeCtx, url: string, opts: YahooRequest = {}): Promise<T> {
  const res = await yahooResponse(ctx, url, opts)
  const text = await res.text()
  if (!res.ok) throw new NativeHttpError(res.status, url, text.slice(0, 500))
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`expected JSON from ${url}, got: ${text.slice(0, 200)}`)
  }
}

/** Params as a string list: arrays as they are, a comma separated string split, blanks dropped. */
export function listParam(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v === undefined || v === null ? [] : [String(v)]
  return list.map((s) => String(s).trim()).filter(Boolean)
}

/** Upper-cased symbols from a `symbol` param. */
export function symbolsOf(params: NativeParams, name = 'symbol'): string[] {
  return listParam(params[name]).map((s) => s.toUpperCase())
}

export const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Yahoo wraps most numbers as `{ raw, fmt }`; the raw value, else the value itself. */
export function raw(v: unknown): unknown {
  return isRecord(v) && 'raw' in v ? v.raw : v
}

/** A finite number, or undefined. */
export function num(v: unknown): number | undefined {
  const r = raw(v)
  if (typeof r === 'number' && Number.isFinite(r)) return r
  return undefined
}

/** Drop what pydantic would serialise as None. */
export function compact(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) out[k] = v
  return out
}

/** "YYYY-MM-DD" of a unix timestamp (seconds) in UTC. */
export function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/** The unix timestamp (seconds) of midnight UTC on a "YYYY-MM-DD". */
export function dayStart(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
}

/** A "YYYY-MM-DD" plus whole days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Today in New York, "YYYY-MM-DD", from ctx.now(). */
export function todayNy(ctx: NativeCtx): string {
  return wallParts(Math.floor(ctx.now().getTime() / 1000), 'America/New_York').date
}

/** Date and time of a unix timestamp as the wall clock reads in a time zone. */
export function wallParts(seconds: number, timeZone: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(new Date(seconds * 1000))) p[part.type] = part.value
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` }
}
