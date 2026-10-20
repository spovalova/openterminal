// federal_reserve/atlanta/business_uncertainty, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/atlanta_sbu.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays
// instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { meltSheet, pivotWide, readGrid } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook } from './helpers.js'

const URL = `${ATLANTA_DOCS}/datafiles/research/surveys/business-uncertainty/sbu-data.xlsx`

/** table → sheet name, and whether the sheet has forward-filled group labels above the measure names. */
const TABLES: Record<string, [sheet: string, groupHeader: boolean]> = {
  index_smoothed: ['Index Values (smoothed)', false],
  index_unsmoothed: ['Index Values (unsmoothed) ', false],
  cost_price_smoothed: ['Cost & Price Index (Smoothed)', false],
  cost_price_unsmoothed: ['Cost & Price Index (unsmoothed)', false],
  reallocation: ['Reallocation measures', false],
  expected_sales_distribution: ['Distrib. of Exp. Sales Growth', false],
  realized_growth: ['Realized Growth Rate Indexes', false],
  realized_sales_distribution: ['Distrib. of Realized Sales Gr. ', false],
  historical_research: ['Historical Data for Research', false],
  discontinued: ['Dicontinued Series', true],
}

export async function businessUncertainty(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'sbu', URL)
  const [sheet, groupHeader] = TABLES[String(params.table ?? 'index_smoothed')]!
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  return pivotWide(meltSheet(readGrid(bytes, sheet), { groupHeader, ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) }))
}
