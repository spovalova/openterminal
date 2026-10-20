// usda/cotton_wool_and_textile_data, provider usda. Ported from openbb_government_us/usda/models/cotton_wool_and_textile_data.py
// and utils/ers_cotton_wool_and_textile_data.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic
// models; the product-page paths OpenBB keeps for cache lifetimes are left out.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { isDigits, sortedNested } from './helpers-a.js'

const DEFAULT_TABLE = 'cotton_supply_and_use'

const M_US_COTTON = '/media/7122/us-cotton-supply-and-demand.csv'
const M_PRICES = '/media/7123/cotton-prices.csv'
const M_WORLD = '/media/7124/world-cotton-supply-and-demand.csv'
const M_FIBER_DEMAND = '/media/7127/us-fiber-demand.csv'
const M_WOOL = '/media/7126/us-wool-supply-and-demand.csv'
const M_TEXTILE = '/media/7125/us-textile-fiber-trade.csv'
const M_RFE_IMPORTS_BY_FIBER = '/media/5485/table-1-us-textile-imports-by-fiber.csv'
const M_RFE_EXPORTS_BY_FIBER = '/media/5487/table-2-us-textile-exports-by-fiber.csv'
const M_RFE_IMPORTS_BY_ORIGIN = '/media/5489/table-3-us-cotton-textile-and-apparel-imports-by-origin.csv'
const M_RFE_EXPORTS_BY_DESTINATION = '/media/5491/table-4-us-cotton-textile-and-apparel-exports-by-destination.csv'

