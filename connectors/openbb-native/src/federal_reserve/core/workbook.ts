// Shared parsing for Federal Reserve statistical workbooks. Ported from openbb_federal_reserve/utils/workbook.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: the shared xlsx reader instead of pandas and openpyxl.
import { readXlsx, type Cell } from '../../lib/xlsx.js'
import type { Row } from '../../types.js'
import { toDate } from './frame.js'
import { cmp } from './helpers.js'

/** Python's `round(value, digits)`: the nearest decimal, exact ties to even. */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const f = 10 ** digits
  const scaled = x * f
  // An exact tie (x = k + 0.5 in units of 10^-digits) is rare; toFixed rounds those up, Python to even.
  if (Math.abs(scaled % 1) === 0.5 && scaled / f === x) {
    const down = Math.floor(scaled)
    return (down % 2 === 0 ? down : down + 1) / f
  }
  return Number(x.toFixed(Math.max(0, Math.min(100, digits))))
}

/** `round_value`: two decimals, widened just enough to keep the first two significant digits of a small value. */
export function roundValue(value: number, precision = 2): number {
  if (!Number.isFinite(value)) return value
  if (value === 0) return 0
  let p = precision
  let rounded = pyRound(value, p)
  if (rounded === 0) {
    p = Math.max(p, 1 - Math.floor(Math.log10(Math.abs(value))))
    rounded = pyRound(value, p)
  }
  return rounded
}

/** `_text`: a header cell as one line of text, empty when missing. */
function text(v: Cell | undefined): string {
  if (v === null || v === undefined) return ''
  return String(v).split(/\s+/).filter(Boolean).join(' ')
}

/** The sheet's cells as `read_excel(header=None)` gives them. */
export function sheetCells(content: Uint8Array, name: string): Cell[][] {
  const sheet = readXlsx(content).find((s) => s.name === name)
  if (!sheet) throw new Error(`Worksheet named '${name}' not found`)
  return sheet.rows
}

/** `to_datetime(value, errors="coerce", format="mixed")` of a sheet cell. */
function cellDate(v: Cell | undefined): string | undefined {
  if (v === null || v === undefined || typeof v === 'boolean') return undefined
  // A bare number is read as nanoseconds since the epoch.
  if (typeof v === 'number') return Math.abs(v) < 8.64e13 ? '1970-01-01' : undefined
  return toDate(v)
}

function firstDataRow(rows: Cell[][]): number | undefined {
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]?.[0]
    if (typeof v === 'string' && v.trim()) {
      const d = toDate(v.trim())
      if (d !== undefined && Number(d.slice(0, 4)) >= 1900) return i
    }
  }
  return undefined
}

export type Melted = { date: string; series: string; value: number | null; [key: string]: unknown }

/** `melt_sheet`: a tidy time-series sheet as long (date, series, value) records, sorted by date then series. */
export function meltSheet(
  content: Uint8Array,
  sheet: string,
  opts: { groupHeader?: boolean; labels?: Record<string, string>; keyColumns?: string[]; start?: string; end?: string } = {},
): Melted[] {
  const rows = sheetCells(content, sheet)
  const first = firstDataRow(rows)
  if (first === undefined) return []
  const width = Math.max(...rows.map((r) => r.length), 0)
  const sub = rows[first - 1] ?? []
  const groups = opts.groupHeader && first >= 2 ? (rows[first - 2] ?? []) : undefined
  const keyLower = new Set((opts.keyColumns ?? []).map((k) => k.toLowerCase()))

  const seriesColumns = new Map<number, string>()
  const keyFields = new Map<number, string>()
  let lastGroup = ''
  for (let c = 1; c < width; c++) {
    if (groups) {
      const label = text(groups[c])
      if (label && !/^(note|source)/i.test(label)) lastGroup = label
    }
    const label = text(sub[c])
    if (!label || label.toLowerCase().startsWith('last updated')) continue
    if (keyLower.has(label.toLowerCase())) {
      keyFields.set(c, label.toLowerCase())
      continue
    }
    const name = groups && lastGroup ? `${lastGroup} - ${label}` : label
    seriesColumns.set(c, opts.labels ? (opts.labels[name] ?? name) : name)
  }

  const out: (Melted & { _keys: string[] })[] = []
  for (const r of rows.slice(first)) {
    const date = cellDate(r[0])
    if (date === undefined) continue
    if (opts.start && date < opts.start) continue
    if (opts.end && date > opts.end) continue
    const keys = [...keyFields.keys()].map((c) => text(r[c]))
    for (const [c, series] of seriesColumns) {
      const v = r[c]
      const value = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null
      const rec: Melted & { _keys: string[] } = { date, series, value, _keys: keys }
      ;[...keyFields.values()].forEach((f, i) => (rec[f] = keys[i] || null))
      out.push(rec)
    }
  }
  out.sort((a, b) => cmp(a.date, b.date) || compareKeys(a._keys, b._keys) || cmp(a.series, b.series))
  return out.map(({ _keys, ...rec }) => rec)
}

function compareKeys(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = cmp(a[i]!, b[i]!)
    if (d) return d
  }
  return 0
}

/** `pivot_wide`: tidy records into one row per index tuple; a repeated column keeps its last value, empty rows go. */
export function pivotWide(records: Row[], index: string[], column = 'series', value = 'value'): Row[] {
  const rows = new Map<string, Row>()
  for (const r of records) {
    const key = JSON.stringify(index.map((c) => r[c] ?? null))
    let row = rows.get(key)
    if (!row) {
      row = Object.fromEntries(index.map((c) => [c, r[c] ?? null]))
      rows.set(key, row)
    }
    row[String(r[column])] = r[value] ?? null
  }
  return [...rows.values()]
    .filter((row) => Object.entries(row).some(([k, v]) => !index.includes(k) && v !== null && v !== undefined))
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)))
}
