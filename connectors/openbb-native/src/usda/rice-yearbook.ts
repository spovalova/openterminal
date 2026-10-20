// usda/rice_yearbook, provider usda. Ported from openbb_government_us/usda/models/rice_yearbook.py and
// utils/ers_rice_yearbook.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, cell, fetchErsText, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { classifyDimsFull, dimValue, isDigits, sortedNested, type Rec } from './helpers-a.js'

const DEFAULT_TABLE = 'us_supply_disappearance_price'
const ANNUAL = 'Annual'
const MONTHLY = 'Monthly'
const WEEKLY = 'Weekly'
const POINT_IN_TIME = 'Point-in-time'
const FREQUENCY_ORDER = [MONTHLY, WEEKLY, POINT_IN_TIME, ANNUAL]
const FOLD_DIM_FIELDS = ['rice_class', 'location', 'rank', 'aggregate_level']

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
const MARKETING_MONTHS = ['AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER', 'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY']

const ACREAGE = '/media/5670/us-rice-acreage-production-and-yield.csv'
const SUPPLY = '/media/5676/us-supply-disappearance-and-stocks.csv'
const STOCKS = '/media/5678/rice-stocks-rough-and-milled-1983-to-present.csv'
const EXPORTS = '/media/5672/us-rice-exports-by-type-and-top-10-us-rice-export-markets.csv'
const IMPORTS = '/media/5674/us-rice-imports-by-origin-market-years.csv'
const PRICES = '/media/5664/us-rough-and-milled-rice-prices-monthly-and-marketing-year.csv'
const PROGRAM = '/media/5666/program-payment-rates.csv'
const WORLD_SUPPLY = '/media/5680/world-rice-supply-and-utilization-196061-to-present.csv'
const WORLD_TRADE = '/media/5682/world-rice-trade-milled-basis-exports-and-imports-of-selected-countries-or-regions.csv'
const ASIA_PRICES = '/media/5668/export-prices-for-thailand-vietnam-india-and-pakistan.csv'

/** Table → [media file, TABLE_NUMBER]. */
const RICE_TABLES: Record<string, [string, string]> = {
  us_area_planted_by_class: [ACREAGE, '1'],
  us_state_yields: [ACREAGE, '2'],
  us_acreage_yield_production: [ACREAGE, '3'],
  us_production_by_class: [ACREAGE, '4'],
  us_state_acreage_yield_production_by_class: [ACREAGE, '5'],
  us_production_class_distribution: [ACREAGE, '6'],
  us_supply_use_by_class: [SUPPLY, '7'],
  us_supply_disappearance_price: [SUPPLY, '8'],
  long_grain_supply_disappearance_price: [SUPPLY, '9'],
  medium_short_grain_supply_disappearance_price: [SUPPLY, '10'],
  us_stocks_rough_and_milled: [STOCKS, '11'],
  us_exports_by_type: [EXPORTS, '12'],
  us_top_export_markets: [EXPORTS, '13'],
  us_imports_by_origin: [IMPORTS, '14'],
  us_rough_price_by_month: [PRICES, '15'],
  us_rough_price_by_month_and_class: [PRICES, '16'],
  us_milled_price_milling_centers: [PRICES, '17'],
  us_byproduct_prices: [PRICES, '18'],
  us_brewers_rice_prices: [PRICES, '19'],
  us_prices_and_payment_rates: [PROGRAM, '20'],
  us_class_loan_values: [PROGRAM, '21'],
  world_market_prices_loan_basis: [PROGRAM, '22'],
  world_supply_and_utilization: [WORLD_SUPPLY, '23'],
  world_trade_milled_basis: [WORLD_TRADE, '24'],
  thailand_export_prices: [ASIA_PRICES, '25'],
  vietnam_export_prices: [ASIA_PRICES, '26'],
  india_export_prices: [ASIA_PRICES, '27'],
  pakistan_export_prices: [ASIA_PRICES, '28'],
}

const NULL_TOKENS = new Set(['', '-', '--', 'n/a', 'na', 'null', 'none', 'nan'])

/** `clean_token`: stripped text, or missing for blanks and placeholders. */
function cleanToken(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  return text === '' || NULL_TOKENS.has(text.toLowerCase()) ? null : text
}

function classifyFrequency(period: string | null): string {
  if (period === null) return ANNUAL
  const upper = period.toUpperCase()
  if (MONTHS.includes(upper)) return MONTHLY
  if (upper.startsWith('CROP YEAR') || upper.startsWith('MARKETING YEAR') || upper === 'CALENDAR YEAR' || upper === 'MARKETING') return ANNUAL
  const parts = period.trim().split(/\s+/)
  if (parts.length === 2 && MONTHS.includes(parts[0]!.toUpperCase()) && isDigits(parts[1]!)) return POINT_IN_TIME
  return WEEKLY
}

/** `display_period`: month names in title case, everything else as published. */
function displayPeriod(period: string | null): string | null {
  if (period === null) return null
  return MONTHS.includes(period.toUpperCase()) ? period.charAt(0).toUpperCase() + period.slice(1).toLowerCase() : period
}

