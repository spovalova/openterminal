// commodity/petroleum_status_report, provider eia. Ported from openbb_us_eia/models/petroleum_status_report.py and
// openbb_us_eia/utils/helpers.py (download_excel_file) (OpenBB Platform 5.0.0, Apache-2.0); modified: the legacy .xls
// workbooks are read by lib/xls.ts instead of pandas.read_excel, the tables are reshaped as plain rows, and the
// download is cached for an hour (OpenBB keeps it for the session).
import { readXls, type Cell, type Sheet } from '../lib/xls.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { WPSR_FILE_MAP, WPSR_TABLE_MAP } from './constants.js'
import { text } from './dataset.js'

const HOUR_MS = 3600 * 1000

/** Python's `repr` of a list of strings, as it lands in the error messages. */
const pyList = (items: string[]): string => `[${items.map((s) => `'${s}'`).join(', ')}]`

/** pandas' default NA strings: an Excel text cell reading like one is a missing value. */
const NA_STRINGS = new Set(['-1.#IND', '1.#QNAN', '1.#IND', '-1.#QNAN', '#N/A N/A', '#N/A', 'N/A', 'n/a', 'NA', '<NA>', '#NA', 'NULL', 'null', 'NaN', '-NaN', 'nan', '-nan', 'None', ''])

type Block = { date: string; table: string; symbol: string; order: number; title: string; value: number; unit: string }

/** `read_excel`'s view of a sheet: no trailing empty cells in a row, no trailing empty rows, rows padded to the widest. */
function trimmed(rows: Cell[][]): Cell[][] {
  const out = rows.map((r) => {
    const row = r.map((c) => (typeof c === 'string' && NA_STRINGS.has(c) ? null : c))
    while (row.length > 0 && row[row.length - 1] === null) row.pop()
    return row
  })
  while (out.length > 0 && out[out.length - 1]!.length === 0) out.pop()
  return out
}

/** pandas' `fill_mi_header`: blank cells of a header row take the value to their left, within the same parent. */
function fillHeader(row: Cell[], control: boolean[]): Cell[] {
  const out = [...row]
  let last = out[0] ?? null
  for (let i = 1; i < out.length; i++) {
    if (!control[i]) last = out[i] ?? null
    if (out[i] === null || out[i] === undefined || out[i] === '') out[i] = last
    else {
      control[i] = false
      last = out[i]!
    }
  }
  return out
}

