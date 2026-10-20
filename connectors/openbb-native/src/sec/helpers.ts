// Ported from openbb_sec/utils/helpers.py, cache.py, ratelimit.py and definitions.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: requests go through ctx.http with a process-wide rate limit, the disk cache is ctx.cache,
// pandas frames are arrays of rows, and only what the ported routes use is here.
import { NativeHttpError, type RequestOptions } from '../http.js'
import type { NativeCtx } from '../types.js'

/** `SEC_HEADERS` / `HEADERS`: the descriptive User-Agent OpenBB sends (the `Host` header is the URL's own). */
export const SEC_USER_AGENT = 'my real company name definitelynot@fakecompany.com'
export const HEADERS: Record<string, string> = { 'User-Agent': SEC_USER_AGENT }
export const SEC_HEADERS: Record<string, string> = HEADERS

const DAY_S = 24 * 3600
/** `_REFERENCE_EXPIRE`: reference lists (tickers, SIC codes) are cached for two days. */
export const REFERENCE_EXPIRE_S = 2 * DAY_S
/** `expire=None` in the Python cache means "until evicted"; a week is as long as a process keeps one. */
export const DEFAULT_EXPIRE_S = 7 * DAY_S

// ---------------------------------------------------------------------------------------------------------------
// Rate limit (ratelimit.py): EDGAR allows about ten requests a second; OpenBB spaces them 1/9 s apart process-wide.
// ---------------------------------------------------------------------------------------------------------------

const REQUEST_INTERVAL_MS = 1000 / 9
let nextSlot = 0
/** Contexts whose responses came from a recording: nothing to protect there, so no waiting. */
const replaying = new WeakSet<NativeCtx>()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait `ms` between batches of requests, as OpenBB's `asyncio.sleep` does; not while replaying a recording. */
export async function pause(ctx: NativeCtx, ms: number): Promise<void> {
  if (!replaying.has(ctx)) await sleep(ms)
}

async function secRateLimit(ctx: NativeCtx): Promise<void> {
  if (replaying.has(ctx)) return
  const now = performance.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + REQUEST_INTERVAL_MS
  if (at > now) await sleep(at - now)
}

export type SecRequestOptions = Omit<RequestOptions, 'headers'> & { headers?: Record<string, string> }

/** The raw response of a rate-limited SEC request (`sec_amake_request`); the caller checks the status. */
export async function secResponse(ctx: NativeCtx, url: string, opts: SecRequestOptions = {}): Promise<Response> {
  const headers = { ...HEADERS, ...opts.headers }
  for (let attempt = 0; ; attempt++) {
    await secRateLimit(ctx)
    const res = await ctx.http.response(url, { ...opts, headers })
    // A response built by the replay layer has no URL; a real one always does.
    if (res.url === '') replaying.add(ctx)
    if (res.status === 429 && attempt < 2 && !replaying.has(ctx)) {
      await sleep(1500 * (attempt + 1))
      continue
    }
    return res
  }
}

/** How a response body becomes a value: `sec` is `sec_callback` (JSON, HTML as latin-1, otherwise text). */
export type SecBodyKind = 'json' | 'text' | 'latin1' | 'bytes' | 'sec'

/** Bytes as latin-1 text: every byte is the code point of the same value (not windows-1252, as TextDecoder would). */
export function decodeLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1')
}

async function readBody(res: Response, kind: SecBodyKind): Promise<unknown> {
  if (kind === 'bytes') return new Uint8Array(await res.arrayBuffer())
  if (kind === 'latin1') return decodeLatin1(new Uint8Array(await res.arrayBuffer()))
  if (kind === 'text') return res.text()
  const contentType = res.headers.get('content-type') ?? ''
  if (kind === 'json' || contentType.includes('application/json')) return res.json()
  if (contentType.includes('text/html')) return decodeLatin1(new Uint8Array(await res.arrayBuffer()))
  return res.text()
}

export type BodyOf<K extends SecBodyKind> = K extends 'bytes' ? Uint8Array : K extends 'json' ? unknown : K extends 'sec' ? unknown : string

/**
 * `cached_request` / `cached_text` / `cached_bytes`: one SEC request, memoised for `expireS` seconds unless
 * `useCache` is false. A status of 400 or more throws, as OpenBB's checked callback does.
 */
export async function cachedRequest<K extends SecBodyKind = 'json'>(
  ctx: NativeCtx,
  url: string,
  opts: SecRequestOptions & { kind?: K; useCache?: boolean; expireS?: number } = {},
): Promise<BodyOf<K>> {
  const { kind = 'json' as K, useCache = true, expireS = DEFAULT_EXPIRE_S, ...request } = opts
  const load = async (): Promise<BodyOf<K>> => {
    const res = await secResponse(ctx, url, request)
    if (res.status >= 400) throw new NativeHttpError(res.status, url, '')
    return (await readBody(res, kind)) as BodyOf<K>
  }
  if (!useCache) return load()
  const method = (request.method ?? 'GET').toUpperCase()
  const body = typeof request.body === 'string' ? request.body : request.body === undefined ? '' : JSON.stringify(request.body)
  return ctx.cache(`sec:${method} ${url}${body ? ` ${body}` : ''} ::${kind}`, expireS * 1000, load)
}

// ---------------------------------------------------------------------------------------------------------------
// Directories (helpers.py)
// ---------------------------------------------------------------------------------------------------------------

export type Company = { cik: string; symbol: string; name: string }

