// federal_reserve/dallas/*, provider federal_reserve. Ported from openbb_federal_reserve/models/regional/dallas_*.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames. banking_conditions and
// global_real_economic_activity also accept the sheet names the workbooks carry now (BCS_Index_Results, Kilian Index);
// OpenBB still reads CSV_BCS_Index_Results and IGREA and fails with "Worksheet named … not found".
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { dateOf, isDateCell, isNa, numberOrNull, pivotWide, readFrame, readGrid, readGrids, toDate, toNumeric, type Cell } from '../workbook.js'
import { cmp, dateParam, download, emptyData, findLabelRow, meltTwoLevel, parseDgei, quarterToDate, readRecords, type Long } from './helpers.js'
import { BANKING_INDICATORS, MANUFACTURING_INDICATORS, SERVICE_INDICATORS, parseEnergyLong, parseKeyedSurvey, parseRetailSurvey, parseSurvey, pivotSurvey } from './survey.js'

const wide = (records: Long[]): Row[] => pivotWide(records as unknown as Row[], 'date', 'series', 'value')

const AG_FILES: Record<string, string> = {
  credit: 'agcredit.xlsx',
  lending: 'aglending.xlsx',
  interest_rates: 'agrates.xlsx',
  cash_rents: 'agrents.xlsx',
  land_values: 'agvalue.xlsx',
  loan_volume: 'agvolume.xlsx',
}

export async function agriculturalSurvey(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `https://www.dallasfed.org/-/media/Documents/research/surveys/AgSurvey/data/${AG_FILES[String(params.table ?? 'credit')]!}`)
  const grid = readGrid(bytes, 0)
  return wide(meltTwoLevel(grid, findLabelRow(grid), 'quarter', dateParam(params, 'start_date'), dateParam(params, 'end_date')))
}

/** `type` ("Index") sheet decoded with the indicator table: one column per `indicator (horizon)`. */
async function indexSurvey(ctx: NativeCtx, params: NativeParams, url: string, indicators: Record<string, string>): Promise<Row[]> {
  const bytes = await download(ctx, url)
  const records = parseSurvey(bytes, 'Index', indicators, '%b-%y', dateParam(params, 'start_date'), dateParam(params, 'end_date'))
  return pivotSurvey(records, (r) => `${r.indicator} (${r.horizon})`)
}

export const manufacturing = (params: NativeParams, ctx: NativeCtx) => indexSurvey(ctx, params, 'https://www.dallasfed.org/~/media/Documents/research/surveys/tmos/documents/index.xls', MANUFACTURING_INDICATORS)
export const serviceSector = (params: NativeParams, ctx: NativeCtx) => indexSurvey(ctx, params, 'https://www.dallasfed.org/~/media/Documents/research/surveys/tssos/documents/tssos_index.xls', SERVICE_INDICATORS)

export async function retail(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/-/media/Documents/research/surveys/tssos/documents/tros_alldata.xls')
  const records = parseRetailSurvey(bytes, 'Alldata', '%b-%y', dateParam(params, 'start_date'), dateParam(params, 'end_date'))
  return pivotSurvey(records, (r) => `${r.indicator} (${r.horizon}, ${r.response})`)
}

export async function bankingConditions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/~/media/Documents/research/surveys/bcs/documents/BCS_Index_Results.xls')
  const names = readGrids(bytes).map((g) => g.name)
  const sheet = ['CSV_BCS_Index_Results', 'BCS_Index_Results'].find((n) => names.includes(n)) ?? 'CSV_BCS_Index_Results'
  const records = parseKeyedSurvey(bytes, sheet, BANKING_INDICATORS, undefined, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
  return pivotSurvey(records, (r) => `${r.indicator} (${r.horizon})`)
}

const ENERGY_BASE = 'https://www.dallasfed.org/~/media/Documents/research/surveys/des/documents'
const ENERGY_FILES: Record<string, string> = {
  'index:quarter_over_quarter': 'index_qq.xlsx',
  'index:year_over_year': 'index_yy.xlsx',
  'all_data:quarter_over_quarter': 'all_data_qq.xlsx',
  'all_data:year_over_year': 'all_data_yy.xlsx',
  'price_expectations:quarter_over_quarter': 'all_data_price_expectations.xlsx',
  'price_expectations:year_over_year': 'all_data_price_expectations.xlsx',
  'price_forecasts:quarter_over_quarter': 'all_data_price_forecasts.xlsx',
  'price_forecasts:year_over_year': 'all_data_price_forecasts.xlsx',
}
const ENERGY_SHEETS: Record<string, string> = { all: 'All Firms', exploration_production: 'E+P Firms', support_services: 'O+G Support Services Firms' }

