// Ported from openbb_government_us/treasury/utils/usaspending.py and utils/recipient.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: requests go through ctx.http, and the client's own failures are plain errors.
import type { RequestOptions } from '../http.js'
import type { NativeCtx, Row } from '../types.js'

const BASE_URL = 'https://api.usaspending.gov/api/v2/'

/** The timeout the larger USAspending calls pass (`REQUEST_TIMEOUT`); the rest use the HTTP client's default of 10 s. */
export const REQUEST_TIMEOUT_MS = 90_000
const DEFAULT_TIMEOUT_MS = 10_000

/** `urllib.parse.quote(text, safe="")`. */
export function pyQuote(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function request(ctx: NativeCtx, path: string, opts: RequestOptions): Promise<unknown> {
  const url = `${BASE_URL}${path}`
  let body: unknown
  try {
    // aiohttp reads the JSON body whatever the status; an error payload comes back as `{"detail": ...}`.
    const res = await ctx.http.response(url, { timeoutMs: DEFAULT_TIMEOUT_MS, ...opts })
    const text = await res.text()
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`Attempt to decode JSON with unexpected mimetype: ${res.headers.get('content-type') ?? ''}`)
    }
  } catch (err) {
    const e = err as Error
    throw new Error(`USAspending request failed -> ${url} -> ${e.name}: ${e.message}`, { cause: err })
  }
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== 'object') throw new Error(`Unexpected USAspending response -> ${url} -> ${JSON.stringify(body)}`)
  if ('detail' in (body as Row)) throw new Error(`USAspending API error -> ${JSON.stringify((body as Row).detail)}`)
  return body
}

/** `get_usaspending`: a GET under the v2 base; the decoded object or array. */
export async function getUsaspending(ctx: NativeCtx, path: string, opts: { timeoutMs?: number } = {}): Promise<Row> {
  return (await request(ctx, path, { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })) as Row
}

/** `post_usaspending`: a POST with a JSON body under the v2 base. */
export async function postUsaspending(ctx: NativeCtx, path: string, payload: Row, opts: { timeoutMs?: number } = {}): Promise<Row> {
  return (await request(ctx, path, { method: 'POST', body: payload, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })) as Row
}

/** `normalize_recipient_id`: `<uuid>-<P|C|R>` with a lower-case hash and an upper-case level. */
export function normalizeRecipientId(recipientId: string): string {
  const value = (recipientId || '').trim()
  const at = value.lastIndexOf('-')
  const head = at >= 0 ? value.slice(0, at) : ''
  const level = at >= 0 ? value.slice(at + 1) : ''
  if (at < 0 || !['P', 'C', 'R'].includes(level.toUpperCase())) {
    throw new Error(`Invalid recipient_id: '${recipientId}'. It must end with a recipient level, one of '-P' (parent), '-C' (child), or '-R' (neither), e.g. 'ab4b0d9e-2a56-a67b-1fb7-b54a68b680ed-P'.`)
  }
  return `${head.toLowerCase()}-${level.toUpperCase()}`
}

/** `get_profile`: a recipient's profile. */
export function getProfile(ctx: NativeCtx, recipientId: string): Promise<Row> {
  return getUsaspending(ctx, `recipient/${normalizeRecipientId(recipientId)}/`, { timeoutMs: REQUEST_TIMEOUT_MS })
}
