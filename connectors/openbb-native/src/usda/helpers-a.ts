// Shared by the part A yearbook ports (oil crops, rice, sugar and sweeteners). Ported from the `_classify_dims`,
// `_projected_columns`, `_is_determined` and `_drop_redundant_dims` static methods those OpenBB models repeat
// (openbb_government_us/usda/models/{oil_crops,rice,sugar_sweeteners}_yearbook.py, OpenBB Platform 5.0.0, Apache-2.0);
// modified: one copy over plain records.
import { isNullToken } from './helpers.js'

/** A long-format observation: dimension fields are strings or missing. */
export type Rec = Record<string, string | number | null>

/** The widest a table may grow before a dimension is kept in the row label (`MAX_WIDE_COLUMNS`). */
export const MAX_WIDE_COLUMNS = 60

/** `_dim_value`: a dimension value, with placeholder tokens read as absent. */
export function dimValue(record: Rec, field: string): string | null {
  const v = record[field]
  return isNullToken(v) ? null : (v as string | null)
}

/** How many series each member of a dimension appears in, on average, against the dimension's size. */
function partitionStats(rows: readonly Rec[], field: string, seriesKey: string): { distinct: Set<string>; seriesMembers: Map<string, Set<string>>; spread: number } {
  const distinct = new Set<string>()
  const seriesMembers = new Map<string, Set<string>>()
  for (const r of rows) {
    const member = dimValue(r, field)
    if (member === null) continue
    distinct.add(member)
    const series = String(r[seriesKey])
    let set = seriesMembers.get(series)
    if (!set) seriesMembers.set(series, (set = new Set()))
    set.add(member)
  }
  let total = 0
  for (const s of seriesMembers.values()) total += s.size
  return { distinct, seriesMembers, spread: seriesMembers.size ? total / seriesMembers.size : 0 }
}

/** Oil crops: a folded dimension becomes a column prefix when it partitions the series, else it labels the rows. */
export function classifyDimsSimple(rows: readonly Rec[], foldDims: readonly string[], seriesKey: string): { columnDims: string[]; rowDims: string[] } {
  const columnDims: string[] = []
  const rowDims: string[] = []
  for (const field of foldDims) {
    const { distinct, seriesMembers, spread } = partitionStats(rows, field, seriesKey)
    if (distinct.size > 0 && seriesMembers.size > 0 && spread <= 0.6 * distinct.size) columnDims.push(field)
    else rowDims.push(field)
  }
  return { columnDims, rowDims }
}

/** The number of columns the series would take if `columnDims` prefixed them. */
function projectedColumns(rows: readonly Rec[], columnDims: readonly string[], seriesKey: string): number {
  return new Set(rows.map((r) => JSON.stringify([...columnDims.map((f) => dimValue(r, f)), r[seriesKey]]))).size
}

/** Rice and sugar: as the simple rule, plus a compact-width rule, then dimensions another one already determines are dropped. */
export function classifyDimsFull(rows: readonly Rec[], foldDims: readonly string[], seriesKey: string): { columnDims: string[]; rowDims: string[] } {
  const columnDims: string[] = []
  const rowDims: string[] = []
  for (const field of foldDims) {
    const { distinct, seriesMembers, spread } = partitionStats(rows, field, seriesKey)
    if (distinct.size === 0 || seriesMembers.size === 0) {
      rowDims.push(field)
      continue
    }
    const partitions = spread <= 0.6 * distinct.size
    const compact = seriesMembers.size <= distinct.size && projectedColumns(rows, [...columnDims, field], seriesKey) <= MAX_WIDE_COLUMNS
    if (partitions || compact) columnDims.push(field)
    else rowDims.push(field)
  }
  return dropRedundantDims(rows, columnDims, rowDims)
}

/** `_is_determined`: `field` never varies within the other dimensions, the year and the period. */
function isDetermined(rows: readonly Rec[], field: string, others: readonly string[]): boolean {
  const seen = new Map<string, string | null>()
  for (const r of rows) {
    const key = JSON.stringify([...others.map((o) => dimValue(r, o)), r.year, r.period])
    const member = dimValue(r, field)
    if (!seen.has(key)) seen.set(key, member)
    else if (seen.get(key) !== member) return false
  }
  return true
}

function dropRedundantDims(rows: readonly Rec[], columnDims: readonly string[], rowDims: readonly string[]): { columnDims: string[]; rowDims: string[] } {
  let columns = [...columnDims]
  let labels = [...rowDims]
  for (const field of [...columnDims, ...rowDims]) {
    const others = [...columns, ...labels].filter((n) => n !== field)
    if (isDetermined(rows, field, others)) {
      columns = columns.filter((n) => n !== field)
      labels = labels.filter((n) => n !== field)
    }
  }
  return { columnDims: columns, rowDims: labels }
}

/** Python's `str.isdigit()` for the ASCII digits ERS years are written in. */
export const isDigits = (s: string): boolean => /^\d+$/.test(s)

export type SortKey = string | number | readonly SortKey[]

/** Python's ordering of nested tuples of numbers and strings (strings by code point). */
export function comparePy(a: SortKey, b: SortKey): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = comparePy(a[i] as SortKey, b[i] as SortKey)
      if (c !== 0) return c
    }
    return a.length - b.length
  }
  return a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1
}

/** `sorted(rows, key=...)` with a nested tuple key; stable. */
export function sortedNested<T>(rows: readonly T[], key: (row: T) => SortKey): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((x, y) => comparePy(x.k, y.k) || x.i - y.i)
    .map((x) => x.row)
}
