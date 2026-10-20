// usda/us_bioenergy_statistics, provider usda. Ported from openbb_government_us/usda/models/us_bioenergy_statistics.py and
// utils/ers_us_bioenergy_statistics.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, optString, pyFloat, pyInt } from './helpers.js'
import { sortedNested } from './helpers-a.js'

const MEDIA_PATH = '/media/6478/us-bioenergy-statistics.csv'
const DEFAULT_TABLE = 'ethanol_supply_marketing_year'
const SUBANNUAL_CADENCES = new Set(['Marketing year and quarter', 'Monthly'])

/** Table → [CSV table key, columns naming the series, whether the location labels the rows, cadence]. */
const BIOENERGY_TABLES: Record<string, [string, string[], boolean, string]> = {
  ethanol_supply_marketing_year: ['1', ['commodity', 'data_item'], false, 'Marketing year and quarter'],
  ethanol_supply_calendar_year: ['2', ['commodity', 'data_item'], false, 'Calendar year'],
  ethanol_supply_monthly: ['3', ['commodity', 'data_item'], false, 'Monthly'],
  biodiesel_supply_marketing_year: ['4.1', ['data_item'], false, 'Marketing year'],
  biodiesel_supply_calendar_year: ['4.2', ['data_item'], false, 'Calendar year'],
  renewable_diesel_supply_marketing_year: ['4.3', ['data_item'], false, 'Marketing year'],
  renewable_diesel_supply_calendar_year: ['4.4', ['data_item'], false, 'Calendar year'],
  corn_supply_and_ethanol_share: ['5', ['data_item'], false, 'Marketing year and quarter'],
  soybean_oil_supply_and_biofuel_share: ['6', ['data_item'], false, 'Marketing year'],
  oils_and_fats_supply_and_prices: ['7', ['commodity', 'data_item', 'data_item_desc'], false, 'Annual'],
  distillers_grains_supply: ['8.1', ['data_item'], false, 'Marketing year'],
  corn_gluten_meal_supply: ['8.2', ['data_item'], false, 'Marketing year'],
  corn_gluten_feed_supply: ['8.3', ['data_item'], false, 'Marketing year'],
  distillers_dried_grains_price: ['9', ['data_item'], true, 'Monthly'],
  ethanol_capacity_and_utilization: ['10', ['data_item'], false, 'Annual'],
  ethanol_capacity_by_state: ['11', ['data_item'], true, 'Annual snapshot'],
  biodiesel_renewable_diesel_plants_by_state: ['12', ['commodity', 'data_item'], true, 'Annual snapshot'],
  alternative_fuel_stations: ['13', ['commodity'], false, 'Calendar year'],
  corn_ethanol_gasoline_prices_monthly: ['14', ['commodity', 'data_item', 'data_item_desc'], false, 'Monthly'],
  ethanol_gasoline_consumption_and_share: ['15', ['commodity', 'data_item'], false, 'Calendar year'],
  biodiesel_and_diesel_prices: ['16', ['commodity'], false, 'Monthly'],
  retail_diesel_prices_monthly: ['17', ['data_item'], false, 'Monthly'],
}

type Observation = { year: number; period: string | null; periodOrd: number; location: string | null; series: string; value: number }

/** `series_label`: the series' name parts joined (repeats dropped), with the unit in brackets unless it is already there. */
function seriesLabel(components: (string | undefined)[], units: string | undefined): string {
  const parts: string[] = []
  for (const component of components) {
    const value = (component ?? '').trim()
    if (!value || isNullToken(value)) continue
    if (parts.length && parts[parts.length - 1] === value) continue
    parts.push(value)
  }
  let label = parts.join(' - ')
  const unit = (units ?? '').trim()
  if (unit && !isNullToken(unit) && unit !== label && !parts.includes(unit)) label = label ? `${label} (${unit})` : unit
  return label
}

function isAnnualToken(period: string | null): boolean {
  if (!period) return true
  const lowered = period.toLowerCase()
  return period.startsWith('Yr') || lowered === 'annual' || lowered.includes('year')
}

function timeLabel(cadence: string, year: number, period: string | null): string {
  if (period === null) return String(year)
  if (!SUBANNUAL_CADENCES.has(cadence) || isAnnualToken(period)) return String(year)
  if (period.includes(' to ')) return period
  return `${year} ${period}`
}

export async function usBioenergyStatistics(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = Object.prototype.hasOwnProperty.call(BIOENERGY_TABLES, table) ? BIOENERGY_TABLES[table] : undefined
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(BIOENERGY_TABLES).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')
  const [tableKey, seriesFields, rowLocation, cadence] = config

  // parse_table
  const rows: Observation[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, MEDIA_PATH))) {
    if (cell(row, 'table') !== tableKey) continue
    const value = pyFloat(cell(row, 'value'))
    if (value === undefined) continue
    const yearRaw = cell(row, 'year')
    if (!/^\d{4}$/.test(yearRaw)) continue
    const year = Number(yearRaw)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    rows.push({
      year,
      period: cell(row, 'period_desc') || null,
      periodOrd: pyInt(cell(row, 'period')) ?? 0,
      location: rowLocation ? cell(row, 'location') || null : null,
      series: seriesLabel(
        seriesFields.map((f) => row[f] ?? ''),
        row.units ?? '',
      ),
      value,
    })
  }

  // transform_data: a row per (location,) period label, a column per series.
  const foldLocation = new Set(rows.map((r) => r.location).filter(Boolean)).size > 1
  type Wide = { combo: number; year: number; periodOrd: number; order: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const comboOrder = new Map<string, number>()
  const colOrder: string[] = []
  rows.forEach((r, order) => {
    const location = foldLocation ? r.location : null
    const label = [location, timeLabel(cadence, r.year, r.period)].filter(Boolean).join(' — ')
    let row = pivoted.get(label)
    if (!row) {
      const comboKey = JSON.stringify([location])
      if (!comboOrder.has(comboKey)) comboOrder.set(comboKey, comboOrder.size)
      row = { combo: comboOrder.get(comboKey)!, year: r.year, periodOrd: r.periodOrd, order, period: label, values: new Map() }
      pivoted.set(label, row)
    }
    if (!colOrder.includes(r.series)) colOrder.push(r.series)
    row.values.set(r.series, r.value)
  })
  return sortedNested([...pivoted.values()], (w) => [w.combo, w.year, w.periodOrd, w.order]).map((w) => {
    const out: Row = { period: w.period }
    for (const column of colOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
