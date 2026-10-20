// Shared parsing for Federal Reserve statistical workbooks, provider federal_reserve. Ported from
// openbb_federal_reserve/utils/workbook.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of
// pandas frames. `readGrid` and the date/number coercions reproduce what `pandas.read_excel(header=None)`,
// `to_datetime(format="mixed", errors="coerce")` and `to_numeric(errors="coerce")` give the Python code.
import { isXls, readXls } from '../../lib/xls.js'
import { readXlsx, type Cell, type Sheet } from '../../lib/xlsx.js'
import type { Row } from '../../types.js'

export type { Cell }
export type Grid = Cell[][]

const parsedWorkbooks = new WeakMap<Uint8Array, Sheet[]>()

/** The sheets of an .xlsx or a legacy .xls workbook (pandas picks openpyxl or xlrd the same way). */
function readSheets(bytes: Uint8Array): Sheet[] {
  // Parsing a big workbook takes seconds: a download is cached as one byte array, and so is what is parsed from it.
  let sheets = parsedWorkbooks.get(bytes)
  if (!sheets) {
    sheets = isXls(bytes) ? readXls(bytes) : readXlsx(bytes)
    parsedWorkbooks.set(bytes, sheets)
  }
  return sheets
}

/** pandas' default `na_values`: strings read as missing from a spreadsheet. */
const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])

export const isNa = (v: unknown): v is null | undefined => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))

/**
 * One sheet as `pandas.read_excel(sheet_name=…, header=None)` returns it: a rectangular grid from A1, trailing empty
 * rows and columns trimmed, missing cells and pandas' NA strings as null. `sheet` is a name or a zero-based index.
 */
export function readGrid(bytes: Uint8Array, sheet: string | number, extraNa: string[] = [], header?: number): Grid {
  const sheets = readSheets(bytes)
  // The xlsx reader trims attribute values, so a sheet named "Index Values (unsmoothed) " is known without its trailing space.
  const found = typeof sheet === 'number' ? sheets[sheet] : (sheets.find((s) => s.name === sheet) ?? sheets.find((s) => s.name.trim() === sheet.trim()))
  if (!found) throw new Error(typeof sheet === 'number' ? `Worksheet index ${sheet} is invalid, ${sheets.length} worksheets found` : `Worksheet named '${sheet}' not found`)
  return gridOf(found.rows, extraNa, header)
}

/** Every sheet of a workbook as a grid, by name, in workbook order. */
export function readGrids(bytes: Uint8Array, extraNa: string[] = []): { name: string; grid: Grid }[] {
  return readSheets(bytes).map((s) => ({ name: s.name, grid: gridOf(s.rows, extraNa) }))
}

export function sheetNames(bytes: Uint8Array): string[] {
  return readSheets(bytes).map((s) => s.name)
}

/** A sheet read with a header row (`read_excel(header=n)`): column names as pandas labels them, then the rows below. */
export type Frame = { columns: string[]; rows: Cell[][] }

/**
 * `pandas.read_excel(sheet_name=…, header=n, na_values=…)`: the header cells become the column labels (`str(cell)`;
 * an empty one `Unnamed: <position>`, a repeated one gets `.1`, `.2` appended) and the rows below are the data.
 */
export function readFrame(bytes: Uint8Array, sheet: string | number, header = 0, extraNa: string[] = []): Frame {
  return frameOf(readGrid(bytes, sheet, extraNa, header), header)
}

export function frameOf(grid: Grid, header = 0): Frame {
  const head = grid[header] ?? []
  const width = grid[0]?.length ?? 0
  const seen = new Map<string, number>()
  const columns: string[] = []
  for (let i = 0; i < width; i++) {
    const cell = head[i]
    const base = isNa(cell) ? `Unnamed: ${i}` : typeof cell === 'number' ? numberText(cell) : String(cell)
    const n = seen.get(base)
    if (n === undefined) {
      seen.set(base, 0)
      columns.push(base)
    } else {
      seen.set(base, n + 1)
      columns.push(`${base}.${n + 1}`)
    }
  }
  return { columns, rows: grid.slice(header + 1) }
}

