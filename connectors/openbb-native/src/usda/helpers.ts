// Ported from openbb_government_us/usda/utils/ers_client.py and openbb_government_us/utils/serializers.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: downloads are memoised through ctx.cache instead of a disk cache, the product
// page is not fetched (it only set the cache lifetime), and the Python idioms the ERS parsers lean on (csv.DictReader,
// float(), str.strip(), sorted() on tuples) are small functions here so the ports read like their originals.
import { unzipSync } from 'fflate'
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'

export const ERS_BASE = 'https://www.ers.usda.gov'
const DAY_MS = 24 * 3600 * 1000

/**
 * An ERS media file (`/media/4962/corn.csv`), memoised for a day (`afetch_ers_file`). OpenBB keeps it until the
 * product page's "Next Update" date; a day is the same order and needs no second request.
 */
export function fetchErsFile(ctx: NativeCtx, mediaPath: string): Promise<Uint8Array> {
  return ctx.cache(`usda:ers:${mediaPath}`, DAY_MS, () => ctx.http.bytes(`${ERS_BASE}${mediaPath}`))
}

/** `content.decode("utf-8-sig", errors="replace")`: UTF-8 without a leading BOM. */
export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** An ERS CSV (or other text) file as text. */
export async function fetchErsText(ctx: NativeCtx, mediaPath: string): Promise<string> {
  return decodeText(await fetchErsFile(ctx, mediaPath))
}

/** Every member of a zip archive by name (`zipfile.ZipFile(BytesIO(content))`). */
export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes)
}

/** One member of a zip archive (`archive.read(member)`); throws like Python's KeyError when it is missing. */
export function zipMember(bytes: Uint8Array, member: string): Uint8Array {
  const found = readZip(bytes)[member]
  if (!found) throw new Error(`There is no item named '${member}' in the archive`)
  return found
}

/** A zip member decoded as `utf-8-sig`. */
export function zipText(bytes: Uint8Array, member: string): string {
  return decodeText(zipMember(bytes, member))
}

/** Python's `csv.DictReader`: records keyed by the header exactly as written (names are not trimmed); a short row leaves its last fields undefined. */
export function csvDictRows(text: string, delimiter = ','): Record<string, string | undefined>[] {
  const [header, ...rows] = parseCsv(text, delimiter)
  if (!header) return []
  return rows.map((r) => Object.fromEntries(header.map((name, i) => [name, r[i]])))
}

/** `(row.get(key) or "").strip()`. */
export function cell(row: Record<string, string | undefined>, key: string): string {
  return (row[key] ?? '').trim()
}

const FLOAT_RE = /^[+-]?(?:(?:\d+(?:_\d+)*)?\.\d+(?:_\d+)*|\d+(?:_\d+)*\.?)(?:[eE][+-]?\d+(?:_\d+)*)?$/
const FLOAT_WORD_RE = /^[+-]?(?:inf|infinity|nan)$/i

/** Python's `float(text)`, or undefined where Python raises ValueError. */
export function pyFloat(text: string): number | undefined {
  const s = text.trim()
  if (FLOAT_RE.test(s)) return Number(s.replace(/_/g, ''))
  if (FLOAT_WORD_RE.test(s)) return /nan/i.test(s) ? Number.NaN : s.startsWith('-') ? -Infinity : Infinity
  return undefined
}

/** Python's `int(text)`, or undefined where Python raises ValueError. */
export function pyInt(text: string): number | undefined {
  const s = text.trim()
  return /^[+-]?\d+(?:_\d+)*$/.test(s) ? Number(s.replace(/_/g, '')) : undefined
}

const NULL_TOKENS = new Set(['', '-', '--', '---', '----', 'n/a', 'na', 'null', 'none', 'nan'])

/** `is_null_token`: a source placeholder standing in for null. */
export function isNullToken(value: unknown): boolean {
  return typeof value === 'string' && NULL_TOKENS.has(value.trim().toLowerCase())
}

/** `NullTokenMixin`: placeholder strings become missing before the model sees them. Returns a copy. */
export function nullTokensToNone(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, isNullToken(v) ? null : v]))
}

/** `OmitNoneMixin`: after the null tokens, keys whose value is missing are dropped. */
export function omitNone(row: Row): Row {
  return Object.fromEntries(Object.entries(nullTokensToNone(row)).filter(([, v]) => v !== null && v !== undefined))
}

/** Python's ordering of tuples of numbers and strings (`sorted(..., key=lambda r: (a, b))`); strings by code point. */
export function compareTuples(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    return x < y ? -1 : 1
  }
  return a.length - b.length
}

/** A stable sort by a tuple key (Python's `sorted(rows, key=...)`). */
export function sortedBy<T>(rows: readonly T[], key: (row: T) => readonly (string | number)[]): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((a, b) => compareTuples(a.k, b.k) || a.i - b.i)
    .map((x) => x.row)
}

/** An optional integer param (`start_year`, `end_year`); undefined when absent. */
export function optInt(params: NativeParams, name: string): number | undefined {
  const v = params[name]
  return v === undefined || v === null || v === '' ? undefined : Number(v)
}

/** An optional string param, trimmed; undefined when absent or blank. */
export function optString(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}
