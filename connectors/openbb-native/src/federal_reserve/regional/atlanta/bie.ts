// federal_reserve/atlanta/business_inflation_expectations, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/atlanta_bie.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the workbook URL (the
// Atlanta Fed moved it to research-and-data/data/bie/data; the Python URL answers with a 404 page), plain arrays instead of
// pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { cellText, meltSheet, pivotWide, readGrid, toDate, toNumeric } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook } from './helpers.js'

const URL = `${ATLANTA_DOCS}/research-and-data/data/bie/data/bie.xlsx`

const SURVEY_SHEET = 'BIE Survey results'
const RESPONDENTS = 'Number of Respondents'
const SURVEY_QUESTIONS: Record<string, string> = { sales: 'Question 1:', profit: 'Question 2:', costs: 'Question 3:', projections: 'Question 4:' }
/** question → sheet, and whether the sheet has forward-filled group labels above the measure names. */
const QUARTERLY_TABLES: Record<string, [sheet: string, groupHeader: boolean]> = {
  long_term_inflation: ['Quarterly - Long-Term Infl Exp', false],
  price_change: ['Quarterly- Price Change', true],
  unit_sales_levels: ['Quarterly- Unit Sales Levels', true],
  price_factors: ['Quarterly-Price Fact (Disc)', true],
}

/** One monthly-survey question's block of the survey sheet, as wide rows. */
function surveyRows(bytes: Uint8Array, question: string, start?: string, end?: string): Row[] {
  const grid = readGrid(bytes, SURVEY_SHEET)
  const width = grid[0]?.length ?? 0
  const markers = grid[1] ?? []
  const labels = grid[2] ?? []

  // The column each "Question n:" block starts at (a repeated marker keeps the last column).
  const starts = new Map<string, number>()
  for (let c = 0; c < width; c++) {
    const text = cellText(markers[c])
    if (text.startsWith('Question')) starts.set(`${text.split(':')[0]}:`, c)
  }
  const ordered = [...starts.values()].sort((a, b) => a - b)
  const first = starts.get(SURVEY_QUESTIONS[question]!)
  if (first === undefined) throw new Error(`'${SURVEY_QUESTIONS[question]}'`)
  const bound = ordered.find((c) => c > first) ?? width

  const buckets = new Map<number, string>()
  for (let c = first; c < bound; c++) {
    const label = cellText(labels[c])
    if (label) buckets.set(c, label)
  }

  const dated = grid
    .slice(3)
    .map((row) => ({ row, date: toDate(row[0]) }))
    .filter((r): r is { row: (typeof grid)[number]; date: string } => r.date !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const rows: Row[] = []
  for (const { row, date } of dated) {
    if (start && date < start) continue
    if (end && date > end) continue
    const record: Row = { date, [RESPONDENTS]: toNumeric(row[1]) }
    for (const [column, label] of buckets) record[label] = toNumeric(row[column])
    rows.push(record)
  }
  return rows
}

export async function businessInflationExpectations(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'bie', URL)
  const question = String(params.question ?? 'costs')
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  if (question in SURVEY_QUESTIONS) return surveyRows(bytes, question, start, end)
  const [sheet, groupHeader] = QUARTERLY_TABLES[question]!
  const records = meltSheet(readGrid(bytes, sheet), { groupHeader, ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) })
  return pivotWide(records, 'date', 'series', 'value')
}