type Dim = 'geography' | 'measure' | 'trade_category' | 'textile_group' | 'item'
const COLUMN_DIM_FIELDS: Dim[] = ['measure', 'trade_category', 'textile_group', 'item']
const MONTH_NAMES: Record<string, string> = { '1': 'Jan', '2': 'Feb', '3': 'Mar', '4': 'Apr', '5': 'May', '6': 'Jun', '7': 'Jul', '8': 'Aug', '9': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec' }
const MONTH_ORDER: Record<string, number> = Object.fromEntries(Object.values(MONTH_NAMES).map((name, i) => [name, i + 1]))
const FREQUENCY_RANK: Record<string, number> = { Annual: 0, Quarterly: 1, Monthly: 2 }

type TableConfig = {
  media: string
  number: string
  /** Column holding the year (or marketing year) label. */
  yearCol: string
  periodCol: string | null
  seriesCol: string | null
  unitCol: string
  /** Output dimension ← source column. */
  dims: [Dim, string][]
  normalizeMeasure: boolean
  pivot: 'series' | 'years'
}

const cfg = (media: string, number: string, over: Partial<TableConfig> = {}): TableConfig => ({
  media,
  number,
  yearCol: 'period',
  periodCol: null,
  seriesCol: 'category',
  unitCol: 'units',
  dims: [],
  normalizeMeasure: false,
  pivot: 'series',
  ...over,
})
const byGeography = { seriesCol: 'geography' }
const monthlyTextile: Partial<TableConfig> = { periodCol: 'month', seriesCol: 'textile_category', dims: [['textile_group', 'textile_group']] }
const rfeByFiber: Partial<TableConfig> = { seriesCol: 'fiber', unitCol: 'unit', dims: [['item', 'Item']] }
const rfeByRegion: Partial<TableConfig> = { yearCol: 'year', seriesCol: null, unitCol: 'unit', dims: [['geography', 'Region/country']], pivot: 'years' }

const CWT_TABLES: Record<string, TableConfig> = {
  cotton_supply_and_use: cfg(M_US_COTTON, '1'),
  upland_cotton_supply_and_use: cfg(M_US_COTTON, '2'),
  els_cotton_supply_and_use: cfg(M_US_COTTON, '3'),
  upland_planted_acreage_by_state: cfg(M_US_COTTON, '4', byGeography),
  upland_harvested_acreage_by_state: cfg(M_US_COTTON, '5', byGeography),
  upland_lint_yield_by_state: cfg(M_US_COTTON, '6', byGeography),
  upland_production_by_state: cfg(M_US_COTTON, '7', byGeography),
  els_acreage_by_state: cfg(M_US_COTTON, '8', { ...byGeography, dims: [['measure', 'category']], normalizeMeasure: true }),
  els_production_and_yield_by_state: cfg(M_US_COTTON, '9', { ...byGeography, dims: [['measure', 'category']], normalizeMeasure: true }),
  cotton_supply_and_disappearance_monthly: cfg(M_US_COTTON, '10', { periodCol: 'month' }),
  upland_farm_spot_mill_prices: cfg(M_PRICES, '11'),
  fiber_prices: cfg(M_PRICES, '12'),
  cotton_price_quotes_monthly: cfg(M_PRICES, '13', { periodCol: 'time_period' }),
  cotton_price_quotes_annual: cfg(M_PRICES, '14'),
  world_cotton_supply_and_use: cfg(M_WORLD, '15'),
  foreign_cotton_supply_and_use: cfg(M_WORLD, '16'),
  cotton_exports_major_exporters: cfg(M_WORLD, '17', byGeography),
  cotton_imports_major_importers: cfg(M_WORLD, '18', byGeography),
  former_soviet_union_cotton_supply_and_use: cfg(M_WORLD, '19'),
  brazil_cotton_supply_and_use: cfg(M_WORLD, '20'),
  turkey_cotton_supply_and_use: cfg(M_WORLD, '21'),
  china_cotton_supply_and_use: cfg(M_WORLD, '22'),
  india_cotton_supply_and_use: cfg(M_WORLD, '23'),
  pakistan_cotton_supply_and_use: cfg(M_WORLD, '24'),
  cotton_fiber_demand_total_and_per_capita: cfg(M_FIBER_DEMAND, '25'),
  per_capita_cotton_demand: cfg(M_FIBER_DEMAND, '26'),
  cotton_and_synthetic_mill_use: cfg(M_FIBER_DEMAND, '27'),
  wool_supply_and_use: cfg(M_WOOL, '28'),
  raw_wool_imports_for_mill_use: cfg(M_WOOL, '29'),
  raw_wool_imports_by_origin: cfg(M_WOOL, '30', { dims: [['geography', 'geography']] }),
  raw_wool_exports_by_destination: cfg(M_WOOL, '31', { dims: [['geography', 'geography']] }),
  wool_tops_trade: cfg(M_WOOL, '32', { dims: [['geography', 'geography']] }),
  shorn_wool_prices: cfg(M_WOOL, '33'),
  mohair_exports_by_destination: cfg(M_WOOL, '34', byGeography),
  raw_fiber_equivalent_textile_manufactures: cfg(M_TEXTILE, '35', { seriesCol: 'fiber', dims: [['trade_category', 'trade_category']] }),
  raw_cotton_equivalent_imports: cfg(M_TEXTILE, '36', monthlyTextile),
  raw_cotton_equivalent_exports: cfg(M_TEXTILE, '37', monthlyTextile),
  raw_linen_equivalent_imports: cfg(M_TEXTILE, '38', monthlyTextile),
  raw_linen_equivalent_exports: cfg(M_TEXTILE, '39', monthlyTextile),
  raw_wool_equivalent_imports: cfg(M_TEXTILE, '40', monthlyTextile),
  raw_wool_equivalent_exports: cfg(M_TEXTILE, '41', monthlyTextile),
  raw_silk_equivalent_imports: cfg(M_TEXTILE, '42', monthlyTextile),
  raw_silk_equivalent_exports: cfg(M_TEXTILE, '43', monthlyTextile),
  raw_synthetic_equivalent_imports: cfg(M_TEXTILE, '44', monthlyTextile),
  raw_synthetic_equivalent_exports: cfg(M_TEXTILE, '45', monthlyTextile),
  rfe_textile_imports_by_fiber: cfg(M_RFE_IMPORTS_BY_FIBER, '1', rfeByFiber),
  rfe_textile_exports_by_fiber: cfg(M_RFE_EXPORTS_BY_FIBER, '2', { ...rfeByFiber, yearCol: 'year' }),
  rfe_cotton_textile_imports_by_origin: cfg(M_RFE_IMPORTS_BY_ORIGIN, '3', rfeByRegion),
  rfe_cotton_textile_exports_by_destination: cfg(M_RFE_EXPORTS_BY_DESTINATION, '4', rfeByRegion),
}

type Observation = { year: number; period: string | null; geography: string | null; measure: string | null; trade_category: string | null; textile_group: string | null; item: string | null; unit: string | null; series: string | null; value: number }

function classifyFrequency(period: string | null): string {
  if (period === null) return 'Annual'
  const token = period.trim()
  if (Object.prototype.hasOwnProperty.call(MONTH_NAMES, token)) return 'Monthly'
  return ['Q1', 'Q2', 'Q3', 'Q4'].includes(token.toUpperCase()) ? 'Quarterly' : 'Annual'
}

/** Python's `str.title()` for the single-word frequency names. */
function title(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

/** `_table_number`: the first of the two possible table-number columns the file has. */
function tableNumber(row: Record<string, string | undefined>): string {
  for (const col of ['table_number', 'table_num']) {
    const value = row[col]
    if (value !== undefined) return value.trim()
  }
  return ''
}

function columnKey(r: Observation): string {
  const parts = COLUMN_DIM_FIELDS.filter((f) => r[f]).map((f) => String(r[f]).replace(/_/g, ' '))
  if (r.series) parts.push(String(r.series).replace(/_/g, ' '))
  const head = parts.length ? parts.join(' · ') : 'Value'
  return r.unit ? `${head} (${r.unit})` : head
}

export async function cottonWoolAndTextileData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = Object.prototype.hasOwnProperty.call(CWT_TABLES, table) ? CWT_TABLES[table] : undefined
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(CWT_TABLES).join(', ')}`)
  const requestedText = optString(params, 'frequency')
  const requested = requestedText === undefined ? undefined : title(requestedText)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_table
  const data: Observation[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, config.media))) {
    if (tableNumber(row) !== config.number) continue
    const value = pyFloat(cell(row, 'value'))
    if (value === undefined) continue
    const yearLabel = cell(row, config.yearCol)
    if (!isDigits(yearLabel.slice(0, 4))) continue
    const record: Observation = {
      year: Number(yearLabel.slice(0, 4)),
      period: config.periodCol ? cell(row, config.periodCol) || null : null,
      geography: null,
      measure: null,
      trade_category: null,
      textile_group: null,
      item: null,
      unit: cell(row, config.unitCol) || null,
      series: config.seriesCol ? cell(row, config.seriesCol) : null,
      value,
    }
    for (const [field, source] of config.dims) {
      let raw = cell(row, source)
      if (field === 'measure' && config.normalizeMeasure) raw = raw.toLowerCase()
      record[field] = raw || null
    }
    data.push(record)
  }
  if (data.length === 0) return []

  // _resolve_frequency: the finest one the table has unless the caller names one it has.
  const available = [...new Set(data.map((r) => classifyFrequency(r.period)))].sort((a, b) => (FREQUENCY_RANK[a] ?? 9) - (FREQUENCY_RANK[b] ?? 9))
  const frequency = requested !== undefined && available.includes(requested) ? requested : available[available.length - 1]!
  const rows = data.filter((r) => classifyFrequency(r.period) === frequency && (startYear === undefined || r.year >= startYear) && (endYear === undefined || r.year <= endYear))
  if (rows.length === 0) return []

  let ordered: { period: string; values: Map<string, number> }[]
  let columnOrder: string[]
  if (config.pivot === 'years') {
    // _pivot_years: one row per region, a column per year.
    const pivoted = new Map<string, { period: string; values: Map<string, number> }>()
    for (const r of rows) {
      const geography = r.geography || 'Total'
      let row = pivoted.get(geography)
      if (!row) pivoted.set(geography, (row = { period: geography, values: new Map() }))
      const column = String(r.year)
      row.values.set(column, (row.values.get(column) ?? 0) + r.value)
    }
    ordered = [...pivoted.values()]
    columnOrder = [...new Set(ordered.flatMap((r) => [...r.values.keys()]))].filter(isDigits).sort((a, b) => Number(a) - Number(b))
  } else {
    // _pivot_series: a row per geography, year and period, a column per series.
    type Wide = { geography: string; year: number; month: number; order: number; period: string; values: Map<string, number> }
    const pivoted = new Map<string, Wide>()
    columnOrder = []
    const seenColumns = new Set<string>()
    rows.forEach((r, order) => {
      const month = frequency === 'Monthly' ? MONTH_NAMES[String(r.period)] : undefined
      const timeLabel = month ? `${r.year} ${month}` : String(r.year)
      const key = JSON.stringify([r.geography ?? '', r.year, r.period])
      let row = pivoted.get(key)
      if (!row) {
        row = { geography: r.geography ?? '', year: r.year, month: MONTH_ORDER[month ?? ''] ?? 0, order, period: r.geography ? `${r.geography} — ${timeLabel}` : timeLabel, values: new Map() }
        pivoted.set(key, row)
      }
      const column = columnKey(r)
      if (!seenColumns.has(column)) {
        seenColumns.add(column)
        columnOrder.push(column)
      }
      row.values.set(column, (row.values.get(column) ?? 0) + r.value)
    })
    ordered = sortedNested([...pivoted.values()], (w) => [w.geography, -w.year, -w.month, w.order])
  }
  return ordered.map((w) => {
    const out: Row = { period: w.period }
    for (const column of columnOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
