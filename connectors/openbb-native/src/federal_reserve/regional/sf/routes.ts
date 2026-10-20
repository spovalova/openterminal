// federal_reserve/sf/*, provider federal_reserve. Ported from openbb_federal_reserve/models/regional/san_francisco_cyclical_pce.py,
// _news_sentiment.py, _proxy_funds_rate.py, _short_rate_path.py, _supply_demand_pce.py, _term_premium.py and _tfp.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { isNa, readFrame, toNumeric } from '../workbook.js'
import { column, dateCell, dateParam, datedRows, downloadWorkbook, monthCell, renamed, SF_UPLOADS } from './helpers.js'

const CYCLICAL_PCE_COLUMNS: Record<string, string> = {
  'Cyclical core PCE inflation (y/y)': 'cyclical_inflation_yoy',
  'Acyclical core PCE inflation (y/y)': 'acyclical_inflation_yoy',
  'Cyclical core PCE contribution (y/y)': 'cyclical_contribution_yoy',
  'Ayclical core PCE contribution (y/y)': 'acyclical_contribution_yoy',
  'Health-care services portion of acyclical contribution (y/y)': 'acyclical_healthcare_contribution_yoy',
  'Non-health-care portion of acyclical contribution (y/y)': 'acyclical_non_healthcare_contribution_yoy',
  'Cyclical core PCE inflation (m/m, ar)': 'cyclical_inflation_mom',
  'Acyclical core PCE inflation (m/m, ar)': 'acyclical_inflation_mom',
  'Cyclical core PCE contribution (m/m, ar)': 'cyclical_contribution_mom',
  'Ayclical core PCE contribution (m/m, ar)': 'acyclical_contribution_mom',
  'Health-care services portion of acyclical contribution (m/m, ar)': 'acyclical_healthcare_contribution_mom',
  'Non-health-care portion of acyclical contribution (m/m, ar)': 'acyclical_non_healthcare_contribution_mom',
}

const SUPPLY_DEMAND_COLUMNS: Record<string, string> = {
  'Demand-driven Inflation (core, y/y)': 'demand_core_yoy',
  'Ambiguous (core, y/y)': 'ambiguous_core_yoy',
  'Supply-driven Inflation (core, y/y)': 'supply_core_yoy',
  'Demand-driven Inflation (core, m/m)': 'demand_core_mom',
  'Ambiguous (core, m/m)': 'ambiguous_core_mom',
  'Supply-driven Inflation (core, m/m)': 'supply_core_mom',
  'Demand-driven Inflation (headline, y/y)': 'demand_headline_yoy',
  'Ambiguous (headline, y/y)': 'ambiguous_headline_yoy',
  'Supply-driven Inflation (headline, y/y)': 'supply_headline_yoy',
  'Demand-driven Inflation (headline, m/m)': 'demand_headline_mom',
  'Ambiguous (headline, m/m)': 'ambiguous_headline_mom',
  'Supply-driven Inflation (headline, m/m)': 'supply_headline_mom',
}

