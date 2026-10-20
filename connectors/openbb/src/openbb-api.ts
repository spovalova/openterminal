// Helpers for talking to a local OpenBB Platform REST API (`openbb-api`, FastAPI on 127.0.0.1:6900):
// config, URL building, the result envelope, and a circuit breaker for when it is not running. The route calls
// live in call.ts and the descriptor generator in descriptors.ts; nothing here knows about frames.
// Probed against OpenBB 5.0.0 on 2026-10-17, 2026-10-18 and 2026-10-19; see docs/notes/openbb-probe.md.
import { HttpError, type Ctx } from '@openterminal/core'
import { z } from 'zod'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:6900'
export const API_PREFIX = '/api/v1'

/** One command installs the unified routers (equity/..., news/...) and the yfinance provider; openbb-api builds on first start. */
export const INSTALL_HINT = 'pip install "openbb[routers]" openbb-yfinance\nopenbb-api'

export const ConfigSchema = z.object({
  /** Where openbb-api listens. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  /**
   * OpenBB provider per route (`equity/price/quote: fmp`), used when a query names none; unset routes get the first
   * keyless provider the route lists (call.ts). Any provider installed on the OpenBB side works; keyed ones need their
   * key in ~/.openbb_platform/user_settings.json. The Data page's per-route overrides do the same thing live.
   */
  providers: z.record(z.string().min(1), z.string().min(1)).default({}),
  /** Basic auth, only when openbb-api runs with --login. */
  username: z.string().optional(),
  password: z.string().optional(),
  /**
   * The TypeScript ports of OpenBB's providers (@openterminal/openbb-native, PLAN.md section 19): `prefer` answers every
   * ported route natively and the rest through the API; `only` never calls the API; `off` always does.
   */
  native: z.enum(['prefer', 'only', 'off']).default('prefer'),
  /** Keys for keyed providers by OpenBB's names (`fred_api_key`, `eia_api_key`, …); also read from FRED_API_KEY etc. */
  credentials: z.record(z.string().min(1), z.string()).default({}),
})
export type Config = z.infer<typeof ConfigSchema>

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
/** Trip the breaker after a connection failure seen outside `get` (the openapi.json fetch in descriptors.ts). */
export const markDown = (now: number = Date.now()): void => {
  downUntil = now + BREAKER_MS
}
/** Clear the breaker after any successful round trip. */
export const markUp = (): void => {
  downUntil = 0
}

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
 * GET one route and return its `results`. A 204 or a null `results` is an empty list.
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
