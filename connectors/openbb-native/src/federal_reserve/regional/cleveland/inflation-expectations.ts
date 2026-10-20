// federal_reserve/cleveland/inflation_expectations, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/cleveland_inflation.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays
// instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { meltSheet, pivotWide, readGrid } from '../workbook.js'
import { CLEVELAND_WEBCHARTS, dateParam, downloadWorkbook } from './helpers.js'

const URL = `${CLEVELAND_WEBCHARTS}/inflationexpectations/inflation-expectations.xlsx`

const TABLES: Record<string, string> = {
  expected_inflation: 'Expected Inflation',
  real_interest_rate: 'Real Interest Rate',
  ten_year_decomposition: 'Ten-year Expected Chart',
}
const PERCENT_TABLES = new Set(['ten_year_decomposition'])

export async function inflationExpectations(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'inflation_expectations', URL)
  const table = String(params.table ?? 'expected_inflation')
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const records = meltSheet(readGrid(bytes, TABLES[table]!), { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) })
  if (PERCENT_TABLES.has(table)) for (const r of records) if (typeof r.value === 'number') r.value = r.value / 100
  return pivotWide(records, 'date', 'series', 'value')
}
