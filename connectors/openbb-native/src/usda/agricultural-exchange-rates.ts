// usda/agricultural_exchange_rates, provider usda. Ported from openbb_government_us/usda/models/agricultural_exchange_rates.py
// and utils/ers_agricultural_exchange_rates.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { BILATERAL_REGIONS, EXCHANGE_RATE_FILES, INDEX_WEIGHTS, MONTH_ORDER } from './agricultural-exchange-rates-files.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, pyFloat, sortedBy } from './helpers.js'

const DEFAULT_TABLE = 'real_index_annual'
const DEFAULT_WEIGHTS = 'U.S. markets (U.S. export weights)'

type Observation = { year: number; month: string | null; monthOrder: number | null; value: number; weights: string | null; region: string | null; series: string }

export async function agriculturalExchangeRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = String(params.table ?? '').trim() || DEFAULT_TABLE
  const config = EXCHANGE_RATE_FILES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(EXCHANGE_RATE_FILES).join(', ')}`)
  // An absent weights takes the default; a blank one means "all three schemes".
  const weights = params.weights === undefined ? DEFAULT_WEIGHTS : String(params.weights).trim() || null
  const region = params.region === undefined ? null : String(params.region).trim() || null
  if (config.kind === 'index' && weights !== null && !INDEX_WEIGHTS.includes(weights)) throw new Error(`Invalid weight scheme: ${weights}. Valid schemes are: ${INDEX_WEIGHTS.join(', ')}`)
  if (config.kind === 'bilateral' && region !== null && !BILATERAL_REGIONS.includes(region)) throw new Error(`Invalid region: ${region}. Valid regions are: ${BILATERAL_REGIONS.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const hasMonth = config.frequency === 'monthly'
  const filtered: Observation[] = []
  for (const r of csvDictRows(await fetchErsText(ctx, config.media))) {
    const value = pyFloat(cell(r, 'Value'))
    if (value === undefined) continue
    const yearLabel = cell(r, 'Year')
    if (!/^\d+$/.test(yearLabel)) continue
    const month = hasMonth ? cell(r, 'Month') : ''
    const record: Observation = {
      year: Number(yearLabel),
      month: month || null,
      monthOrder: month ? (MONTH_ORDER[month] ?? null) : null,
      value,
      weights: config.kind === 'index' ? cell(r, 'Weights') || null : null,
      region: config.kind === 'index' ? null : cell(r, 'Region') || null,
      series: config.kind === 'index' ? cell(r, 'Commodity') : cell(r, 'Country'),
    }
    if ((startYear !== undefined && record.year < startYear) || (endYear !== undefined && record.year > endYear)) continue
    if (config.kind === 'index' && weights !== null && record.weights !== weights) continue
    if (config.kind === 'bilateral' && region !== null && record.region !== region) continue
    filtered.push(record)
  }
  if (filtered.length === 0) throw new Error('No records match the given filters.')

  const weightsVary = new Set(filtered.map((r) => r.weights).filter(Boolean)).size > 1
  type Wide = { weightsOrder: number; year: number; monthOrder: number; row: Row }
  const pivoted = new Map<string, Wide>()
  const columns: string[] = []
  const seen = new Set<string>()
  for (const r of filtered) {
    const key = JSON.stringify([r.weights, r.year, r.month])
    let wide = pivoted.get(key)
    if (!wide) {
      const timeLabel = r.month ? `${r.year} ${r.month}` : String(r.year)
      wide = {
        weightsOrder: r.weights !== null && INDEX_WEIGHTS.includes(r.weights) ? INDEX_WEIGHTS.indexOf(r.weights) : INDEX_WEIGHTS.length,
        year: r.year,
        monthOrder: r.monthOrder ?? 0,
        row: { period: weightsVary && r.weights ? `${r.weights} — ${timeLabel}` : timeLabel },
      }
      pivoted.set(key, wide)
    }
    if (!seen.has(r.series)) {
      seen.add(r.series)
      columns.push(r.series)
    }
    wide.row[r.series] = r.value
  }
  return sortedBy([...pivoted.values()], (w) => [w.weightsOrder, -w.year, -w.monthOrder]).map((w) => {
    const out: Row = { period: w.row.period }
    for (const column of columns) out[column] = w.row[column] ?? null
    return nullTokensToNone(out)
  })
}