/** A "Data" sheet with a `time_month` column ("1988m01") and renamed value columns. */
async function monthlyData(ctx: NativeCtx, params: NativeParams, key: string, file: string, columns: Record<string, string>): Promise<Row[]> {
  const frame = readFrame(await downloadWorkbook(ctx, key, `${SF_UPLOADS}/${file}`), 'Data')
  const labels = renamed(frame, { time_month: 'date', ...columns })
  return datedRows(frame, labels, column({ ...frame, columns: labels }, 'date'), monthCell, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
}

export const cyclicalPce = (params: NativeParams, ctx: NativeCtx) => monthlyData(ctx, params, 'cyclical_pce', 'cyclical-acyclical-core-pce-data.xlsx', CYCLICAL_PCE_COLUMNS)
export const supplyDemandPce = (params: NativeParams, ctx: NativeCtx) => monthlyData(ctx, params, 'supply_demand_pce', 'supply-demand-pce-inflation.xlsx', SUPPLY_DEMAND_COLUMNS)

export async function newsSentiment(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frame = readFrame(await downloadWorkbook(ctx, 'news_sentiment', `${SF_UPLOADS}/news_sentiment_data.xlsx`), 'Data')
  const labels = renamed(frame, { 'News Sentiment': 'news_sentiment' })
  column({ ...frame, columns: labels }, 'news_sentiment')
  return datedRows(frame, labels, column({ ...frame, columns: labels }, 'date'), dateCell, dateParam(params, 'start_date'), dateParam(params, 'end_date'), ['date', 'news_sentiment'])
}

export async function proxyFundsRate(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const sheet = String(params.frequency ?? 'monthly') === 'weekly' ? 'Weekly' : 'Monthly'
  const frame = readFrame(await downloadWorkbook(ctx, 'proxy_funds_rate', `${SF_UPLOADS}/proxy-funds-rate-data.xlsx`), sheet)
  const labels = renamed(frame, { Date: 'date', 'Effective funds rate': 'effective_funds_rate', 'Proxy funds rate': 'proxy_funds_rate' })
  const labelled = { ...frame, columns: labels }
  column(labelled, 'effective_funds_rate')
  column(labelled, 'proxy_funds_rate')
  return datedRows(frame, labels, column(labelled, 'date'), dateCell, dateParam(params, 'start_date'), dateParam(params, 'end_date'), ['date', 'effective_funds_rate', 'proxy_funds_rate'])
}

const TERM_WORKBOOK = 'FRBSF_Term_Web_Chart_Data.xlsx'

export async function termPremium(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const maturity = Number(params.maturity ?? 10)
  const sheet = maturity === 2 ? 'Two_year_decomposition' : 'Ten_year_decomposition'
  const suffix = maturity === 2 ? '02YR' : '10YR'
  const frame = readFrame(await downloadWorkbook(ctx, 'term_premium', `${SF_UPLOADS}/${TERM_WORKBOOK}`), sheet)
  const labels = renamed(frame, { [`ZCYLD${suffix}`]: 'yield_zero_coupon', [`AVGEXP${suffix}`]: 'expected_short_rate', [`ZCTERM${suffix}`]: 'term_premium' })
  const labelled = { ...frame, columns: labels }
  for (const name of ['yield_zero_coupon', 'expected_short_rate', 'term_premium']) column(labelled, name)
  return datedRows(frame, labels, column(labelled, 'date'), dateCell, dateParam(params, 'start_date'), dateParam(params, 'end_date'), ['date', 'yield_zero_coupon', 'expected_short_rate', 'term_premium'])
}

const SCENARIOS: Record<string, string> = { MOSTRECENT: 'Most Recent', FOMC: 'FOMC Summary of Economic Projections' }

export async function shortRatePath(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frame = readFrame(await downloadWorkbook(ctx, 'term_premium', `${SF_UPLOADS}/${TERM_WORKBOOK}`), 'Estimated_Short_Rate_Path')
  const labels = renamed(frame, { MATURITY: 'maturity' })
  const maturityAt = column({ ...frame, columns: labels }, 'maturity')
  const scenarios = Object.keys(SCENARIOS).filter((c) => labels.includes(c))
  const rows = frame.rows.flatMap((row) => {
    const maturity = toNumeric(row[maturityAt])
    return maturity === null ? [] : [{ row, maturity }]
  })
  rows.sort((a, b) => a.maturity - b.maturity)
  return rows.map(({ row, maturity }) => {
    const out: Row = { maturity }
    for (const c of scenarios) {
      const v = toNumeric(row[labels.indexOf(c)])
      if (v !== null) out[SCENARIOS[c]!] = v
    }
    return out
  })
}

const TFP_LABELS: Record<string, string> = {
  dY_prod: 'Business Output (Product Side)',
  dY_inc: 'Business Output (Income Side)',
  dY: 'Output',
  dhours: 'Hours (Business Sector)',
  dLP: 'Labor Productivity',
  dk: 'Capital Input',
  dLQ_BLS_interpolated: 'Labor Quality (BLS, Interpolated)',
  dLQ_Aaronson_Sullivan: 'Labor Quality (Aaronson-Sullivan)',
  dLQ: 'Labor Quality',
  alpha: "Capital's Share of Income",
  dtfp: 'TFP',
  dutil: 'Utilization of Capital and Labor',
  dtfp_util: 'Utilization-Adjusted TFP',
  relativePrice: 'Relative Price of Consumption to Equipment',
  invShare: 'Equipment and Consumer Durables Share of Output',
  dtfp_I: 'TFP in Equipment and Consumer Durables',
  dtfp_C: 'TFP in Non-Equipment Output',
  du_invest: 'Utilization in Producing Investment',
  du_consumption: 'Utilization in Producing Consumption',
  dtfp_I_util: 'Utilization-Adjusted TFP (Equipment and Consumer Durables)',
  dtfp_C_util: 'Utilization-Adjusted TFP (Non-Equipment Output)',
}
/** table → sheet and header row. */
const TFP_SHEETS: Record<string, [sheet: string, header: number]> = {
  quarterly: ['quarterly', 1],
  annual: ['annual', 0],
  capital_input_details: ['Capital-input-details', 1],
}

export async function totalFactorProductivity(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = String(params.table ?? 'quarterly')
  const [sheet, header] = TFP_SHEETS[table]!
  const frame = readFrame(await downloadWorkbook(ctx, 'tfp', `${SF_UPLOADS}/quarterly_tfp.xlsx`), sheet, header)
  const annual = table === 'annual'
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')

  // The first column is the period: "1947:Q1" (quarter end) or 1948 (December 31st).
  const dated = frame.rows.flatMap((row) => {
    const text = isNa(row[0]) ? 'nan' : String(row[0]).trim()
    if (annual) {
      const m = /^(\d{4})(\.0)?$/.exec(text)
      return m ? [{ row, date: `${m[1]}-12-31` }] : []
    }
    const q = /^(\d{4}):Q(\d)$/.exec(text)
    if (!q || Number(q[2]) < 1 || Number(q[2]) > 4) return []
    return [{ row, date: `${q[1]}-${['03-31', '06-30', '09-30', '12-31'][Number(q[2]) - 1]}` }]
  })
  const values = frame.columns.map((_, c) => dated.map(({ row }) => toNumeric(row[c])))
  const valueColumns = frame.columns.map((_, c) => c).filter((c) => c !== 0 && values[c]!.some((v) => v !== null))
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const rows: Row[] = []
  for (const { row, date } of dated) {
    if (start && date < start) continue
    if (end && date > end) continue
    const record: Row = {}
    for (const c of valueColumns) {
      const v = toNumeric(row[c])
      if (v !== null) record[TFP_LABELS[frame.columns[c]!] ?? frame.columns[c]!] = v
    }
    if (Object.keys(record).length === 0) continue
    rows.push({ date, ...record })
  }
  return rows
}