/** `get_all_companies`: every ticker, company name and CIK registered with the SEC, in the SEC's order. */
export async function getAllCompanies(ctx: NativeCtx, useCache = true): Promise<Company[]> {
  const response = await cachedRequest(ctx, 'https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS, useCache, expireS: REFERENCE_EXPIRE_S })
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Empty or invalid response from SEC company tickers endpoint.')
  const out: Company[] = []
  for (const row of Object.values(response as Record<string, Record<string, unknown>>)) {
    const values = Object.values(row)
    if (values.length !== 3) throw new Error(`Unexpected SEC response format. Expected 3 fields, got ${values.length}: ${Object.keys(row).join(', ')}`)
    out.push({ cik: String(values[0]), symbol: String(values[1]), name: String(values[2]) })
  }
  return out
}

export type FundListing = { cik: string; seriesId: string; classId: string; symbol: string }

/** `get_mf_and_etf_map`: mutual fund and ETF tickers with their CIK, series and class ids. */
export async function getMfAndEtfMap(ctx: NativeCtx, useCache = true): Promise<FundListing[]> {
  const response = (await cachedRequest(ctx, 'https://www.sec.gov/files/company_tickers_mf.json', { kind: 'sec', headers: SEC_HEADERS, useCache, expireS: REFERENCE_EXPIRE_S })) as { fields: string[]; data: unknown[][] }
  const at = (name: string) => response.fields.indexOf(name)
  const [cik, seriesId, classId, symbol] = [at('cik'), at('seriesId'), at('classId'), at('symbol')]
  return response.data.map((r) => ({ cik: String(r[cik]), seriesId: String(r[seriesId]), classId: String(r[classId]), symbol: String(r[symbol]) }))
}

/** `get_all_ciks`: every entity name in EDGAR's CIK lookup file with its CIK (a 40 MB download). */
export async function getAllCiks(ctx: NativeCtx, useCache = true): Promise<{ Institution: string; 'CIK Number': string }[]> {
  const data = await cachedRequest(ctx, 'https://www.sec.gov/Archives/edgar/cik-lookup-data.txt', { kind: 'latin1', headers: SEC_HEADERS, useCache, expireS: REFERENCE_EXPIRE_S, timeoutMs: 180_000 })
  const out: { Institution: string; 'CIK Number': string }[] = []
  for (const line of data.split('\n')) {
    // DataFrame rows are the first two ":"-separated cells; a row of one cell (the empty last line) has no CIK and is dropped.
    const row = line.split(':')
    if (row.length < 2) continue
    out.push({ Institution: row[0]!, 'CIK Number': row[1]! })
  }
  return out
}

/** `symbol_map`: the ten-digit CIK of a ticker (companies first, then funds), or "" when the SEC does not know it. */
export async function symbolMap(ctx: NativeCtx, symbol: string, useCache = true): Promise<string> {
  const sym = symbol.toUpperCase().replaceAll('.', '-')
  const company = (await getAllCompanies(ctx, useCache)).find((c) => c.symbol === sym)
  const cik = company ? company.cik : (await getMfAndEtfMap(ctx, useCache)).find((f) => f.symbol === sym)?.cik
  if (cik === undefined) return ''
  return cik.length < 10 ? '0'.repeat(10 - cik.length) + cik : cik
}

/** `cik_map`: the ticker of a CIK (given as an integer or string), or OpenBB's error text when it has none. */
export async function cikMap(ctx: NativeCtx, cik: string | number, useCache = true): Promise<string> {
  const _cik = typeof cik === 'number' ? String(cik) : cik.replace(/^0+/, '')
  const company = (await getAllCompanies(ctx, useCache)).find((c) => c.cik === _cik)
  return company ? company.symbol : `Error: CIK, ${_cik}, does not have a unique ticker.`
}

// ---------------------------------------------------------------------------------------------------------------
// Small Python and pandas behaviours the ports share
// ---------------------------------------------------------------------------------------------------------------

/** `Series.str.contains(pattern, case=False)`: pandas reads the pattern as a regular expression. */
export function containsIgnoreCase(pattern: string): (s: string) => boolean {
  const re = new RegExp(pattern, 'i')
  return (s) => re.test(s)
}

/** A CIK as the ten-digit string EDGAR's submissions API wants. */
export function padCik(cik: string | number): string {
  const s = String(cik)
  return s.length < 10 ? '0'.repeat(10 - s.length) + s : s
}

/** What `str.split()` splits on: Python's whitespace, which is not quite JavaScript's (it has no U+FEFF, but has U+001C to U+001F). */
const PY_WHITESPACE = new RegExp(
  `[${[...[9, 10, 11, 12, 13, 32, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000], ...Array.from({ length: 11 }, (_, i) => 0x2000 + i)].map((c) => `\\u{${c.toString(16)}}`).join('')}]+`,
  'u',
)

/** `" ".join(str(value).split())`: Python's whitespace collapsed to single spaces. */
export function collapseWhitespace(value: string): string {
  return value.split(PY_WHITESPACE).filter(Boolean).join(' ')
}

/** `urllib.parse.urlencode`: quote_plus on keys and values (spaces become "+"; only letters, digits and `_.-~` stay). */
export function urlencode(params: Record<string, string | number>): string {
  const quote = (s: string) =>
    encodeURIComponent(s)
      .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replaceAll('%20', '+')
  return Object.entries(params)
    .map(([k, v]) => `${quote(k)}=${quote(String(v))}`)
    .join('&')
}
