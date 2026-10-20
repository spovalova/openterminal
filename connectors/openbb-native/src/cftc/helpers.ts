// Shared by the CFTC routes. Ported from openbb_cftc/utils/helpers.py, utils/constants.py and the Socrata handling
// of models/cot*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: requests go through ctx.http, and the helpers
// Python gets from its standard library (round, urllib.parse.quote) are written out.
import type { NativeCtx } from '../types.js'

export const SOCRATA = 'https://publicreporting.cftc.gov/resource'

/** The Socrata dataset of each COT report (`reports_dict`). */
export const REPORTS: Record<string, string> = {
  legacy_futures_only: '6dca-aqww',
  legacy_combined: 'jun7-fc8e',
  disaggregated_futures_only: '72hh-3qpy',
  disaggregated_combined: 'kh3c-gbw2',
  tff_futures_only: 'gpe5-46if',
  tff_combined: 'yw9f-hn96',
  supplemental: '4zgm-a668',
}

/** `report_type` and `futures_only` as the key of REPORTS. */
export function reportKey(reportType: string, futuresOnly: boolean): string {
  let key = reportType.replace('financial', 'tff')
  if (key !== 'supplemental') key += futuresOnly ? '_futures_only' : '_combined'
  return key
}

/** `urllib.parse.quote(s)`: everything but letters, digits, `_.-~` and `/` is percent-encoded as UTF-8. */
export function pyQuote(s: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte)
    out += /[A-Za-z0-9_.\-~/]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * Python's `round(x, ndigits)`: the exact binary value rounded half to even. JavaScript's toFixed rounds an exact
 * tie (12.25 → 12.3) away from zero where Python gives 12.2.
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) return x
  const negative = x < 0 || Object.is(x, -0)
  const exact = Math.abs(x).toFixed(100)
  const dot = exact.indexOf('.')
  const whole = exact.slice(0, dot)
  const frac = exact.slice(dot + 1)
  const kept = frac.slice(0, ndigits)
  const rest = frac.slice(ndigits)
  let digits = BigInt(whole + kept)
  const first = rest.charCodeAt(0) - 48
  const tail = rest.slice(1)
  const up = first > 5 || (first === 5 && (/[1-9]/.test(tail) || digits % 2n === 1n))
  if (up) digits += 1n
  const text = digits.toString().padStart(ndigits + 1, '0')
  const value = Number(`${text.slice(0, text.length - ndigits)}${ndigits ? '.' + text.slice(text.length - ndigits) : ''}`)
  return negative ? -value : value
}

/** `float(x)` for a reported figure; anything that is not a number is null (`_number`). */
export function reportedNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const t = value.trim()
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null
}

export type SocrataRow = Record<string, unknown>

/**
 * One Socrata query: the URL as Python builds it (spaces and quotes unescaped; fetch escapes them), the app token
 * appended when there is one. The portal answers an outage with a non-JSON page, which OpenBB reports as such.
 */
export async function socrataJson(ctx: NativeCtx, url: string): Promise<unknown> {
  const token = ctx.credential('cftc_app_token')
  // aiohttp (yarl) re-quotes a `%` that does not start an escape (`like UPPER('%silver%')`); fetch would leave it as is.
  const full = token ? `${url}&$$app_token=${token}` : url
  const requestUrl = full.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
  const res = await ctx.http.response(requestUrl, { timeoutMs: 120_000 })
  const type = res.headers.get('content-type') ?? ''
  if (res.status !== 200 || !type.includes('json')) {
    throw new Error(`The CFTC public reporting API returned HTTP ${res.status} (${type || 'no content type'}). The portal is likely undergoing maintenance or is temporarily unavailable - try again shortly.`)
  }
  return res.json()
}

/** Python's `datetime.weekday()`: Monday is 0. */
export const weekday = (d: Date): number => (d.getUTCDay() + 6) % 7
