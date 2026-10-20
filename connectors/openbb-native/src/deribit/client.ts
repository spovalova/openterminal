// Ported from openbb_deribit/utils/client.py and the time helpers of utils/helpers.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: requests go through ctx.http without the on-disk aiohttp response cache (the instrument and
// currency lists that rarely change are held with ctx.cache in helpers.ts), and times are text instead of pandas
// Timestamps.
import type { NativeCtx } from '../types.js'

export const BASE_URL = 'https://www.deribit.com/api/v2'
const REQUEST_TIMEOUT_MS = 60_000
const TOO_MANY_REQUESTS = 429

type Params = Record<string, string | number | boolean | null | undefined>

/** The request URL of one public method: parameters with no value are left out, booleans are sent in lower case. */
export function buildUrl(method: string, params: Params = {}): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]): [string, string] => [k, String(v)])).toString()
  const url = `${BASE_URL}/public/${method}`
  return qs ? `${url}?${qs}` : url
}


/** Pauses before asking again when the exchange says the request rate was exceeded (OpenBB does not ask again). */
const RATE_LIMIT_PAUSES_MS = [300, 600, 1200, 2400, 4800]

/** Call one public method and return its `result`. */
export async function request<T = any>(ctx: NativeCtx, method: string, params: Params = {}): Promise<T> {
  let payload: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await ctx.http.response(buildUrl(method, params), { timeoutMs: REQUEST_TIMEOUT_MS })
      if (res.status === TOO_MANY_REQUESTS && attempt < RATE_LIMIT_PAUSES_MS.length) {
        await ctx.sleep(RATE_LIMIT_PAUSES_MS[attempt]!)
        continue
      }
      if (res.status !== 200) {
        throw new Error(`Deribit answered public/${method} with HTTP ${res.status}.${res.status === TOO_MANY_REQUESTS ? ' The request rate was exceeded; narrow the query or retry.' : ''}`)
      }
      payload = JSON.parse(await res.text())
      break
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Deribit answered')) throw error
      throw new Error(`Deribit request failed for public/${method} -> ${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`Unexpected Deribit response for public/${method}.`)
  const body = payload as { error?: unknown; result?: T }
  if (body.error) {
    const detail = body.error as { message?: string; data?: unknown }
    const message = typeof detail === 'object' ? detail.message : detail
    const reason = typeof detail === 'object' ? detail.data : undefined
    throw new Error(`Deribit returned an error for public/${method} -> ${String(message)}${reason ? ` ${JSON.stringify(reason)}` : ''}`)
  }
  return body.result as T
}

/** Call several public methods at once; a call that failed leaves its error in its place, as `asyncio.gather(return_exceptions=True)`. */
export async function gather(ctx: NativeCtx, calls: [method: string, params?: Params][]): Promise<unknown[]> {
  return Promise.all(calls.map(([method, params]) => request(ctx, method, params).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))))
}

/** `isinstance(result, dict)` / `list`, for the results of `gather`. */
export const isRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error)
export const isList = (v: unknown): v is any[] => Array.isArray(v)

// ---------------------------------------------------------------------------------------------------------------
// Times

/** Pydantic's text for a UTC datetime: `2018-08-14T10:24:47Z`, with microseconds when there are any. */
export function utcText(ms: number): string {
  const iso = new Date(ms).toISOString()
  const fraction = ms % 1000 === 0 ? '' : `.${iso.slice(20, 23)}000`
  return `${iso.slice(0, 19)}${fraction}Z`
}

/** `from_timestamp`: milliseconds since the epoch as a UTC datetime (undefined for none). */
export function fromTimestamp(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : utcText(Number(value))
}

/** `from_day_number`: whole days since the epoch as a date. */
export function fromDayNumber(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : new Date(Number(value) * 86_400_000).toISOString().slice(0, 10)
}

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i

/** `to_timestamp`: a date, a datetime (UTC when it names no zone) or the current instant as milliseconds. */
export function toTimestamp(value: unknown): number {
  if (typeof value === 'number') return value
  const text = String(value).trim()
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(ZONED.test(text) ? text.replace(' ', 'T') : `${text.replace(' ', 'T')}Z`)
  if (Number.isNaN(ms)) throw new Error(`Unknown datetime string format, unable to parse: ${text}`)
  return ms
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }

/** An expiration code (`27MAR26`, `6NOV26`) as a date. */
export function expirationDate(code: string): string {
  const m = /^(\d{1,2})([A-Za-z]{3})(\d{2})$/.exec(code)
  const month = m ? MONTHS[m[2]!.toUpperCase()] : undefined
  if (!m || !month) throw new Error(`Unknown datetime string format, unable to parse: ${code}`)
  return `${2000 + Number(m[3])}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`
}

/** The date of a ctx.now() instant (UTC), as `YYYY-MM-DD`. */
export const today = (ctx: NativeCtx): string => ctx.now().toISOString().slice(0, 10)