function gridOf(rows: Cell[][], extraNa: string[] = [], header?: number): Grid {
  const na = extraNa.length ? new Set([...PANDAS_NA, ...extraNa]) : PANDAS_NA
  // pandas takes column labels as they are written (a header cell "None" is a column called None); only empty ones are missing.
  const clean = rows.map((r, i) => r.map((c) => (typeof c === 'string' && (i === header ? c === '' : na.has(c)) ? null : c)))
  const lastUsed = (r: Cell[]): number => {
    let n = r.length
    while (n > 0 && r[n - 1] === null) n--
    return n
  }
  let height = clean.length
  while (height > 0 && lastUsed(clean[height - 1]!) === 0) height--
  let width = 0
  for (let i = 0; i < height; i++) width = Math.max(width, lastUsed(clean[i]!))
  return clean.slice(0, height).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null))
}

/** A header cell as text: whitespace collapsed (`" ".join(str(v).split())`), empty for a missing cell. */
export function cellText(value: unknown): string {
  if (isNa(value)) return ''
  const s = typeof value === 'number' ? numberText(value) : typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)
  return s.split(/\s+/).filter(Boolean).join(' ')
}

/** Python's `str(float)` for the values spreadsheets hold: 2020 → "2020", 0.5 → "0.5". */
export function numberText(n: number): string {
  return String(n)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/

/** Whether a cell is a spreadsheet date (the xlsx reader returns date-formatted cells as ISO strings). */
export function isDateCell(cell: unknown): boolean {
  return typeof cell === 'string' && ISO_DATE.test(cell)
}

/** "YYYY-MM-DD" of a date cell. */
export const dateOf = (cell: string): string => cell.slice(0, 10)

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 }

const pad2 = (n: number): string => String(n).padStart(2, '0')

