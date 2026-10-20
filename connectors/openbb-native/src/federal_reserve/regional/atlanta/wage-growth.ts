// federal_reserve/atlanta/wage_growth, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/atlanta_wage_growth.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { meltSheet, pivotWide, readGrid } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook } from './helpers.js'

const URL = `${ATLANTA_DOCS}/datafiles/chcs/wage-growth-tracker/wage-growth-data.xlsx`

const CUTS: Record<string, string> = {
  overall: 'data_overall',
  race: 'Race',
  education: 'Education',
  age: 'Age',
  sex: 'Sex',
  occupation: 'Occupation',
  industry: 'Industry',
  census_division: 'Census Divisions',
  work_status: 'Full-Time or Part-Time',
  job_switcher: 'Job Switcher',
  metro: 'MSA or non-MSA',
  wage_quartile: 'Average Wage Quartile',
  paid_hourly: 'Paid Hourly',
  non_smoothed: 'data_chart1',
  distribution: 'data_chart2',
  zero_changes: 'data_chart3',
  since_1983: 'WGT_1983',
  weighted: 'Overall 12ma',
  alternative: 'Alternative WGT',
}

export async function wageGrowth(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'wage_growth', URL)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const records = meltSheet(readGrid(bytes, CUTS[String(params.cut ?? 'overall')]!), { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) })
  const kept = records.filter((r) => r.series !== 'Recession').map((r) => ({ date: r.date, category: r.series, wage_growth: r.value }))
  return pivotWide(kept, 'date', 'category', 'wage_growth')
}
