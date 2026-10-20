// federal_reserve/kc/*, provider federal_reserve. Ported from openbb_federal_reserve/models/regional/kansas_city_*.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames. ag_credit_survey, ag_interest_rates and
// ag_finance_databook resolve their files by document id on the agricultural data index, as the other ag routes do: the
// hard-coded URLs the Python code uses (Ag%20Credit/documents/…, Ag%20Finance%20Book/documents/…) answer 404 now.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { readCsvFrame } from '../csvframe.js'
import { meltSheet, pivotWide, readGrid, toDate, toNumeric, parseLooseDate, isNa, type Cell } from '../workbook.js'
import { DATA_HOST, SITE_HOST, dateParam, download, emptyData, parseKcAnnualTable, parseKcDatabook, parseKcDistrict, parseKcQuarterly, resolveKcAgUrl, type LongRecord } from './helpers.js'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const wide = (records: LongRecord[], index: string[] = ['date']): Row[] => pivotWide(records as unknown as Row[], index, 'series', 'value')

export async function agCreditSurvey(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = String(params.table ?? 'land_values')
  const id = table === 'credit_conditions' ? 7620 : 7623
  const bytes = await download(ctx, await resolveKcAgUrl(ctx, id))
  return wide(parseKcQuarterly(readGrid(bytes, 'Sheet1'), dateParam(params, 'start_date'), dateParam(params, 'end_date')))
}

const RATE_SHEETS: Record<string, string> = { operating: 'Operating', intermediate: 'Intermediate', real_estate: 'Real Estate' }

export async function agInterestRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const id = String(params.rate_type ?? 'variable') === 'fixed' ? 7621 : 7622
  const bytes = await download(ctx, await resolveKcAgUrl(ctx, id))
  return wide(parseKcQuarterly(readGrid(bytes, RATE_SHEETS[String(params.loan_type ?? 'operating')]!), dateParam(params, 'start_date'), dateParam(params, 'end_date')))
}

/** table → document id, and the sheet of the Databook tables workbook (none: the coded historical series). */
const FINANCE_SOURCES: Record<string, [id: number, sheet: string | undefined]> = {
  historical: [7228, undefined],
  farm_debt_all_banks: [7889, 'A'],
  farm_debt_ag_banks: [7889, 'B'],
  ag_bank_performance: [7889, 'C'],
}

export async function agFinanceDatabook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const [id, sheet] = FINANCE_SOURCES[String(params.table ?? 'historical')]!
  const bytes = await download(ctx, await resolveKcAgUrl(ctx, id))
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  return wide(sheet === undefined ? parseKcDatabook(bytes, start, end) : parseKcQuarterly(readGrid(bytes, sheet), start, end))
}

export async function agTermsOfLending(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, await resolveKcAgUrl(ctx, 7225))
  return wide(parseKcDatabook(bytes, dateParam(params, 'start_date'), dateParam(params, 'end_date')))
}

export async function agDistrictSurveys(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, await resolveKcAgUrl(ctx, 7230))
  let records = parseKcDistrict(bytes, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
  if (typeof params.district === 'string' && params.district) {
    const wanted = params.district.trim().toLowerCase()
    records = records.filter((r) => r.series.toLowerCase().includes(wanted))
  }
  return wide(records)
}

export async function agDatabookArchived(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${SITE_HOST}/documents/7273/Ag_Finance_Databook_Archived_-_Historical_Data.xlsx`)
  const records = parseKcAnnualTable(readGrid(bytes, String(params.table ?? 'afdr_a1')), dateParam(params, 'start_date'), dateParam(params, 'end_date'))
  return wide(records, ['date', 'frequency', 'section'])
}

export async function divisionalLmci(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${SITE_HOST}/documents/16577/DIV-LMCI.xlsx`)
  const sheet = String(params.indicator ?? 'level_of_activity') === 'momentum' ? 'Momentum' : 'Level of Activity'
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  return pivotWide(meltSheet(readGrid(bytes, sheet), { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) }))
}

const csvText = async (ctx: NativeCtx, url: string) => new TextDecoder().decode(await download(ctx, url))

/** `to_datetime(cell, format="%Y-%m-%d")`. */
function isoDate(cell: Cell | undefined): string {
  const s = String(cell ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || toDate(s) === undefined) throw new Error(`time data "${s}" doesn't match format "%Y-%m-%d"`)
  return s
}

