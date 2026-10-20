// usda/season_average_price_forecasts, provider usda. Ported from openbb_government_us/usda/models/season_average_price_forecasts.py
// and utils/ers_season_average_price_forecasts.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic
// models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, pyFloat, pyInt } from './helpers.js'

const OUTPUT_FORECAST = '/media/6497/output-forecast-csv-file.csv'
const COMMODITIES = ['Corn', 'Cotton', 'Soybeans', 'Wheat']
const DEFAULT_COMMODITY = 'Corn'

/** The model's float fields; every other column stays text. */
const NUMBER_FIELDS = new Set([
  'mya_price_model_forecast', 'mya_price_wasde_forecast', 'target_price', 'national_loan_rate', 'direct_payment_rate', 'reference_price',
  'ccp_effective_price_model_forecast', 'ccp_rate_model_forecast', 'ccp_effective_price_wasde_forecast', 'ccp_rate_wasde_forecast',
  'historical_mya_price_year1', 'historical_mya_price_year2', 'historical_mya_price_year3', 'historical_mya_price_year4', 'historical_mya_price_year5',
  'historical_mya_price_5year_olympic_average', 'effective_reference_price', 'effective_price_model_forecast', 'plc_payment_rate_model_forecast',
  'effective_price_wasde_forecast', 'plc_payment_rate_wasde_forecast', 'maximum_plc_payment_rate',
  'arc_annual_benchmark_price_year1', 'arc_annual_benchmark_price_year2', 'arc_annual_benchmark_price_year3', 'arc_annual_benchmark_price_year4', 'arc_annual_benchmark_price_year5',
  'arc_co_benchmark_price', 'arc_co_price_model_forecast', 'arc_co_price_wasde_forecast', 'arc_ic_price_model_forecast', 'arc_ic_price_wasde_forecast', 'actual_mya_price',
])

export async function seasonAveragePriceForecasts(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const raw = Array.isArray(params.commodity) ? params.commodity[0] : params.commodity
  const requested = raw === undefined || raw === null || raw === '' ? DEFAULT_COMMODITY : String(raw).trim()
  const commodity = COMMODITIES.find((name) => name.toLowerCase() === requested.toLowerCase())
  if (commodity === undefined) throw new Error(`Invalid commodity: ${requested}. Valid commodities are: ${COMMODITIES.join(', ')}`)
  const latest = params.latest === true || params.latest === 'true'
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_output_forecast: lower-cased column names, stripped values; the rows of this commodity.
  const data: Record<string, string>[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, OUTPUT_FORECAST))) {
    const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value === undefined ? '' : value.trim()]))
    if (!record.commodity) continue
    if (record.commodity === commodity) data.push(record)
  }

  // transform_data: the latest model run only when asked, the year window, newest first.
  const latestDate = data.length ? data.map((r) => r.model_forecast_date!).reduce((a, b) => (b > a ? b : a)) : undefined
  const selected: Record<string, string>[] = []
  for (const record of data) {
    if (latest && record.model_forecast_date !== latestDate) continue
    const year = pyInt(record.marketing_year ?? '')
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${record.marketing_year}'`)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    selected.push(record)
  }
  // sort(key=(commodity, forecast date, marketing year), reverse=True): descending, equal keys keep their order.
  const descending = [...selected]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      for (const [x, y] of [
        [a.r.commodity!, b.r.commodity!],
        [a.r.model_forecast_date!, b.r.model_forecast_date!],
        [pyInt(a.r.marketing_year!)!, pyInt(b.r.marketing_year!)!],
      ] as [string | number, string | number][]) {
        if (x !== y) return x < y ? 1 : -1
      }
      return a.i - b.i
    })
    .map((x) => x.r)

  return descending.map((record) => {
    const out: Row = {}
    for (const [key, value] of Object.entries(record)) {
      if (isNullToken(value)) out[key] = null
      else if (NUMBER_FIELDS.has(key)) {
        const n = pyFloat(value)
        if (n === undefined) throw new Error(`Input should be a valid number, unable to parse string as a number: ${key}='${value}'`)
        out[key] = n
      } else out[key] = value
    }
    return nullTokensToNone(out)
  })
}