export async function energySurvey(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = String(params.table ?? 'index')
  const file = ENERGY_FILES[`${table}:${String(params.transform ?? 'quarter_over_quarter')}`]!
  const bytes = await download(ctx, `${ENERGY_BASE}/${file}`)
  const sheet = table === 'price_forecasts' ? ENERGY_SHEETS.all! : ENERGY_SHEETS[String(params.firm_group ?? 'all')]!
  const records = parseEnergyLong(bytes, sheet, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
  return pivotWide(records.map((r) => ({ date: r.date, column: r.indicator, value: r.value })), 'date', 'column', 'value')
}

const BREAKEVEN_SHEETS: Record<string, string> = { existing: 'Existing Wells', new: 'New Wells' }

export async function breakevenPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/-/media/documents/research/surveys/des/documents/breakeven.xlsx')
  const sheet = BREAKEVEN_SHEETS[String(params.well_type ?? 'new')]!
  const labelRow = findLabelRow(readGrid(bytes, sheet), 'play')
  const frame = readFrame(bytes, sheet, labelRow)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const quarterColumns = frame.columns.map((c, i) => [i, quarterToDate(c)] as const).filter((x): x is readonly [number, string] => x[1] !== undefined)
  const records: Row[] = []
  for (const row of frame.rows) {
    if (isNa(row[0])) continue
    const play = String(row[0]).trim()
    for (const [c, observed] of quarterColumns) {
      if ((start && observed < start) || (end && observed > end)) continue
      const value = toNumeric(row[c])
      if (value === null) continue
      records.push({ date: observed, play, value })
    }
  }
  if (records.length === 0) emptyData()
  return records.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(a.play as string, b.play as string))
}

const DGEI_BASE = 'https://www.dallasfed.org/-/media/Documents/research/international/dgei'
const DGEI_INDICATORS: Record<string, string> = {
  gdp: 'gdp.xlsx',
  cpi: 'cpi.xlsx',
  core_cpi: 'core.xlsx',
  exports: 'exp.xlsx',
  imports: 'imp.xlsx',
  industrial_production: 'ip.xlsx',
  long_term_rates: 'ltrates.xlsx',
  nominal_exchange_rate: 'ner.xlsx',
  policy_rates: 'policy.xlsx',
}
const DGEI_WEIGHTS: Record<string, string> = { us_trade: 'US Trade Weights', world_trade: 'World Trade Weights', ppp_gdp: 'PPP GDP Weights', nominal_gdp: 'Nominal GDP Weights' }

