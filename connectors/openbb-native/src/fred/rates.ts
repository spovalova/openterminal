// fixedincome/rate/*, fixedincome/spreads/*, provider fred. Ported from openbb_fred/models/{ameribor, dwpcr_rates,
// ecb_interest_rates, federal_funds_rate, fed_projections, euro_short_term_rate, iorb_rates,
// overnight_bank_funding_rate, sofr, sonia_rates, tmc, ffrmc, tbffr}.py and utils/fred_helpers.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic models.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import data from './data.json' with { type: 'json' }
import { apiKey, getObservations, getObservationsMany, text, today, toFloat, useCache } from './helpers.js'
import { fetchSeries, type SeriesRow } from './series.js'

type Json = Record<string, any>
const D = data as unknown as Json

/** `float(v) if v else None`: the validators that turn a zero, like a missing value, into None. */
const truthyFloat = (v: unknown): number | null => (v ? Number(v) : null)

/** The query parameters every series-based rate takes: `frequency`, `aggregation_method` and `transform` stay None unless given. */
function seriesOptions(params: NativeParams) {
  return {
    frequency: text(params, 'frequency') ?? null,
    aggregation_method: text(params, 'aggregation_method') ?? null,
    transform: text(params, 'transform') ?? null,
    use_cache: useCache(params),
  }
}

/** The text of a lookup key, or a KeyError message like Python's. */
function lookup(map: Record<string, string>, key: string): string {
  const v = map[key]
  if (v === undefined) throw new Error(`'${key}'`)
  return v
}

// ---- a single series, one observation per row ---------------------------------------------------------------------

/** `float(v)` for an observation, None when it is not a number (`value_validate`: only a ValueError is caught). */
const observationRate = (v: unknown): number | null => (typeof v === 'string' && v.trim() !== '' ? toFloat(v) : toFloat(v))

type Single = { id: (params: NativeParams) => string; selectColumns: boolean }

/** The routes that read one series: its observations are the rows, the value as `rate`. */
function single(spec: Single): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const key = apiKey(ctx)
    const observations = await getObservations(ctx, spec.id(params), key, { start: text(params, 'start_date'), end: text(params, 'end_date'), useCache: useCache(params) })
    return observations.map((o) => {
      const rate = observationRate(o.value)
      // IORB and SONIA keep only the date and the value; the others hand the whole observation to the model.
      const row: Row = spec.selectColumns ? { date: o.date } : { realtime_start: o.realtime_start, realtime_end: o.realtime_end, date: o.date }
      if (rate !== null) row.rate = rate
      if (!spec.selectColumns) for (const [k, v] of Object.entries(o)) if (!(k in row) && k !== 'value') row[k] = v
      return row
    })
  }
}

export const iorb = single({ id: () => 'IORB', selectColumns: true })
export const sonia = single({ id: (p) => lookup(D.soniaParameterToId, text(p, 'parameter') ?? 'rate'), selectColumns: true })
export const dpcredit = single({ id: (p) => lookup(D.dwpcr, text(p, 'parameter') ?? 'daily_excl_weekend'), selectColumns: false })
export const ecb = single({ id: (p) => lookup(D.ecb, (text(p, 'interest_rate_type') ?? 'lending').toLowerCase()), selectColumns: false })
export const tcm = single({ id: (p) => lookup(D.treasuryConstantMaturity, (text(p, 'maturity') ?? '3m').toLowerCase()), selectColumns: false })
export const tcmEffr = single({ id: (p) => lookup(D.selectedTreasuryConstantMaturity, (text(p, 'maturity') ?? '10y').toLowerCase()), selectColumns: false })
export const treasuryEffr = single({ id: (p) => lookup(D.selectedTreasuryBill, (text(p, 'maturity') ?? '3m').toLowerCase()), selectColumns: false })

// ---- the Federal Reserve's projections ------------------------------------------------------------------------------

export async function effrForecast(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const longRun = params.long_run === true || params.long_run === 'true' ? 1 : 0
  const names = Object.keys(D.projections)
  const series = await getObservationsMany(ctx, names.map((name) => D.projections[name][longRun] as string), key, { useCache: useCache(params) })
  // process_projections: one row per date any of the series has, None where one has no value.
  const bySeries = names.map((_, i) => series[i]!)
  const dates = [...new Set(bySeries.flatMap((obs) => obs.map((o) => o.date as string)))].sort()
  return dates.map((date) => {
    const row: Row = { date }
    names.forEach((name, i) => {
      const found = bySeries[i]!.filter((o) => o.date === date).map((o) => o.value)
      if (found.length === 0 || found[0] === '.') return
      const n = toFloat(found[0])
      if (n === null) throw new Error(`could not convert string to float: '${found[0]}'`)
      row[name] = n
    })
    return row
  })
}

// ---- rates published as several series: the series table, then one column per series --------------------------------

/** The rows of a series table whose key series has a value, with each column under its field name. */
function wideRows(rows: SeriesRow[], idToField: Record<string, string>, required: string, validated: ReadonlySet<string>): Row[] {
  const out: Row[] = []
  for (const r of rows) {
    if (!r[required]) continue
    const row: Row = { date: r.date }
    for (const [id, field] of Object.entries(idToField)) {
      if (!(id in r)) continue
      const v = r[id]
      const value = validated.has(field) ? truthyFloat(v) : v
      if (value !== null && value !== undefined) row[field] = value
    }
    out.push(row)
  }
  return out
}