function windowed(rows: { date: string; record: Row }[], params: NativeParams): Row[] {
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  return rows
    .filter(({ date }) => (!start || date >= start) && (!end || date <= end))
    .sort((a, b) => cmp(a.date, b.date))
    .map(({ record }) => record)
}

const withoutNa = (pairs: [string, Cell | undefined][]): Row => Object.fromEntries(pairs.filter(([, v]) => !isNa(v))) as Row

export async function financialStressIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frame = readCsvFrame(await csvText(ctx, `${DATA_HOST}/kc-fsi/kcfsi.csv`))
  const dateAt = frame.columns.indexOf('DATE')
  if (dateAt < 0) throw new Error("'date'")
  const rows = frame.rows.map((row) => {
    const date = isoDate(row[dateAt])
    return { date, record: { date, ...withoutNa(frame.columns.flatMap((c, i): [string, Cell | undefined][] => (i === dateAt ? [] : [[c === 'KCFSI' ? 'kcfsi' : c, row[i]]]))) } }
  })
  return windowed(rows, params)
}

const NATURAL_RATE_COLUMNS = ['date', 'rstar', 'rstar_lower', 'rstar_upper', 'ustar', 'ustar_lower', 'ustar_upper']

export async function naturalRate(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // pandas: read_csv(header=None, skiprows=2), then the seven columns are named.
  const all = readCsvFrame(await csvText(ctx, `${DATA_HOST}/kc-mbnr/KCFed_ModelBased_Rstar_Ustar.csv`), { skipRows: 2, noHeader: true })
  const rows = all.rows.map((row) => {
    const date = isoDate(row[0])
    return { date, record: { date, ...withoutNa(NATURAL_RATE_COLUMNS.slice(1).map((c, i): [string, Cell | undefined] => [c, row[i + 1]])) } }
  })
  return windowed(rows, params)
}

export async function policyRateUncertainty(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frame = readCsvFrame(await csvText(ctx, `${DATA_HOST}/kc-prs/KCPRU_KCPRS.csv`))
  const at = (name: string): number => {
    const i = frame.columns.indexOf(name)
    if (i < 0) throw new Error(`"['${name}'] not in index"`)
    return i
  }
  const [yearAt, monthAt, dayAt, uAt, sAt] = [at('Year'), at('Month'), at('Day'), at('KCPRU'), at('KCPRS')]
  const rows = frame.rows.map((row) => {
    const date = parseLooseDate(`${Math.trunc(Number(row[yearAt]))}-${Math.trunc(Number(row[monthAt]))}-${Math.trunc(Number(row[dayAt]))}`)
    if (date === undefined) throw new Error(`cannot assemble the datetimes: ${row[yearAt]}-${row[monthAt]}-${row[dayAt]}`)
    return { date, record: { date, ...withoutNa([['kcpru', row[uAt]], ['kcprs', row[sAt]]]) } }
  })
  return windowed(rows, params)
}

const RORO_COLUMNS: Record<string, string> = { z_spreads: 'spreads', z_equities: 'equities', z_liquidity: 'liquidity', z_goldcurrency: 'gold_currency', z_roro: 'roro' }
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export async function riskIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const file = String(params.frequency ?? 'daily') === 'weekly' ? 'roro_weekly.csv' : 'roro_daily.csv'
  const frame = readCsvFrame(await csvText(ctx, `${DATA_HOST}/kc-roro/${file}`))
  const dateAt = frame.columns.indexOf('t')
  if (dateAt < 0) throw new Error("'date'")
  const sources = Object.keys(RORO_COLUMNS).map((c) => frame.columns.indexOf(c))
  const names = Object.values(RORO_COLUMNS)
  const rows: { date: string; record: Row }[] = []
  for (const row of frame.rows) {
    // "%d%b%Y" of the lower-cased text: 02jan2003.
    const m = /^(\d{1,2})([a-z]{3})(\d{4})$/.exec(String(row[dateAt] ?? '').toLowerCase())
    const month = m ? MONTHS.indexOf(m[2]!) : -1
    if (!m || month < 0) throw new Error(`time data "${row[dateAt]}" doesn't match format "%d%b%Y"`)
    const date = `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
    const values = sources.map((i) => (i < 0 ? null : row[i]))
    if (values.every(isNa)) continue
    rows.push({ date, record: { date, ...withoutNa(names.map((n, k): [string, Cell | undefined] => [n, values[k]])) } })
  }
  if (rows.length === 0) emptyData()
  return windowed(rows, params)
}

export { toNumeric }
