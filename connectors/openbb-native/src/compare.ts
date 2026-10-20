// Parity between OpenBB's `results` and a native handler's rows. Strict by default: same non-null columns, same
// rows, same values (numbers to 1e-9 relative). A case relaxes it only where the data is live or OpenBB is known to
// be wrong, and says why (cases.ts). Used by the live parity run and by the replay tests.
import type { Row } from './types.js'

export type CompareOptions = {
  /** Columns that identify a row. Default: the first of contract_symbol, symbol+date, date, symbol, id that is unique. */
  keys?: string[]
  /** `exact`: the same rows. `overlap`: rows on both sides are compared and at least `minOverlap` of each side match. */
  rows?: 'exact' | 'overlap'
  minOverlap?: number
  relTol?: number
  absTol?: number
  /**
   * Live columns (prices, sizes, intraday changes, timestamps): both sides must fill them with the same type, values
   * are not compared, because OpenBB and the native side fetch seconds apart. With `liveTol`, numbers must also be
   * that close (relative).
   */
  volatile?: string[]
  liveTol?: number
  /** Columns not compared at all. */
  ignore?: string[]
  /** Share of compared cells that must match; 1 unless the case says otherwise. */
  minCellMatch?: number
}

export type Mismatch = { row: string; column: string; openbb: unknown; native: unknown }

export type CompareResult = {
  ok: boolean
  openbbRows: number
  nativeRows: number
  matchedRows: number
  keys: string[]
  /** Non-null in some OpenBB row, never non-null in a native row. */
  missingColumns: string[]
  /** Non-null in some native row, never in OpenBB's (informational). */
  extraColumns: string[]
  cells: number
  cellMatches: number
  mismatches: Mismatch[]
  problems: string[]
}

const KEY_CANDIDATES: string[][] = [['contract_symbol'], ['symbol', 'date'], ['date'], ['symbol'], ['id']]
const MAX_MISMATCHES = 25

const isNil = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))

function nonNullColumns(rows: readonly Row[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (!isNil(v)) out.add(k)
  return out
}

function keyOf(row: Row, keys: readonly string[]): string {
  return keys.length === 0 ? '' : JSON.stringify(keys.map((k) => normalizeKeyValue(row[k])))
}

function normalizeKeyValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = v.trim()
  // "2026-10-01" and "2026-10-01T00:00:00" name the same day.
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?$/.test(s) ? s.slice(0, 10) : s
}

/** The first candidate key set every OpenBB row fills and no two rows share. */
export function chooseKeys(rows: readonly Row[], given?: string[]): string[] {
  if (given) return given
  for (const cand of KEY_CANDIDATES) {
    if (!rows.every((r) => cand.every((k) => !isNil(r[k])))) continue
    const seen = new Set(rows.map((r) => keyOf(r, cand)))
    if (seen.size === rows.length) return cand
  }
  return []
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/

/** ISO date and datetime strings compared as values: same day, same wall time, or the same instant when both carry a zone. */
function sameIsoString(a: string, b: string): boolean | undefined {
  const ma = ISO_RE.exec(a.trim())
  const mb = ISO_RE.exec(b.trim())
  if (!ma || !mb) return undefined
  const zoneA = ma[3]
  const zoneB = mb[3]
  if (zoneA && zoneB) return Date.parse(a) === Date.parse(b)
  // A zone on one side only never matches: OpenBB's zone-less datetimes are exchange wall time, not an instant.
  if (zoneA || zoneB) return false
  const timeA = (ma[2] ?? '00:00:00').replace(/(\.0+)$/, '')
  const timeB = (mb[2] ?? '00:00:00').replace(/(\.0+)$/, '')
  const pad = (t: string) => (t.length === 5 ? `${t}:00` : t)
  return ma[1] === mb[1] && pad(timeA) === pad(timeB)
}

function sameNumber(a: number, b: number, relTol: number, absTol: number): boolean {
  if (a === b) return true
  const diff = Math.abs(a - b)
  return diff <= absTol || diff <= relTol * Math.max(Math.abs(a), Math.abs(b))
}

export function sameValue(a: unknown, b: unknown, relTol: number, absTol: number): boolean {
  if (isNil(a) && isNil(b)) return true
  if (isNil(a) || isNil(b)) return false
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b, relTol, absTol)
  if (typeof a === 'string' && typeof b === 'string') {
    const iso = sameIsoString(a, b)
    return iso ?? a.trim() === b.trim()
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i], relTol, absTol))
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => !isNil((a as Row)[k]))
    const kb = Object.keys(b as object).filter((k) => !isNil((b as Row)[k]))
    if (ka.length !== kb.length) return false
    return ka.every((k) => sameValue((a as Row)[k], (b as Row)[k], relTol, absTol))
  }
  return a === b
}