function weeklySortKey(display: string): number {
  let month = 0
  let day = 0
  for (const token of display.split(' - ')[0]!.replace(/-/g, ' ').split(/\s+/).filter(Boolean)) {
    if (isDigits(token)) {
      day = Number(token)
      continue
    }
    const name = token.toUpperCase()
    if (name.length < 3) continue
    const rank = MONTHS.findIndex((label) => label.startsWith(name))
    if (rank >= 0) month = rank + 1
  }
  return month * 100 + day
}

function periodSortKey(display: string | null, frequency: string): number {
  if (display === null) return 0
  if (frequency === WEEKLY) return weeklySortKey(display)
  if (frequency === MONTHLY || frequency === POINT_IN_TIME) {
    const rank = MARKETING_MONTHS.indexOf(display.split(/\s+/)[0]!.toUpperCase())
    return rank + 1
  }
  return 0
}

/** `_basis_partitions_series`: the period (price basis) splits the series instead of repeating them. */
function basisPartitionsSeries(rows: readonly Rec[]): boolean {
  const bases = new Set(rows.map((r) => r.period))
  if (bases.size < 2) return false
  const seriesBases = new Map<string, Set<unknown>>()
  for (const r of rows) {
    const key = r.series as string
    let set = seriesBases.get(key)
    if (!set) seriesBases.set(key, (set = new Set()))
    set.add(r.period)
  }
  let total = 0
  for (const s of seriesBases.values()) total += s.size
  return total / seriesBases.size <= 0.6 * bases.size
}

export async function riceYearbook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = Object.prototype.hasOwnProperty.call(RICE_TABLES, table) ? RICE_TABLES[table] : undefined
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(RICE_TABLES).join(', ')}`)
  const requested = optString(params, 'frequency')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_table
  const data: Rec[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, config[0]))) {
    if (cell(row, 'TABLE_NUMBER') !== config[1]) continue
    const value = pyFloat(cell(row, 'VALUE'))
    if (value === undefined) continue
    const yearLabel = cell(row, 'YEAR')
    if (!isDigits(yearLabel.slice(0, 4))) continue
    data.push({
      year: Number(yearLabel.slice(0, 4)),
      period: cleanToken(row.REFERENCE_PERIOD_DESCRIPTION),
      rice_class: cleanToken(row.CLASS_DESCRIPTION),
      location: cleanToken(row.LOCATION_DESCRIPTION),
      rank: cleanToken(row.RANK),
      aggregate_level: cleanToken(row.AGGREGATE_LEVEL_DESCRIPTION),
      series: cell(row, 'STATISTIC_DESCRIPTION'),
      unit: cleanToken(row.UNIT_DESCRIPTION),
      value,
    })
  }
  if (data.length === 0) return []

  // _resolve_frequency
  const present = new Set(data.map((r) => classifyFrequency(r.period as string | null)))
  const available = FREQUENCY_ORDER.filter((f) => present.has(f))
  const frequency = requested !== undefined && available.includes(requested) ? requested : (available[0] ?? FREQUENCY_ORDER[FREQUENCY_ORDER.length - 1]!)
  const rows = data.filter((r) => classifyFrequency(r.period as string | null) === frequency && (startYear === undefined || (r.year as number) >= startYear) && (endYear === undefined || (r.year as number) <= endYear))
  if (rows.length === 0) throw new Error('No records match the given filters.')

  // _pivot
  const foldDims = FOLD_DIM_FIELDS.filter((f) => new Set(rows.map((r) => dimValue(r, f))).size > 1)
  const { columnDims, rowDims } = classifyDimsFull(rows, foldDims, 'series')
  const periodVaries = new Set(rows.map((r) => r.period)).size > 1
  const basisInColumns = frequency === ANNUAL && periodVaries && basisPartitionsSeries(rows)
  const multiUnit = new Set(rows.map((r) => r.unit)).size > 1
  type Wide = { dims: string[]; year: number; period: number; order: number; label: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const columnOrder: string[] = []
  const seenColumns = new Set<string>()
  rows.forEach((r, order) => {
    const year = r.year as number
    const display = displayPeriod(r.period as string | null)
    const timeLabel = frequency === ANNUAL ? (periodVaries && display && !basisInColumns ? `${year} — ${display}` : String(year)) : display ? `${year} ${display}` : String(year)
    const dimValues = rowDims.map((f) => dimValue(r, f)).filter((v): v is string => v !== null)
    const key = JSON.stringify([rowDims.map((f) => dimValue(r, f)), year, basisInColumns ? null : r.period])
    let row = pivoted.get(key)
    if (!row) {
      row = { dims: dimValues, year, period: periodSortKey(display, frequency), order, label: [...dimValues, timeLabel].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    const columnValues = columnDims.map((f) => dimValue(r, f)).filter((v): v is string => v !== null)
    const series = basisInColumns && display ? `${r.series} — ${display}` : (r.series as string)
    const base = [...columnValues, series].join(' — ')
    const column = multiUnit && r.unit ? `${base} (${r.unit})` : base
    if (!seenColumns.has(column)) {
      seenColumns.add(column)
      columnOrder.push(column)
    }
    row.values.set(column, r.value as number)
  })
  return sortedNested([...pivoted.values()], (w) => [w.dims, -w.year, -w.period, w.order]).map((w) => {
    const out: Row = { period: w.label }
    for (const column of columnOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
