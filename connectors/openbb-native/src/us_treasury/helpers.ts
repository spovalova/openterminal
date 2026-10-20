// Ported from openbb_government_us/treasury/utils/fiscal_data.py and openbb_government_us/utils/serializers.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, the clock comes from ctx.now(), and the
// retry backoff is a timer.
import type { NativeCtx, NativeParams, Row } from '../types.js'

export const FISCAL_DATA_BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/'
const MAX_PAGE_SIZE = 10000
const MAX_RETRIES = 3

/** OpenBB's `EmptyDataError`: the call worked and the source had nothing. */
export class EmptyDataError extends Error {
  constructor(message = 'The request was returned empty.') {
    super(message)
    this.name = 'EmptyDataError'
  }
}

/** `YYYY-MM-DD` of a local calendar date, as `date.isoformat()`. */
export function isoDate(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** `date.today()` (the machine's local date) as a local-midnight Date. */
export function today(ctx: NativeCtx): Date {
  const n = ctx.now()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

/** `date - timedelta(days=n)` on ISO dates (local calendar arithmetic). */
export function shiftDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
}

/** An ISO date string param (`YYYY-MM-DD`) as a local-midnight Date. */
export function parseDate(text: string): Date {
  const [y, m, d] = text.slice(0, 10).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

/** `default_start_date`: the requested start, else the anchor (the end date, or today) minus a trailing window. */
export function defaultStartDate(start: string | undefined, end: string | undefined, lookbackDays: number, ctx: NativeCtx): string {
  if (start !== undefined) return start
  const anchor = end !== undefined ? parseDate(end) : today(ctx)
  return isoDate(shiftDays(anchor, -lookbackDays))
}

/** `build_filters`: `field:operator:value` joined by commas; conditions without a value are left out. */
export function buildFilters(conditions: [string, string, string | undefined][]): string | undefined {
  const parts = conditions.filter(([, , v]) => v !== undefined).map(([f, op, v]) => `${f}:${op}:${v}`)
  return parts.length ? parts.join(',') : undefined
}

type Page = { data?: Row[]; meta?: Record<string, unknown>; error?: unknown; message?: unknown }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * `get_fiscal_data`: every page of a FiscalData table. The literal "null" and blank strings become missing values;
 * an empty table is an EmptyDataError.
 */
export async function getFiscalData(ctx: NativeCtx, endpoint: string, opts: { filters?: string | undefined; sort?: string; pageSize?: number } = {}): Promise<Row[]> {
  const params = [`page[size]=${opts.pageSize ?? MAX_PAGE_SIZE}`]
  if (opts.filters) params.push(`filter=${opts.filters}`)
  if (opts.sort) params.push(`sort=${opts.sort}`)
  const base = `${FISCAL_DATA_BASE}${endpoint}?${params.join('&')}`

  async function fetchPage(pageNumber: number): Promise<Page> {
    const url = `${base}&page[number]=${pageNumber}`
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await ctx.http.json<Page>(url)
        if (response && typeof response === 'object' && 'data' in response) return response
        if (response && typeof response === 'object' && 'error' in response) throw new Error(`FiscalData API error -> ${String(response.error)}: ${String(response.message)}`)
        lastError = new Error(`Unexpected FiscalData response -> ${JSON.stringify(response)}`)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('FiscalData API error')) throw err
        lastError = err
      }
      await sleep(2 ** attempt * 1000)
    }
    throw new Error(`FiscalData request failed after ${MAX_RETRIES} attempts -> ${url}`, { cause: lastError })
  }

  const first = await fetchPage(1)
  const rows: Row[] = [...(first.data ?? [])]
  const totalPages = Number(first.meta?.['total-pages'] ?? 1) || 1
  for (let page = 2; page <= totalPages; page++) rows.push(...((await fetchPage(page)).data ?? []))
  if (rows.length === 0) throw new EmptyDataError()
  const clean = (v: unknown) => (typeof v === 'string' && (v === 'null' || v.trim() === '') ? null : v)
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clean(v)])))
}

/** An optional string param, trimmed to missing when blank. */
export function optString(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  if (v === undefined || v === null) return undefined
  const s = String(v)
  return s === '' ? undefined : s
}

/** A string param that must be one of `allowed` (a pydantic `Literal`), else the default. */
export function literalParam(params: NativeParams, name: string, allowed: readonly string[], fallback: string): string {
  const v = optString(params, name) ?? fallback
  if (!allowed.includes(v)) throw new Error(`1 validation error for query\n${name}\n  Input should be ${allowed.map((a) => `'${a}'`).join(', ')} [input_value='${v}']`)
  return v
}

/** An integer param with the bounds pydantic's `ge`/`le` enforce. */
export function boundedInt(params: NativeParams, name: string, fallback: number, min?: number, max?: number): number {
  const v = optInt(params, name) ?? fallback
  if (!Number.isInteger(v) || (min !== undefined && v < min)) throw new Error(`1 validation error for query\n${name}\n  Input should be greater than or equal to ${min}`)
  if (max !== undefined && v > max) throw new Error(`1 validation error for query\n${name}\n  Input should be less than or equal to ${max}`)
  return v
}

/** An optional integer param. */
export function optInt(params: NativeParams, name: string): number | undefined {
  const v = params[name]
  return v === undefined || v === null || v === '' ? undefined : Number(v)
}

const NULL_TOKENS = new Set(['', '-', '--', '---', '----', 'n/a', 'na', 'null', 'none', 'nan'])

/** `is_null_token`: a source placeholder standing in for null. */
export function isNullToken(value: unknown): boolean {
  return typeof value === 'string' && NULL_TOKENS.has(value.trim().toLowerCase())
}

/** `NullTokenMixin`: placeholder strings become missing before validation. */
export function nullTokensToNone(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, isNullToken(v) ? null : v]))
}

type SortKey = readonly (string | number)[]

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    return a[i]! < b[i]! ? -1 : 1
  }
  return a.length - b.length
}

/** Python's `sorted(rows, key=...)` on a tuple key of strings and numbers; ties keep their order. */
export function sortedAsc<T>(rows: readonly T[], key: (row: T) => SortKey): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((x, y) => compareKeys(x.k, y.k) || x.i - y.i)
    .map((x) => x.row)
}

/** `sorted(rows, key=..., reverse=True)`: descending, and ties still keep their original order. */
export function sortedDesc<T>(rows: readonly T[], key: (row: T) => SortKey): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((x, y) => compareKeys(y.k, x.k) || x.i - y.i)
    .map((x) => x.row)
}