function validYmd(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return undefined
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`
}

/** dateutil's two-digit year rule: within 50 years of the current one (the clock is fixed: 2026). */
function fullYear(y: number): number {
  if (y >= 100) return y
  const current = 2026
  let year = Math.floor(current / 100) * 100 + y
  if (year >= current + 50) year -= 100
  else if (year < current - 50) year += 100
  return year
}

/** The date `pandas.to_datetime` reads from a string, for the formats the Fed's sheets use; undefined when it fails. */
export function parseLooseDate(input: string): string | undefined {
  const s = input.trim()
  if (!s) return undefined
  let m: RegExpExecArray | null
  if ((m = ISO_DATE.exec(s))) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]))
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s))) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]))
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) return validYmd(Number(m[1]), Number(m[2]), 1)
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]))
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ].*)?$/.exec(s))) return validYmd(fullYear(Number(m[3])), Number(m[1]), Number(m[2]))
  if ((m = /^(\d{4})\s*-?\s*Q([1-4])$/i.exec(s))) return validYmd(Number(m[1]), (Number(m[2]) - 1) * 3 + 1, 1)
  if ((m = /^Q([1-4])[\s-]*(\d{4})$/i.exec(s))) return validYmd(Number(m[2]), (Number(m[1]) - 1) * 3 + 1, 1)
  if ((m = /^(\d{4})$/.exec(s))) return validYmd(Number(m[1]), 1, 1)
  // "Jan 2020", "January 2020", "Jan-20", "Jan 5, 2020", "5 Jan 2020", "2020 Jan"
  if ((m = /^([A-Za-z]+)\.?[\s-]+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && MONTHS[m[1]!.toLowerCase()]) return validYmd(Number(m[3]), MONTHS[m[1]!.toLowerCase()]!, Number(m[2]))
  if ((m = /^(\d{1,2})[\s-]+([A-Za-z]+)\.?,?[\s-]+(\d{2,4})$/.exec(s)) && MONTHS[m[2]!.toLowerCase()]) return validYmd(fullYear(Number(m[3])), MONTHS[m[2]!.toLowerCase()]!, Number(m[1]))
  if ((m = /^([A-Za-z]+)\.?[\s-]+(\d{4})$/.exec(s)) && MONTHS[m[1]!.toLowerCase()]) return validYmd(Number(m[2]), MONTHS[m[1]!.toLowerCase()]!, 1)
  if ((m = /^(\d{4})[\s-]+([A-Za-z]+)\.?$/.exec(s)) && MONTHS[m[2]!.toLowerCase()]) return validYmd(Number(m[1]), MONTHS[m[2]!.toLowerCase()]!, 1)
  if ((m = /^([A-Za-z]+)\.?[\s-]+(\d{2})$/.exec(s)) && MONTHS[m[1]!.toLowerCase()]) return validYmd(fullYear(Number(m[2])), MONTHS[m[1]!.toLowerCase()]!, 1)
  return undefined
}

/**
 * `to_datetime(cell, errors="coerce", format="mixed")` as a date: date cells and parseable strings; a plain number
 * is nanoseconds since the epoch (so 1970-01-01); anything else is missing.
 */
export function toDate(cell: Cell | undefined): string | undefined {
  if (isNa(cell)) return undefined
  if (typeof cell === 'number') return '1970-01-01'
  if (typeof cell === 'string') return isDateCell(cell) ? dateOf(cell) : parseLooseDate(cell)
  return undefined
}

/** `to_numeric(cell, errors="coerce")`: numbers as they are, numeric strings parsed, everything else missing. */
export function toNumeric(cell: unknown): number | null {
  if (typeof cell === 'number') return Number.isNaN(cell) ? null : cell
  if (typeof cell === 'boolean') return cell ? 1 : 0
  if (typeof cell === 'string') {
    const s = cell.trim()
    if (s === '' || !/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity)$/i.test(s)) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A cell as a plain number or null (`_number` in the models: blanks and markers are missing). */
export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'boolean' || isNa(value)) return null
  if (typeof value === 'number') return value
  const s = String(value).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isNaN(n) || !/^[+-]?(\d|\.\d)/.test(s) ? null : n
}

/** Round a numeric value to a sensible precision without collapsing it (`round_value`). */
export function roundValue(value: unknown, precision = 2): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  if (value === 0) return 0
  let rounded = pyRound(value, precision)
  if (rounded === 0) {
    precision = Math.max(precision, 1 - Math.floor(Math.log10(Math.abs(value))))
    rounded = pyRound(value, precision)
  }
  return rounded
}

/** Python's `round(x, n)`: correctly rounded on the exact binary value, exact ties to the even neighbour. */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x
  if (digits < 0) {
    const f = 10 ** -digits
    return Math.round(x / f) * f
  }
  const fixed = x.toFixed(Math.min(100, digits))
  // toFixed rounds an exact tie up in magnitude; Python takes the even neighbour.
  const exact = Math.abs(x).toFixed(100)
  const dot = exact.indexOf('.')
  if (/^50*$/.test(exact.slice(dot + 1 + digits))) {
    const truncated = exact.slice(0, dot + 1 + digits).replace(/\.$/, '')
    if (Number(truncated.slice(-1)) % 2 === 0) return Number(x < 0 ? `-${truncated}` : truncated)
  }
  return Number(fixed)
}

/** Tidy long records to wide rows (`pivot_wide`): one row per index tuple in first-seen order, rows with no value dropped. */
export function pivotWide(records: Row[], index: string | string[] = 'date', column = 'series', value = 'value'): Row[] {
  const indexCols = typeof index === 'string' ? [index] : index
  const rows = new Map<string, Row>()
  for (const record of records) {
    const key = JSON.stringify(indexCols.map((c) => record[c] ?? null))
    let row = rows.get(key)
    if (!row) {
      row = Object.fromEntries(indexCols.map((c) => [c, record[c] ?? null]))
      rows.set(key, row)
    }
    row[String(record[column])] = record[value] ?? null
  }
  return [...rows.values()].filter((row) => Object.entries(row).some(([c, v]) => !indexCols.includes(c) && v !== null && v !== undefined))
}

/** Index of the first row whose first cell is (or parses to) a date of 1900 or later (`_first_data_row`). */
function firstDataRow(column: Cell[]): number | undefined {
  for (let i = 0; i < column.length; i++) {
    const v = column[i]
    if (isDateCell(v)) return i
    if (typeof v === 'string' && v.trim()) {
      const parsed = parseLooseDate(v)
      if (parsed && Number(parsed.slice(0, 4)) >= 1900) return i
    }
  }
  return undefined
}

export type MeltOptions = {
  /** The row two above the first dated row carries forward-filled group labels prefixed onto each measure name. */
  groupHeader?: boolean
  /** Remap derived series names to friendlier labels. */
  labels?: Record<string, string>
  /** Header names of secondary key columns, carried into every record as their own field instead of being melted. */
  keyColumns?: string[]
  startDate?: string
  endDate?: string
}

/** Python's default string ordering for the sort keys (code points). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A tidy time-series sheet as long `(date, series, value)` records, sorted by date, key columns, then series (`melt_sheet`). */
export function meltSheet(grid: Grid, opts: MeltOptions = {}): Row[] {
  const firstData = firstDataRow(grid.map((r) => r[0] ?? null))
  if (firstData === undefined) return []
  const width = grid[0]?.length ?? 0
  // iloc[-1] when the data starts on the first row: the last row of the sheet.
  const at = (i: number): Cell[] => grid[i < 0 ? grid.length + i : i] ?? []
  const sub = at(firstData - 1)
  const groups = opts.groupHeader && firstData >= 2 ? at(firstData - 2) : undefined

  const keyLower = new Set((opts.keyColumns ?? []).map((k) => k.toLowerCase()))
  const seriesColumns = new Map<number, string>()
  const keyFields = new Map<number, string>()
  let lastGroup = ''
  for (let column = 1; column < width; column++) {
    if (groups) {
      const groupLabel = cellText(groups[column])
      if (groupLabel && !/^(note|source)/i.test(groupLabel)) lastGroup = groupLabel
    }
    const label = cellText(sub[column])
    if (!label || label.toLowerCase().startsWith('last updated')) continue
    if (keyLower.has(label.toLowerCase())) {
      keyFields.set(column, label.toLowerCase())
      continue
    }
    const name = groups && lastGroup ? `${lastGroup} - ${label}` : label
    seriesColumns.set(column, opts.labels?.[name] ?? name)
  }

  type Melted = { date: string; keys: string[]; series: string; value: number | null }
  const melted: Melted[] = []
  for (let r = firstData; r < grid.length; r++) {
    const row = grid[r]!
    const date = toDate(row[0])
    if (date === undefined) continue
    if (opts.startDate && date < opts.startDate) continue
    if (opts.endDate && date > opts.endDate) continue
    const keys = [...keyFields.keys()].map((c) => cellText(row[c]))
    for (const [column, series] of seriesColumns) melted.push({ date, keys, series, value: toNumeric(row[column]) })
  }
  melted.sort((a, b) => {
    if (a.date !== b.date) return cmp(a.date, b.date)
    for (let i = 0; i < a.keys.length; i++) if (a.keys[i] !== b.keys[i]) return cmp(a.keys[i]!, b.keys[i]!)
    return cmp(a.series, b.series)
  })
  const fields = [...keyFields.values()]
  return melted.map((m) => {
    const record: Row = { date: m.date }
    fields.forEach((f, i) => {
      record[f] = m.keys[i] || null
    })
    record.series = m.series
    record.value = m.value
    return record
  })
}

/** Each date cell of a column as a date and every other cell as undefined (`cell_dates`). */
export function cellDates(values: Cell[]): (string | undefined)[] {
  return values.map((v) => (isDateCell(v) ? dateOf(v as string) : undefined))
}

/** Drop records outside the inclusive date bounds (string dates compare as dates). */
export function between<T extends { date?: unknown }>(rows: T[], start?: string, end?: string): T[] {
  return rows.filter((r) => {
    const d = String(r.date)
    return (!start || d >= start) && (!end || d <= end)
  })
}

/** Python's `sorted(…, key=…)` on string keys and tuples is plain code-point order. */
export const compareStrings = cmp
