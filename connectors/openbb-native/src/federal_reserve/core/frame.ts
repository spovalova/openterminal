// A small pandas stand-in for the federal_reserve ports: read_csv / read_excel into columns of numbers, strings and
// missing values, and the date parsing (`to_datetime`) the regional models use. Ported in spirit from pandas; only the
// behaviour the OpenBB models rely on is reproduced.
import { parseCsv } from '../../lib/csv.js'
import type { Cell as SheetCell } from '../../lib/xlsx.js'
import type { Row } from '../../types.js'

/** A cell after pandas' type inference: a number, a string, or missing (NaN / None). */
export type Value = number | string | null
export type FrameRow = Record<string, Value>
export type Frame = { columns: string[]; rows: FrameRow[] }

/** pandas' default NA tokens for read_csv (`keep_default_na`). */
const NA_TOKENS = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])

const NUMBER_RE = /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)$/i

function dedupe(header: string[]): string[] {
  const seen = new Map<string, number>()
  return header.map((name) => {
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    return n === 0 ? name : `${name}.${n}`
  })
}

/** Column-wise type inference of `read_csv`: numeric when every non-missing cell is a number, else the strings. */
function inferColumn(cells: (string | undefined)[]): Value[] {
  const present = cells.map((c) => (c === undefined || NA_TOKENS.has(c) ? null : c))
  const numeric = present.every((c) => c === null || NUMBER_RE.test(c.trim()))
  if (numeric) return present.map((c) => (c === null ? null : Number(c.trim())))
  return present
}

/** `pandas.read_csv(StringIO(text))` with default options. */
export function readCsv(text: string, opts: { delimiter?: string; header?: number; skipRows?: number } = {}): Frame {
  const all = parseCsv(text, opts.delimiter ?? ',').slice(opts.skipRows ?? 0)
  const header = all[opts.header ?? 0] ?? []
  const columns = dedupe(header)
  const body = all.slice((opts.header ?? 0) + 1)
  const cols = columns.map((_, i) => inferColumn(body.map((r) => r[i])))
  return { columns, rows: body.map((_, r) => Object.fromEntries(columns.map((c, i) => [c, cols[i]![r] ?? null]))) }
}

/** `pandas.read_excel(..., header=n)` on one sheet's cells (empty cells and cells that are not numbers or text are missing). */
export function readSheet(cells: SheetCell[][], header = 0): Frame {
  const head = cells[header] ?? []
  const width = Math.max(head.length, ...cells.slice(header + 1).map((r) => r.length), 0)
  // Unnamed columns are "Unnamed: <index>"; repeated names get .1, .2, ... as in read_csv.
  const names = dedupe(Array.from({ length: width }, (_, i) => (head[i] === null || head[i] === undefined || head[i] === '' ? `Unnamed: ${i}` : String(head[i]))))
  const rows = cells.slice(header + 1).map((r) =>
    Object.fromEntries(
      names.map((n, i) => {
        const v = r[i]
        return [n, v === null || v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v]
      }),
    ),
  ) as FrameRow[]
  // read_excel drops trailing all-empty rows and columns that are entirely unnamed and empty.
  while (rows.length && Object.values(rows[rows.length - 1]!).every((v) => v === null)) rows.pop()
  const keep = names.filter((n) => !n.startsWith('Unnamed: ') || rows.some((r) => r[n] !== null))
  return { columns: keep, rows: rows.map((r) => Object.fromEntries(keep.map((n) => [n, r[n] ?? null]))) }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function validIso(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * `datetime.strptime`-style parsing to an ISO date (the time of day is dropped); undefined when the text does not match.
 * `%b` and `%B` both take abbreviated or full month names (Python's `%b` accepts the abbreviation only).
 */
export function strptime(text: string, format: string): string | undefined {
  const fields: string[] = []
  let re = ''
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!
    if (ch === '%' && i + 1 < format.length) {
      const code = format[++i]!
      const pattern: Record<string, string> = { Y: '(\\d{4})', y: '(\\d{2})', m: '(\\d{1,2})', d: '(\\d{1,2})', b: '([A-Za-z]{3,9})', B: '([A-Za-z]+)', H: '(\\d{1,2})', M: '(\\d{1,2})', S: '(\\d{1,2})', f: '(\\d{1,6})', p: '([AaPp][Mm])', j: '(\\d{1,3})' }
      if (code === '%') re += '%'
      else if (pattern[code]) {
        fields.push(code)
        re += pattern[code]
      } else throw new Error(`unsupported format directive %${code}`)
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const m = new RegExp(`^${re}$`).exec(text.trim())
  if (!m) return undefined
  let year = 1900
  let month = 1
  let day = 1
  fields.forEach((f, i) => {
    const v = m[i + 1]!
    if (f === 'Y') year = Number(v)
    else if (f === 'y') year = Number(v) < 69 ? 2000 + Number(v) : 1900 + Number(v)
    else if (f === 'm') month = Number(v)
    else if (f === 'd') day = Number(v)
    else if (f === 'b') month = monthNumber(v)
    else if (f === 'B') month = monthNumber(v)
  })
  return validIso(year, month, day)
}

/** `pandas.to_datetime(value[, format])` as an ISO date, undefined when it does not parse (errors="coerce"). */
export function toDate(value: Value | undefined, format?: string): string | undefined {
  if (value === null || value === undefined) return undefined
  if (format) return typeof value === 'string' ? strptime(value, format) : undefined
  if (typeof value === 'number') return undefined
  const s = value.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) return validIso(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s)
  if (m) return validIso(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m) return validIso(Number(m[3]), Number(m[1]), Number(m[2]))
  m = /^(\d{4})-(\d{1,2})$/.exec(s)
  if (m) return validIso(Number(m[1]), Number(m[2]), 1)
  m = /^(\d{4})\/(\d{1,2})$/.exec(s)
  if (m) return validIso(Number(m[1]), Number(m[2]), 1)
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s)
  if (m) return validIso(Number(m[3]), monthNumber(m[1]!), Number(m[2]))
  m = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})$/.exec(s)
  if (m) return validIso(Number(m[3]), monthNumber(m[2]!), Number(m[1]))
  m = /^([A-Za-z]{3,9}) (\d{4})$/.exec(s)
  if (m) return validIso(Number(m[2]), monthNumber(m[1]!), 1)
  return undefined
}

function monthNumber(name: string): number {
  const n = name.toLowerCase()
  const i = FULL_MONTHS.indexOf(n)
  return i >= 0 ? i + 1 : MONTHS.indexOf(n.slice(0, 3)) + 1
}

/** The row as JSON-ready `results`: missing values (NaN, None) left out. */
export function rowOut(r: FrameRow | Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) out[k] = v
  return out
}

/** `frame.rename(columns=map)`: the same rows with some columns renamed (others untouched). */
export function renameColumns(frame: Frame, map: Record<string, string>): Frame {
  const columns = frame.columns.map((c) => map[c] ?? c)
  return { columns, rows: frame.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [map[k] ?? k, v]))) }
}