export function compareRows(openbb: readonly Row[], native: readonly Row[], opts: CompareOptions = {}): CompareResult {
  const relTol = opts.relTol ?? 1e-9
  const absTol = opts.absTol ?? 1e-12
  const liveTol = opts.liveTol
  const ignore = new Set(opts.ignore ?? [])
  const volatile = new Set(opts.volatile ?? [])
  const mode = opts.rows ?? 'exact'
  const minOverlap = opts.minOverlap ?? (mode === 'exact' ? 1 : 0.9)
  const minCellMatch = opts.minCellMatch ?? 1
  const problems: string[] = []

  const obCols = nonNullColumns(openbb)
  const nvCols = nonNullColumns(native)
  const missingColumns = [...obCols].filter((c) => !nvCols.has(c) && !ignore.has(c)).sort()
  const extraColumns = [...nvCols].filter((c) => !obCols.has(c)).sort()
  if (missingColumns.length) problems.push(`missing columns: ${missingColumns.join(', ')}`)

  const keys = chooseKeys(openbb, opts.keys)
  const pairs: [Row, Row, string][] = []
  if (keys.length === 0) {
    if (mode === 'exact' && openbb.length !== native.length) problems.push(`row count ${native.length}, OpenBB ${openbb.length}`)
    const n = Math.min(openbb.length, native.length)
    for (let i = 0; i < n; i++) pairs.push([openbb[i]!, native[i]!, `#${i}`])
  } else {
    const byKey = new Map<string, Row>()
    for (const r of native) if (!byKey.has(keyOf(r, keys))) byKey.set(keyOf(r, keys), r)
    for (const r of openbb) {
      const k = keyOf(r, keys)
      const n = byKey.get(k)
      if (n) pairs.push([r, n, k])
    }
  }
  const matchedRows = pairs.length
  if (keys.length > 0) {
    if (mode === 'exact' && (matchedRows !== openbb.length || native.length !== openbb.length)) {
      problems.push(`rows: ${matchedRows} of OpenBB's ${openbb.length} matched by ${keys.join('+')}, native has ${native.length}`)
    }
    if (mode === 'overlap') {
      const a = openbb.length ? matchedRows / openbb.length : 1
      const b = native.length ? matchedRows / native.length : 1
      if (a < minOverlap || b < minOverlap) problems.push(`row overlap ${(a * 100).toFixed(0)}% of OpenBB, ${(b * 100).toFixed(0)}% of native; need ${(minOverlap * 100).toFixed(0)}%`)
    }
  }
  if (openbb.length > 0 && native.length === 0) problems.push('native returned no rows')

  let cells = 0
  let cellMatches = 0
  const mismatches: Mismatch[] = []
  const columns = [...obCols].filter((c) => !ignore.has(c))
  for (const [o, n, label] of pairs) {
    for (const c of columns) {
      cells++
      let same: boolean
      if (volatile.has(c)) {
        const a = o[c]
        const b = n[c]
        same = isNil(a) || isNil(b) ? isNil(a) === isNil(b) : typeof a === typeof b && (liveTol === undefined || typeof a !== 'number' || sameNumber(a, b as number, liveTol, absTol))
      } else same = sameValue(o[c], n[c], relTol, absTol)
      if (same) cellMatches++
      else if (mismatches.length < MAX_MISMATCHES) mismatches.push({ row: label, column: c, openbb: o[c], native: n[c] })
    }
  }
  const rate = cells === 0 ? 1 : cellMatches / cells
  if (rate < minCellMatch) problems.push(`${cells - cellMatches} of ${cells} cells differ (${(rate * 100).toFixed(2)}% match, need ${(minCellMatch * 100).toFixed(2)}%)`)

  return { ok: problems.length === 0, openbbRows: openbb.length, nativeRows: native.length, matchedRows, keys, missingColumns, extraColumns, cells, cellMatches, mismatches, problems }
}

/** Rows as they would cross the API: JSON round trip (Dates become ISO strings, undefined disappears). */
export function jsonRows(value: unknown): Row[] {
  if (value === null || value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  return JSON.parse(JSON.stringify(list.filter((r) => r && typeof r === 'object' && !Array.isArray(r)))) as Row[]
}