export async function globalEconomicIndicators(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${DGEI_BASE}/${DGEI_INDICATORS[String(params.indicator ?? 'gdp')]!}`)
  // The Python model reads the weighting from `query.weighting`.
  const sheet = DGEI_WEIGHTS[String(params.weighting ?? 'world_trade')]!
  return wide(parseDgei(readGrid(bytes, sheet), dateParam(params, 'start_date'), dateParam(params, 'end_date')))
}

export async function governmentDebt(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/~/media/documents/research/govdebt.xlsx')
  return wide(meltTwoLevel(readGrid(bytes, 'data'), 2, 'datetime', dateParam(params, 'start_date'), dateParam(params, 'end_date')))
}

export async function globalRealEconomicActivity(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/-/media/Documents/research/igrea/igrea.xlsx')
  const names = readGrids(bytes).map((g) => g.name)
  const frame = readFrame(bytes, names.includes('IGREA') ? 'IGREA' : 0, 0)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const rows = frame.rows.flatMap((row) => {
    const date = toDate(row[0])
    return date === undefined ? [] : [{ date, row }]
  })
  rows.sort((a, b) => cmp(a.date, b.date))
  return rows.filter(({ date }) => (!start || date >= start) && (!end || date <= end)).map(({ date, row }) => ({ date, ...(isNa(row[1]) ? {} : { value: row[1] }) }))
}

export async function leadingIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/~/media/documents/research/econdata/leadi.xlsx')
  const frame = readFrame(bytes, 'LEADI', 5)
  const rename: Record<string, string> = { Date: 'date', Index: 'index', 'Annual Average': 'annual_average', 'Year/Year Pct Change': 'yoy_change', 'Dec/Dec Pct Change': 'dec_dec_change' }
  const labels = frame.columns.map((c) => rename[c] ?? c)
  const dateAt = labels.indexOf('date')
  if (dateAt < 0) throw new Error("'date'")
  const keep = ['index', 'annual_average', 'yoy_change', 'dec_dec_change'].filter((c) => labels.includes(c))
  return datedKeep(frame.rows, labels, dateAt, keep, params)
}

export async function trimmedMeanPce(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/~/media/documents/research/pce/pcehist')
  const frame = readFrame(bytes, 'Web - Historical', 3)
  const map: Record<string, string> = { '1-month': 'one_month', '6-month': 'six_month', '12-month': 'twelve_month' }
  const labels = frame.columns.map((c, i) => (i === 0 ? 'date' : (map[c] ?? c)))
  const keep = Object.values(map).filter((c) => labels.includes(c))
  const records = datedKeep(frame.rows, labels, 0, keep, params, true)
  if (records.length === 0) emptyData()
  return records
}

/** The rows of a dated sheet with the columns `keep`, numbers coerced when `numeric`, in date order, within the window. */
function datedKeep(rows: Cell[][], labels: string[], dateAt: number, keep: string[], params: NativeParams, numeric = false): Row[] {
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const dated = rows.flatMap((row) => {
    const date = toDate(row[dateAt])
    return date === undefined ? [] : [{ date, row }]
  })
  dated.sort((a, b) => cmp(a.date, b.date))
  const out: Row[] = []
  for (const { date, row } of dated) {
    if ((start && date < start) || (end && date > end)) continue
    const record: Row = { date }
    labels.forEach((label, i) => {
      if (i === dateAt || !keep.includes(label)) return
      const v = numeric ? toNumeric(row[i]) : row[i]
      if (!isNa(v)) record[label] = v
    })
    if (numeric && !keep.some((k) => k in record)) continue
    out.push(record)
  }
  return out
}

export async function weeklyEconomicIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/-/media/documents/research/wei/weekly-economic-index.xlsx')
  const frame = readFrame(bytes, '2008-current', 0)
  const dateAt = frame.columns.indexOf('Date')
  const weiAt = frame.columns.indexOf('WEI')
  if (dateAt < 0) throw new Error("\"['Date'] not in index\"")
  if (weiAt < 0) throw new Error("\"['WEI'] not in index\"")
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const rows = frame.rows.flatMap((row) => {
    // to_datetime(format="%m/%d/%Y", errors="coerce"): date cells and "01/05/2008".
    const cell = row[dateAt]
    const date = isDateCell(cell) ? dateOf(cell as string) : typeof cell === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cell.trim()) ? toDate(cell.trim()) : undefined
    return date === undefined ? [] : [{ date, row }]
  })
  rows.sort((a, b) => cmp(a.date, b.date))
  return rows.filter(({ date }) => (!start || date >= start) && (!end || date <= end)).map(({ date, row }) => ({ date, ...(isNa(row[weiAt]) ? {} : { wei: row[weiAt] }) }))
}

export async function gigafactoryMap(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/-/media/documents/research/energy/battery.xlsx')
  const sheet = String(params.table ?? 'battery_cells') === 'cathode' ? 'Data 2' : 'Data 1'
  return readRecords(bytes, sheet).map(numericCoordinates)
}

export async function lithiumMap(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, 'https://www.dallasfed.org/-/media/documents/research/energy/lithium.xlsx')
  return readRecords(bytes, 'Data').map(numericCoordinates)
}

/** The Data models declare latitude and longitude as floats: numeric text is converted. */
function numericCoordinates(record: Row): Row {
  for (const k of ['latitude', 'longitude']) if (k in record) record[k] = numberOrNull(record[k]) ?? record[k]
  return record
}
