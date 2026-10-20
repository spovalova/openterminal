// federal_reserve/richmond/cfo_survey, non_employment_index and recession_indicator, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/richmond_cfo.py, richmond_nei.py and richmond_sos.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { isNa, pivotWide, readFrame, toDate, toNumeric } from '../workbook.js'
import { dateParam, downloadWorkbook, MEDIA } from './helpers.js'

const CFO_URL = `${MEDIA}/research/national_economy/cfo_survey/current_historical_cfo_data.xlsx`
const NEI_URL = `${MEDIA}/assets/data/non_employ_index/non_employ_index_data.xlsx`
const SOS_URL = `${MEDIA}/assets/data/sos_recession_indicator.xlsx`

const CFO_TABLES: Record<string, string> = {
  optimism: 'CFO_optimism_all',
  optimism_by_size: 'CFO_optimism_bysize',
  optimism_by_employment: 'CFO_optimism_byempcat',
  optimism_by_sector: 'CFO_optimism_bysector',
  expectations: 'CFO_expectations',
  expectations_by_employment: 'CFO_expectations_byempcat',
  expectations_by_sector: 'CFO_expectations_bysector',
  spending_3mo: 'CFO_spending_3mo',
  gdp_mean_probability: 'CFO_GDP_meanprob',
  sp500: 'CFO_SP500',
  investment_plans: 'CFO_invest_plans',
  reason_invest: 'CFO_reason_invest',
  reason_not_invest: 'CFO_reason_notinvest',
  new_credit: 'CFO_newcredit',
  credit_received: 'CFO_creditreceived',
  lenders: 'CFO_lenders',
  credit_difficulty: 'CFO_credit_difficulty',
  reason_difficult: 'CFO_reason_difficult',
  reason_easy: 'CFO_reason_easy',
  legacy_through_q1_2020: 'through_Q1_2020',
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export async function cfoSurvey(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'cfo', CFO_URL)
  const frame = readFrame(bytes, CFO_TABLES[String(params.table ?? 'optimism')]!)
  const columns = frame.columns
  const keyAt = columns.map((c, i) => [c, i] as const).filter(([c]) => ['year', 'quarter'].includes(c.toLowerCase())).map(([, i]) => i)
  const yearAt = columns.indexOf('year')
  const quarterAt = columns.indexOf('quarter')
  if (yearAt < 0) throw new Error("'year'")
  if (quarterAt < 0) throw new Error("'quarter'")

  const pad = (n: number) => String(n).padStart(2, '0')
  const rows = frame.rows
    .filter((row) => keyAt.every((i) => !isNa(row[i])))
    .map((row) => ({ row, date: `${String(Math.trunc(Number(row[yearAt]))).padStart(4, '0')}-${pad((Math.trunc(Number(row[quarterAt])) - 1) * 3 + 1)}-01` }))

  const valueColumns: number[] = []
  const categoryColumns: number[] = []
  columns.forEach((_, c) => {
    if (keyAt.includes(c)) return
    if (rows.some(({ row }) => toNumeric(row[c]) !== null)) valueColumns.push(c)
    else categoryColumns.push(c)
  })

  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  type Long = { date: string; category: string | null; series: string; value: number | null }
  const long: Long[] = []
  for (const c of valueColumns) {
    for (const { row, date } of rows) {
      if (start && date < start) continue
      if (end && date > end) continue
      const parts = categoryColumns.map((cc) => (isNa(row[cc]) ? '' : String(row[cc]).trim())).filter(Boolean)
      long.push({ date, category: parts.length ? parts.join(' - ') : null, series: columns[c]!, value: toNumeric(row[c]) })
    }
  }
  long.sort((a, b) => cmp(a.date, b.date) || cmp(a.series, b.series))
  return pivotWide(long, ['date', 'category'], 'series', 'value')
}

export async function nonEmploymentIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'nei', NEI_URL)
  const frame = readFrame(bytes, 'Data')
  const columnMap: Record<string, string> = { NEI_26_SA: 'nei', NEI_26_pter_SA: 'nei_plus', u5: 'u5', u6: 'u6', urate: 'unemployment_rate' }
  const at = (name: string): number => {
    const i = frame.columns.indexOf(name)
    if (i < 0) throw new Error(`'${name}'`)
    return i
  }
  const yearAt = at('YEAR')
  const monthAt = at('MONTH')
  const sourceAt = Object.keys(columnMap).map(at)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const dated = frame.rows
    .filter((row) => !isNa(row[yearAt]) && !isNa(row[monthAt]))
    .map((row) => ({ row, date: toDate(`${Math.trunc(Number(row[yearAt]))}-${Math.trunc(Number(row[monthAt]))}-01`) }))
    .filter((r): r is { row: (typeof frame.rows)[number]; date: string } => r.date !== undefined)
  dated.sort((a, b) => cmp(a.date, b.date))
  const names = Object.values(columnMap)
  const records: Row[] = []
  for (const { row, date } of dated) {
    if ((start && date < start) || (end && date > end)) continue
    const record: Row = { date }
    sourceAt.forEach((i, k) => {
      if (!isNa(row[i])) record[names[k]!] = row[i]
    })
    if (names.some((n) => n in record)) records.push(record)
  }
  if (records.length === 0) throw new Error('All rows were empty after parsing.')
  return records
}

export async function recessionIndicator(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'sos', SOS_URL)
  const frame = readFrame(bytes, 'Data')
  const columnMap: Record<string, string> = { 'SOS indicator': 'sos', 'Recession Threshold': 'recession_threshold' }
  const at = (name: string): number => {
    const i = frame.columns.indexOf(name)
    if (i < 0) throw new Error(`'${name}'`)
    return i
  }
  const dateAt = at('Date')
  const sourceAt = Object.keys(columnMap).map(at)
  const names = Object.values(columnMap)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const dated = frame.rows.map((row) => ({ row, date: toDate(row[dateAt]) })).filter((r): r is { row: (typeof frame.rows)[number]; date: string } => r.date !== undefined)
  dated.sort((a, b) => cmp(a.date, b.date))
  const records: Row[] = []
  for (const { row, date } of dated) {
    if ((start && date < start) || (end && date > end)) continue
    const record: Row = { date }
    sourceAt.forEach((i, k) => {
      if (!isNa(row[i])) record[names[k]!] = row[i]
    })
    records.push(record)
  }
  return records
}
