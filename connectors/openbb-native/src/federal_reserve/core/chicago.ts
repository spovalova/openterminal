// federal_reserve/chicago/* (all but the publications), provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/chicago_*.py and utils/chicago.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: one spec per CSV series instead of one model each; no curl_cffi fallback (a 403 is an error).
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { readCsv, strptime, type Frame } from './frame.js'
import { cmp, DAY_MS, EmptyDataError, request, str } from './helpers.js'
import { coerceNumber, loadFrame, seriesHandler, seriesRows, type SeriesSpec } from './series.js'
import { meltSheet, pivotWide, roundValue } from './workbook.js'

const NFCI: SeriesSpec = {
  url: 'https://www.chicagofed.org/-/media/publications/nfci/nfci-data-series-csv.csv',
  rename: { NFCI: 'nfci', ANFCI: 'adjusted_nfci', Risk: 'risk', Credit: 'credit', Leverage: 'leverage', Nonfinancial_Leverage: 'nonfinancial_leverage' },
  dateColumn: 'Friday_of_Week',
  dateFormat: '%m/%d/%Y',
}
const CFNAI: SeriesSpec = {
  url: 'https://www.chicagofed.org/-/media/publications/cfnai/cfnai-data-series-csv.csv',
  rename: { P_I: 'production_income', EU_H: 'employment', C_H: 'consumption_housing', SO_I: 'sales_orders_inventories', CFNAI: 'cfnai', CFNAI_MA3: 'cfnai_ma3', DIFFUSION: 'diffusion' },
  dateColumn: 'Date',
  dateFormat: '%Y/%m',
}
const BBKI: SeriesSpec = {
  url: 'https://www.chicagofed.org/-/media/publications/bbki/bbki-monthly-data-series-csv.csv',
  rename: { CoincidentIndex: 'coincident_index', LeadingIndex: 'leading_index', Cycle: 'cycle', CycleLeading: 'cycle_leading', CycleLagging: 'cycle_lagging', Trend: 'trend', Irregular: 'irregular', MGDP: 'monthly_gdp' },
  dateColumn: 'Date',
  dateFormat: '%m/%d/%Y',
}
const AG_CREDIT: SeriesSpec = {
  url: 'https://api.data.chicagofed.org/Agriculture/Ag-Credit-Conditions.csv',
  rename: { 'Loan Demand Index': 'loan_demand_index', 'Fund Availability Index': 'fund_availability_index', 'Loan Repayment Index': 'loan_repayment_index', 'Average Loan-to-deposit Ratio (percent)': 'loan_to_deposit_ratio' },
  dateColumn: 'YYYYQ',
  dateFormat: '%Y/%m',
}
const FARM_LOANS: SeriesSpec = {
  url: 'https://api.data.chicagofed.org/Agriculture/New-Farm-Loans-Interest.csv',
  rename: { 'Operating Loans': 'operating_loans', 'Feeder Cattle Loans': 'feeder_cattle_loans', 'Farm Real Estate Loans': 'farm_real_estate_loans' },
  dateColumn: 'YYYYQ',
  dateFormat: '%Y/%m',
  coerce: true,
}
const FARMLAND: SeriesSpec = {
  url: 'https://api.data.chicagofed.org/Agriculture/Farmland-Values.csv',
  rename: { 'Year-over-year': 'year_over_year', Illinois: 'illinois', Indiana: 'indiana', Iowa: 'iowa', Wisconsin: 'wisconsin' },
  dateColumn: 'YYYYQ',
  dateFormat: '%Y/%m',
  numeric: ['year_over_year', 'illinois', 'indiana', 'iowa', 'wisconsin'],
}
const MEI: SeriesSpec = {
  url: 'https://www.chicagofed.org/-/media/publications/mei/mei-data-series-csv.csv',
  rename: { MEI: 'mei', ILIndex: 'illinois', INIndex: 'indiana', IAIndex: 'iowa', MIIndex: 'michigan', WIIndex: 'wisconsin', Regional: 'regional', Manufacturing: 'manufacturing', Construction: 'construction', Services: 'services', Consumer: 'consumer' },
  dateColumn: 'Year/Month',
  dateFormat: '%Y/%m',
}

export const nationalActivity = seriesHandler(CFNAI)
export const financialConditions = seriesHandler(NFCI)
export const braveButtersKelley = seriesHandler(BBKI)
export const agCreditConditions = seriesHandler(AG_CREDIT)
export const farmLoanRates = seriesHandler(FARM_LOANS)
export const farmlandValues = seriesHandler(FARMLAND)
export const midwestEconomy = seriesHandler(MEI)

const CFSEC_URL = 'https://api.data.chicagofed.org/CFSEC/cfsec-data-xlsx.xlsx'

export async function economicConditions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const reference = (str(params, 'date_basis') ?? 'publication') === 'reference'
  const spec: SeriesSpec = {
    url: CFSEC_URL,
    sheet: reference ? 'Data by Reference Date' : 'Data',
    rename: { Activity: 'activity', ActivityMfg: 'activity_manufacturing', ActivityNmfg: 'activity_nonmanufacturing', Outlook: 'outlook', Hiring: 'hiring', HiringExp: 'hiring_expectations', CapXExp: 'capital_spending_expectations', LaborCosts: 'labor_costs', NonlaborCosts: 'nonlabor_costs' },
    dateColumn: 'Date',
    ...(reference ? {} : { dateFormat: '%Y-%m' }),
  }
  return seriesRows(await loadFrame(ctx, spec), spec, str(params, 'start_date'), str(params, 'end_date'))
}

