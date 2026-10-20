// federal_reserve/atlanta/sticky_cpi, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/atlanta_sticky_cpi.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { isDateCell, isNa, parseLooseDate, readGrid, toNumeric, dateOf } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook, emptyData } from './helpers.js'

const URL = `${ATLANTA_DOCS}/datafiles/research/inflationproject/stickprice/stickyprice.xlsx`
const NA_VALUES = ['na', '.', '#N/A', '#N/A N/A']
const TRANSFORMS = ['monthly', '1-month annualized', '3-month annualized', '12-month']

/** "Sticky CPI (…)" → "Sticky CPI", with the shelter spellings tidied. */
function measureName(raw: string): string {
  const name = raw.split('(')[0]!.replace('EX_shelter', 'ex-shelter').replace('_ex shelter', ' ex-shelter')
  return name.split(/\s+/).filter(Boolean).join(' ')
}

export async function stickyCpi(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'sticky_cpi', URL)
  const grid = readGrid(bytes, 'Data', NA_VALUES)
  const firstData = grid.findIndex((r) => isDateCell(r[0]))
  if (firstData < 0) emptyData()
  const header = grid[firstData - 1 < 0 ? grid.length - 1 : firstData - 1]!
  const valueColumns: number[] = []
  for (let c = 1; c < (grid[0]?.length ?? 0); c++) if (!isNa(header[c]) && String(header[c]).trim()) valueColumns.push(c)

  const transform = String(params.transform ?? '1-month annualized')
  const measureColumns = new Map<string, number>()
  let measure = ''
  valueColumns.forEach((column, position) => {
    const t = position % 4
    if (t === 0) measure = measureName(String(header[column]))
    if (TRANSFORMS[t] === transform) measureColumns.set(measure, column)
  })

  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const records: Row[] = []
  const dated: { row: (typeof grid)[number]; date: string }[] = []
  for (const row of grid.slice(firstData)) {
    // to_datetime(str(cell).strip(), format="mixed", errors="coerce"): a date cell or a parseable string.
    const cell = row[0]
    const date = isDateCell(cell) ? dateOf(cell as string) : typeof cell === 'string' ? parseLooseDate(cell) : undefined
    if (date !== undefined) dated.push({ row, date })
  }
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (const { row, date } of dated) {
    if (start && date < start) continue
    if (end && date > end) continue
    const record: Row = { date }
    for (const [m, column] of measureColumns) record[m] = toNumeric(row[column])
    if ([...measureColumns.keys()].some((m) => record[m] !== null)) records.push(record)
  }
  if (records.length === 0) emptyData()
  return records
}