export async function sofr(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const idToField: Record<string, string> = { SOFR: 'rate', SOFR1: 'percentile_1', SOFR25: 'percentile_25', SOFR75: 'percentile_75', SOFR99: 'percentile_99', SOFRVOL: 'volume', SOFR30DAYAVG: 'average_30d', SOFR90DAYAVG: 'average_90d', SOFR180DAYAVG: 'average_180d', SOFRINDEX: 'index' }
  const result = await fetchSeries(ctx, key, { symbol: Object.keys(idToField).join(','), start_date: text(params, 'start_date') ?? '2018-04-02', end_date: text(params, 'end_date') ?? null, ...seriesOptions(params) })
  const percent = new Set(['rate', 'percentile_1', 'percentile_25', 'percentile_75', 'percentile_99', 'average_30d', 'average_90d', 'average_180d'])
  return wideRows(result.rows, idToField, 'SOFR', percent)
}

export async function overnightBankFunding(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const idToField: Record<string, string> = { OBFR: 'rate', OBFR1: 'percentile_1', OBFR25: 'percentile_25', OBFR75: 'percentile_75', OBFR99: 'percentile_99', OBFRVOL: 'volume' }
  const result = await fetchSeries(ctx, key, { symbol: Object.keys(idToField).join(','), start_date: text(params, 'start_date') ?? null, end_date: text(params, 'end_date') ?? null, ...seriesOptions(params) })
  const percent = new Set(['rate', 'percentile_1', 'percentile_25', 'percentile_75', 'percentile_99'])
  return wideRows(result.rows, idToField, 'OBFR', percent)
}

export async function estr(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const idToField: Record<string, string> = {
    ECBESTRVOLWGTTRMDMNRT: 'rate',
    ECBESTRNUMTRANS: 'transactions',
    ECBESTRNUMACTBANKS: 'number_of_banks',
    ECBESTRTOTVOL: 'volume',
    ECBESTRSHRVOL5LRGACTBNK: 'large_bank_share_of_volume',
    ECBESTRRT75THPCTVOL: 'percentile_75',
    ECBESTRRT25THPCTVOL: 'percentile_25',
  }
  const result = await fetchSeries(ctx, key, { symbol: Object.keys(idToField).join(','), start_date: text(params, 'start_date') ?? '2019-10-02', end_date: text(params, 'end_date') ?? null, ...seriesOptions(params) })
  const percent = new Set(['rate', 'percentile_25', 'percentile_75', 'large_bank_share_of_volume'])
  return wideRows(result.rows, idToField, 'ECBESTRVOLWGTTRMDMNRT', percent)
}

export async function effr(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const effrOnly = params.effr_only === true || params.effr_only === 'true'
  const ids: Record<string, string> = { rate: 'DFF', target_range_upper: 'DFEDTARU', target_range_lower: 'DFEDTARL', percentile_1: 'EFFR1', percentile_25: 'EFFR25', percentile_75: 'EFFR75', percentile_99: 'EFFR99', volume: 'EFFRVOL' }
  // transform_query: from 2016 (the whole history for the rate alone) to today.
  const start = text(params, 'start_date') ?? (effrOnly ? null : '2016-01-01')
  const end = text(params, 'end_date') ?? today(ctx)
  const result = await fetchSeries(ctx, key, { symbol: effrOnly ? 'DFF' : Object.values(ids).join(','), start_date: start, end_date: end, ...seriesOptions(params) })
  // DataFrame.dropna(): a date counts only when every series has a value for it.
  const complete = result.rows.filter((r) => Object.entries(r).every(([, v]) => v !== null))
  if (complete.length === 0) throw new Error('There was an error with the request and it was returned empty.')
  const byId = Object.fromEntries(Object.entries(ids).map(([field, id]) => [id, field]))
  return complete.map((r) => {
    const row: Row = {}
    for (const [k, v] of Object.entries(r)) row[k === 'date' ? 'date' : (byId[k] ?? k)] = v
    return row
  })
}

export async function ameribor(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const maturity = text(params, 'maturity') ?? 'all'
  const maturities = maturity.split(',')
  const all = D.ameriborMaturityToId as Record<string, string>
  const ids = maturities.includes('all') ? all.all! : maturities.length === 1 ? lookup(all, maturity) : maturities.map((m) => lookup(all, m)).join(',')
  const result = await fetchSeries(ctx, key, { symbol: ids, start_date: text(params, 'start_date') ?? null, end_date: text(params, 'end_date') ?? null, ...seriesOptions(params) })
  if (result.rows.length === 0) throw new Error('The request was returned with no data.')
  const names: Record<string, string> = { AMERIBOR: 'overnight', AMBOR30: 'day_30', AMBOR90: 'day_90', AMBOR30T: 'day_30', AMBOR90T: 'day_90' }
  const order = ['overnight', 'day_30', 'day_90']
  // melt(id_vars='date'), keep the values, sort by date then by maturity in that order.
  const long: Row[] = []
  for (const symbol of Object.keys(result.metadata)) {
    for (const r of result.rows) {
      const rate = r[symbol]
      if (rate === null || rate === undefined) continue
      long.push({ date: r.date, symbol, maturity: names[symbol] ?? symbol, rate, title: (result.metadata[symbol]?.title as string | undefined) ?? symbol })
    }
  }
  const rank = (m: unknown) => {
    const i = order.indexOf(String(m))
    return i < 0 ? Infinity : i
  }
  return long.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : rank(a.maturity) - rank(b.maturity)))
}