const CARTS_URL = (figure: string) => `https://api.data.chicagofed.org/CARTS/carts-dashboard-${figure}.csv`
const FIGURE_FILES: Record<string, string> = { weekly: 'fig1', current_month: 'fig2', monthly: 'fig3', nowcast_contributions: 'fig4', vs_census_visa: 'fig5', vs_bea_cpi: 'fig6' }
const TIMESERIES: Record<string, [Record<string, string>, string]> = {
  weekly: [{ 'Mils. $': 'Retail and Food Services Sales (Mils. $)', 'Mils. 2017$': 'Retail and Food Services Sales (Mils. 2017$)' }, '%Y-%m-%d'],
  monthly: [{ 'Mils. $': 'Sales, m/m % chg.', 'CARTS Nowcast': 'Sales Nowcast, m/m % chg.', 'Mils. 2017$': 'Inflation-adjusted Sales, m/m % chg.', 'Inflation-adjusted Nowcast': 'Inflation-adjusted Sales Nowcast, m/m % chg.' }, '%b-%Y'],
  vs_census_visa: [{ Census: 'Census Retail Sales, m/m % chg.', 'VISA SMI (minus 100)': 'VISA Spending Momentum Index (minus 100)', 'CARTS Nowcast': 'CARTS Nowcast, m/m % chg.' }, '%b-%Y'],
  vs_bea_cpi: [{ BEA: 'BEA PCE Goods, m/m % chg.', CPI: 'CPI, m/m % chg.', 'CARTS Nowcast': 'CARTS Nowcast, m/m % chg.' }, '%b-%Y'],
}

type Long = { date: string; series: string; value: number | null }

export async function retailTrade(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const figure = str(params, 'figure') ?? 'weekly'
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const figures = figure === 'nowcast_contributions' ? [figure, 'current_month'] : [figure]
  const payload: Record<string, Frame> = {}
  for (const f of figures) {
    const url = CARTS_URL(FIGURE_FILES[f]!)
    const text = await ctx.cache(`fed:file:${url}`, DAY_MS, () => ctx.http.text(url, request({ timeoutMs: 60_000 })))
    if (!text) throw new EmptyDataError('The request was returned empty.')
    payload[f] = readCsv(text)
  }

  let melted: Long[] = []
  const frame = payload[figure]!
  if (TIMESERIES[figure]) {
    const [labels, format] = TIMESERIES[figure]!
    for (const r of frame.rows) {
      const date = strptime(String(r.date), format)
      if (date === undefined) throw new Error(`time data "${String(r.date)}" doesn't match format "${format}"`)
      for (const [column, label] of Object.entries(labels)) {
        if (!frame.columns.includes(column)) throw new Error(`KeyError: '${label}'`)
        melted.push({ date, series: label, value: coerceNumber(r[column]) })
      }
    }
  } else if (figure === 'current_month') {
    for (const r of frame.rows) {
      const date = strptime(String(r.date), '%b-%Y')
      if (date === undefined) throw new Error(`time data "${String(r.date)}" doesn't match format "%b-%Y"`)
      melted.push({ date, series: String(r.metric), value: coerceNumber(String(r.value ?? 'nan').replace(/%/g, '')) })
    }
  } else {
    const snapshot = payload.current_month!
    const year = strptime(String(snapshot.rows[0]?.date), '%b-%Y')?.slice(0, 4)
    const first = frame.columns[0]!
    for (const r of frame.rows) {
      const date = strptime(`${String(r.month)}-${year}`, '%b-%Y')
      if (date === undefined) throw new Error(`time data "${String(r.month)}-${year}" doesn't match format "%b-%Y"`)
      melted.push({ date, series: String(r[first]), value: coerceNumber(r.value) })
    }
  }
  melted = melted.filter((m) => (!start || m.date >= start) && (!end || m.date <= end))
  melted.sort((a, b) => cmp(a.date, b.date) || cmp(a.series, b.series))
  const records: Row[] = melted.map((m) => ({ date: m.date, series: m.series, value: m.value === null ? null : roundValue(m.value) }))
  return pivotWide(records, ['date'], 'series', 'value')
}

const LABOR_URL = 'https://api.data.chicagofed.org/CFLMI/chi-labor-market-indicators.xlsx'
const LABOR_TABLES: Record<string, [string, boolean]> = {
  rates: ['1. Rates', false],
  realtime_unemployment: ['2. Chicago Fed Real-Time UR', false],
  unemployment_contributions: ['3. Real-Time UR Contributions', false],
  unemployment_probabilities: ['4. Real-Time UR Probs', true],
}
const RATE_LABELS: Record<string, string> = {
  layoffs_other_seps: 'Layoffs and Other Separations',
  hiring_rate_uw: 'Hiring Rate (Unemployment-Weighted)',
  fcr: 'Fundamental Churn Rate',
  s: 'Separation Rate',
  f: 'Job-Finding Rate',
}

export async function laborMarket(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = str(params, 'table') ?? 'rates'
  const [sheet, groupHeader] = LABOR_TABLES[table] ?? LABOR_TABLES.rates!
  const content = await ctx.cache(`fed:file:${LABOR_URL}`, DAY_MS, () => ctx.http.bytes(LABOR_URL, request({ timeoutMs: 60_000 })))
  const records = meltSheet(content, sheet, { groupHeader, ...(table === 'rates' ? { labels: RATE_LABELS } : {}), keyColumns: ['release'], ...(str(params, 'start_date') ? { start: str(params, 'start_date')! } : {}), ...(str(params, 'end_date') ? { end: str(params, 'end_date')! } : {}) })
  return pivotWide(records as unknown as Row[], ['date', 'release'])
}
