// economy/gdp/real, economy/gdp/nominal and economy/gdp/forecast, provider oecd. Ported from
// openbb_oecd/models/{gdp_real,gdp_nominal,gdp_forecast}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models.
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { areaLabel, countryCodes, countryParam, dateWindow, fetchRows, observation, thisYear } from './common.js'
import { oecdDate } from './query-builder.js'

const bySort = (a: Row, b: Row): number => {
  const da = a.date as string
  const db = b.date as string
  if (da !== db) return da < db ? -1 : 1
  return -(a.value as number) - -(b.value as number)
}

export async function gdpReal(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const frequency = text(params, 'frequency') ?? 'quarter'
  if (frequency !== 'quarter' && frequency !== 'annual') throw new Error(`Input should be 'quarter' or 'annual', got '${frequency}' (frequency)`)
  const { start, end } = dateWindow(params, ctx, { all: '2020-01-01', one: '1947-01-01' })
  const rows = await fetchRows(ctx, 'DF_QNA', {
    start,
    end,
    dimensions: { FREQ: frequency === 'quarter' ? 'Q' : 'A', REF_AREA: countryCodes('DF_QNA', country), SECTOR: 'S1', TRANSACTION: 'B1GQ', INSTR_ASSET: '_Z', UNIT_MEASURE: 'USD_PPP', PRICE_BASE: 'LR', TRANSFORMATION: 'LA', TABLE_IDENTIFIER: 'T0102' },
  })
  const output: Row[] = []
  for (const row of rows) {
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined || d < start || d > end) continue
    const value = observation(row)
    if (value === undefined) continue
    output.push({ date: d, country: areaLabel(row), value: Math.trunc(value * 1_000_000) })
  }
  return output.sort(bySort)
}

const UNIT_DATAFLOW: Record<string, string> = { level: 'USD', index: 'INDICES', capita: 'CAPITA' }

export async function gdpNominal(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const frequency = text(params, 'frequency') ?? 'quarter'
  if (frequency !== 'quarter' && frequency !== 'annual') throw new Error(`Input should be 'quarter' or 'annual', got '${frequency}' (frequency)`)
  const units = text(params, 'units') ?? 'level'
  if (!(units in UNIT_DATAFLOW)) throw new Error(`Input should be 'level', 'index' or 'capita', got '${units}' (units)`)
  const priceBaseParam = text(params, 'price_base') ?? 'current_prices'
  if (priceBaseParam !== 'current_prices' && priceBaseParam !== 'volume') throw new Error(`Input should be 'current_prices' or 'volume', got '${priceBaseParam}' (price_base)`)
  const { start, end } = dateWindow(params, ctx, { all: '2020-01-01', one: '1947-01-01' })

  const dataflow = `DF_QNA_EXPENDITURE_${UNIT_DATAFLOW[units]}`
  let priceBase = priceBaseParam === 'current_prices' ? 'V' : 'LR'
  if (units === 'index' && priceBase === 'V') priceBase = 'DR'
  const rows = await fetchRows(ctx, dataflow, {
    start,
    end,
    dimensions: { FREQ: frequency === 'quarter' ? 'Q' : 'A', REF_AREA: countryCodes(dataflow, country), SECTOR: 'S1', TRANSACTION: units === 'capita' ? 'B1GQ_POP' : 'B1GQ', PRICE_BASE: priceBase },
  })
  const isLevel = units === 'level'
  const output: Row[] = []
  for (const row of rows) {
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined || d < start || d > end) continue
    let value = observation(row)
    if (value === undefined) continue
    if (isLevel) value = Math.trunc(value * 1_000_000)
    output.push({ date: d, country: areaLabel(row), value })
  }
  return output.sort(bySort)
}

const MEASURE_MAP: Record<string, string> = { current_prices: 'GDP_USD', volume: 'GDPV_USD', capita: 'GDPVD_CAP', growth: 'GDPV_ANNPCT', deflator: 'PGDP' }

export async function gdpForecast(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = text(params, 'country') || 'all'
  const frequency = text(params, 'frequency') ?? 'annual'
  if (frequency !== 'annual' && frequency !== 'quarter') throw new Error(`Input should be 'annual' or 'quarter', got '${frequency}' (frequency)`)
  const units = text(params, 'units') ?? 'volume'
  if (!(units in MEASURE_MAP)) throw new Error(`Input should be 'current_prices', 'volume', 'capita', 'growth' or 'deflator', got '${units}' (units)`)
  const year = thisYear(ctx)
  const start = text(params, 'start_date') || `${String(year).padStart(4, '0')}-01-01`
  const end = text(params, 'end_date') || `${String(year + 2).padStart(4, '0')}-12-31`

  let freqCode = frequency === 'quarter' ? 'Q' : 'A'
  // Capita data exists for years only.
  if (units === 'capita' && freqCode === 'Q') freqCode = 'A'
  const rows = await fetchRows(ctx, 'DF_EO', { start, end, dimensions: { REF_AREA: countryCodes('DF_EO', country), MEASURE: MEASURE_MAP[units]!, FREQ: freqCode } })
  const isGrowth = units === 'growth'
  const isDeflator = units === 'deflator'
  const output: Row[] = []
  for (const row of rows) {
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined) continue
    let value = observation(row)
    if (value === undefined) continue
    if (isGrowth) value = value / 100
    else if (!isDeflator) value = Math.trunc(value)
    if (value <= 0) continue
    output.push({ date: d, country: areaLabel(row), value })
  }
  return output.sort(bySort)
}
