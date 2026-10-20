// CSV text as a typed frame, the way `pandas.read_csv` gives it to the Federal Reserve models of the regional part:
// the header row names the columns (repeats get `.1`, `.2`), a column whose non-empty cells are all numbers becomes
// numeric, empty cells and pandas' NA strings are missing. Shared helper for the regional ports (provider federal_reserve).
import { parseCsv } from '../../lib/csv.js'
import type { Cell, Frame } from './workbook.js'

const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export type CsvOptions = {
  delimiter?: string
  /** Rows to drop before the header (`skiprows`). */
  skipRows?: number
  /** Extra strings read as missing (`na_values`). */
  naValues?: string[]
  /** No header row (`header=None`): the columns are named 0, 1, 2… and every row is data. */
  noHeader?: boolean
  /** Keep every column as text (`dtype=str`): numeric inference is skipped, NA strings still become missing. */
  text?: boolean
}

export function readCsvFrame(text: string, opts: CsvOptions = {}): Frame {
  const all = parseCsv(text, opts.delimiter ?? ',').slice(opts.skipRows ?? 0)
  const header = opts.noHeader ? (all[0] ?? []).map((_, i) => String(i)) : (all[0] ?? [])
  const na = opts.naValues?.length ? new Set([...PANDAS_NA, ...opts.naValues]) : PANDAS_NA
  const seen = new Map<string, number>()
  const columns = header.map((h, i) => {
    const base = h === '' ? `Unnamed: ${i}` : h
    const n = seen.get(base)
    if (n === undefined) {
      seen.set(base, 0)
      return base
    }
    seen.set(base, n + 1)
    return `${base}.${n + 1}`
  })
  const body = opts.noHeader ? all : all.slice(1)
  const numeric = columns.map((_, c) => !opts.text && body.some((r) => !na.has(r[c] ?? '')) && body.every((r) => na.has(r[c] ?? '') || NUMBER.test((r[c] ?? '').trim())))
  const rows: Cell[][] = body.map((r) => columns.map((_, c) => {
    const v = r[c] ?? ''
    if (na.has(v)) return null
    return numeric[c] ? Number(v.trim()) : v
  }))
  return { columns, rows }
}
