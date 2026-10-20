// Shared helpers for the federal_reserve core part. Ported in spirit from openbb_federal_reserve/utils/*.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pandas frames and pydantic models.
import { BROWSER_UA, type RequestOptions } from '../../http.js'
import { parseCsv } from '../../lib/csv.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'

export const DAY_MS = 24 * 3600 * 1000

/** OpenBB's `EmptyDataError`: the API answers it with HTTP 204, which the connector reads as no rows. */
export class EmptyDataError extends Error {
  constructor(message = 'The request was returned empty.') {
    super(message)
    this.name = 'EmptyDataError'
  }
}

/** Handlers answer an `EmptyDataError` with no rows, as the API's 204 does. */
export function emptyAsNoRows(handler: NativeHandler): NativeHandler {
  return async (params, ctx) => {
    try {
      return await handler(params, ctx)
    } catch (err) {
      if (err instanceof EmptyDataError) return []
      throw err
    }
  }
}

/** Headers every request carries (requests sends a browser user agent through OpenBB's `get_user_agent`). */
export const HEADERS: Record<string, string> = { 'User-Agent': BROWSER_UA }

export function request(extra: RequestOptions = {}): RequestOptions {
  return { ...extra, headers: { ...HEADERS, ...extra.headers } }
}

/** `datetime.now().date()` as "YYYY-MM-DD". */
export function today(ctx: NativeCtx): string {
  return ctx.now().toISOString().slice(0, 10)
}

/** An ISO date shifted by whole days. */
export function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function str(params: NativeParams, key: string): string | undefined {
  const v = params[key]
  if (v === undefined || v === null || v === '') return undefined
  return Array.isArray(v) ? v.join(',') : String(v)
}

export function bool(params: NativeParams, key: string, fallback: boolean): boolean {
  const v = params[key]
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'boolean') return v
  return /^(true|1|yes)$/i.test(String(v))
}

export function int(params: NativeParams, key: string): number | undefined {
  const v = params[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

export function list(params: NativeParams, key: string): string[] {
  const v = params[key]
  if (v === undefined || v === null || v === '') return []
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean)
}

/** pandas' `float(x)` on a CSV cell: undefined for an empty, non-numeric or `ND` cell. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s === '' || s === 'ND' || s === 'NA' || s === 'NaN' || s === 'nan') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** A row without its missing values (the API leaves a None out of `results`). */
export function dropNil(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) out[k] = v
  return out
}

export function inRange(date: string, start: string | undefined, end: string | undefined): boolean {
  const d = date.slice(0, 10)
  return (start === undefined || d >= start) && (end === undefined || d <= end)
}

/** Data Download Program CSV (`filetype=csv&layout=seriescolumn`): five metadata lines, then the header row. */
export async function ddpCsv(ctx: NativeCtx, rel: string, series: string): Promise<{ header: string[]; rows: string[][] }> {
  const url = `https://www.federalreserve.gov/datadownload/Output.aspx?rel=${rel}&series=${series}&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn&type=package`
  const text = await ctx.http.text(url, request({ timeoutMs: 60_000 }))
  const all = parseCsv(text)
  return { header: all[5] ?? [], rows: all.slice(6) }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', reg: '®', copy: '©', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', deg: '°', eacute: 'é' }

/** `html.unescape` for the entities the Fed's pages use: the common named ones and numeric references. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]!.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** pydantic's `alias_generators.to_snake`. */
export function snakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([0-9])([A-Z])/g, '$1_$2')
    .replace(/([a-z])([0-9])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

/** pydantic's `alias_generators.to_camel`. */
export function camelCase(s: string): string {
  const pascal = s.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** Python's string ordering (by code point) as a comparator. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `pandas.read_csv(StringIO(text))`: the header row with repeated names made unique (`X`, `X.1`, …), then the records. */
export function readCsvFrame(text: string): { columns: string[]; rows: string[][] } {
  const [header = [], ...rows] = parseCsv(text)
  const seen = new Map<string, number>()
  const columns = header.map((name) => {
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    return n === 0 ? name : `${name}.${n}`
  })
  return { columns, rows }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** `to_datetime(s, format="%b %Y" | "%b %d, %Y", errors="coerce")` as "YYYY-MM-DD", undefined when it does not parse. */
export function parseMonthDate(s: string): string | undefined {
  const m = /^([A-Za-z]{3}) (?:(\d{1,2}), )?(\d{4})$/.exec(s.trim())
  if (!m) return undefined
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1
  if (month === 0) return undefined
  const day = m[2] === undefined ? 1 : Number(m[2])
  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).getUTCDate() !== day ? undefined : iso
}

/** `pandas.to_numeric(s, errors="coerce")` on a text cell. */
export function toNumeric(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const t = s.trim()
  if (t === '' || /^(nan|na|n\/a|null|none)$/i.test(t)) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** Round half to even, as Python's `round()`. */
export function roundHalfEven(x: number, digits = 0): number {
  const f = 10 ** digits
  const y = x * f
  const r = Math.round(y)
  const out = Math.abs(y % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
  return out / f
}