/** One table of a workbook as long rows (`read_excel_file` in OpenBB). */
function readTable(sheet: Sheet, tableName: string, start: string | undefined, end: string | undefined): Block[] {
  const rows = trimmed(sheet.rows)
  const b1 = rows[0]?.[1]
  if (b1 === undefined || b1 === null) throw new Error('index 1 is out of bounds for axis 1 with size 1')
  const table = String(b1).replace(/Data (\d):/g, 'Data 0$1:')

  // Header rows 1 and 2 (symbols and titles), read like a two-level pandas header over the first six rows.
  const width = Math.max(...rows.slice(0, 6).map((r) => r.length))
  const control: boolean[] = Array.from({ length: width }, () => true)
  const symbolRow = fillHeader(Array.from({ length: width }, (_, i) => rows[1]?.[i] ?? null), control)
  const titleRow = fillHeader(Array.from({ length: width }, (_, i) => rows[2]?.[i] ?? null), control)
  const symbols = symbolRow.map((s, i) => (s === null ? `Unnamed: ${i}_level_0` : String(s)))
  const rawTitles = titleRow.map((t, i) => (t === null ? `Unnamed: ${i}_level_1` : String(t)))
  // Equal (symbol, title) pairs get ".1", ".2" appended to the title; OpenBB then removes every ".1".
  const seen = new Map<string, number>()
  const titles = rawTitles.map((t, i) => {
    const key = JSON.stringify([symbols[i], t])
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return (n > 0 ? `${t}.${n}` : t).replaceAll('.1', '')
  })
  if (new Set(symbols).size !== symbols.length) throw new Error('Categorical categories must be unique')
  const dateColumn = symbols.indexOf('Sourcekey')
  const titleOf = new Map(symbols.map((s, i) => [s, titles[i]!]))

  // The data below the headers, melted: column by column, each value that exists, with its date.
  const data = rows.slice(3)
  const long: { date: string; symbol: string; value: number; title: string }[] = []
  for (let c = 0; c < width; c++) {
    if (c === dateColumn) continue
    for (const row of data) {
      const date = row[dateColumn < 0 ? 0 : dateColumn]
      const value = row[c]
      if (date === null || date === undefined || value === null || value === undefined) continue
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(date)) throw new Error('Can only use .dt accessor with datetimelike values')
      if (typeof value !== 'number') throw new Error(`Input should be a valid number, got ${JSON.stringify(value)}`)
      long.push({ date: date.slice(0, 10), symbol: symbols[c]!, value, title: titleOf.get(symbols[c]!)! })
    }
  }

  // Units are the last parenthesised phrase of each title; they are then taken out of the titles.
  const unitOf = (title: string) => title.split(' (').at(-1)!.split(')')[0]!
  const units = [...new Set(long.map((l) => unitOf(l.title)))]
  const counts = new Map<string, number>()
  const out: Block[] = []
  for (const l of long) {
    let title = l.title
    for (const unit of units) title = title.replaceAll(`(${unit})`, '').trim()
    const order = (counts.get(l.date) ?? 0) + 1
    counts.set(l.date, order)
    if ((start && l.date < start) || (end && l.date > end)) continue
    out.push({ date: l.date, table, symbol: l.symbol, order, title, value: l.value, unit: unitOf(l.title) })
  }
  return out
}

export async function petroleumStatusReport(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // transform_query: which tables of the category.
  const category = text(params, 'category') ?? 'balance_sheet'
  const tables = WPSR_TABLE_MAP[category]
  if (!tables) throw new Error(`category: Input should be one of ${Object.keys(WPSR_FILE_MAP).join(', ')} (got ${category})`)
  const requested = (text(params, 'table') || (category === 'weekly_estimates' ? 'stocks' : 'all')).split(',')
  if (requested.length === 1 && requested[0] === 'all' && category === 'weekly_estimates') {
    throw new Error(`'all' is not a supported choice for ${category}. Please choose from: ${pyList(Object.keys(tables))}`)
  }
  if (requested.includes('all') && requested.length > 1) requested.splice(requested.indexOf('all'), 1)
  for (const t of requested) {
    if (t !== 'all' && !(t in tables)) throw new Error(`Invalid table choice: ${t}. Valid choices for ${category}: ${pyList(Object.keys(tables))}`)
  }
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')

  const url = WPSR_FILE_MAP[category]!
  const load = async (): Promise<Sheet[]> => {
    try {
      return readXls(await ctx.http.bytes(url))
    } catch (err) {
      throw new Error(`Error extracting data -> Error downloading the file from the EIA site -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  }
  const sheets = params.use_cache === false ? await load() : await ctx.cache(`eia:wpsr:${url}`, HOUR_MS, load)

  try {
    const wanted = requested.includes('all') ? Object.keys(tables) : requested
    const frames: Block[][] = []
    for (const table of wanted) {
      const sheet = sheets.find((s) => s.name === tables[table])
      if (!sheet) throw new Error(`Worksheet named '${tables[table]}' not found`)
      const frame = readTable(sheet, table, start, end)
      if (frame.length > 0) frames.push(frame)
    }
    if (frames.length === 0) throw new Error('No objects to concatenate')
    return frames
      .flat()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.table < b.table ? -1 : a.table > b.table ? 1 : a.order - b.order))
      .map((b) => ({ ...b }))
  } catch (err) {
    throw new Error(`Error transforming the data -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}
