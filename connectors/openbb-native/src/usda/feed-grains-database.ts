// usda/feed_grains_database, provider usda. Ported from openbb_government_us/usda/models/feed_grains_database.py and
// utils/ers_feed_grains.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, optString, pyFloat, pyInt } from './helpers.js'
import { sortedNested } from './helpers-a.js'

const MEDIA_PATH = '/media/5766/feed-grains-yearbook-tables-all-years.csv'
const DEFAULT_TABLE = 'corn_supply_and_use'
const ROW_DIM_CANDIDATES = ['commodity_group', 'commodity', 'geography'] as const

/** Table → [table number, table name as the CSV writes it]. */
const FEED_GRAINS_TABLES: Record<string, [number, string]> = {
  acreage_production_and_price: [1, 'Table 1--Corn, sorghum, barley, and oats: Planted acreage, harvested acreage, production, yield, and price received by farmers'],
  foreign_coarse_grains_supply_and_use: [2, 'Table 2--Foreign coarse grains: Supply and disappearance'],
  feed_grains_supply_and_use: [3, 'Table 3--Feed grains (corn, sorghum, barley, and oats): Supply and disappearance, million metric tons'],
  corn_supply_and_use: [4, 'Table 4--Corn: Supply and disappearance, million bushels'],
  sorghum_supply_and_use: [5, 'Table 5--Sorghum: Supply and disappearance, million bushels'],
  barley_supply_and_use: [6, 'Table 6--Barley: Supply and disappearance, million bushels'],
  oats_supply_and_use: [7, 'Table 7--Oats: Supply and disappearance, million bushels'],
  hay_production_and_stocks: [8, 'Table 8--Hay: Production, harvested acreage, yield, and stocks'],
  corn_and_sorghum_farm_prices: [9, 'Table 9--Corn and sorghum: Prices received by farmers, United States'],
  barley_and_oats_farm_prices: [10, 'Table 10--Barley and oats: Prices received by farmers, United States, dollars per bushel'],
  hay_farm_prices: [11, 'Table 11--Hay: Prices received by farmers, United States, dollars per ton'],
  corn_cash_prices: [12, 'Table 12--Corn: Cash prices at principal markets, dollars per bushel'],
  sorghum_cash_prices: [13, 'Table 13--Sorghum: Cash prices at principal markets, dollars per hundredweight'],
  barley_and_oats_cash_prices: [14, 'Table 14--Barley and Oats: Cash prices at principal markets, dollars per bushel'],
  feed_price_ratios: [15, 'Table 15--Feed-price ratios for livestock, poultry, and milk'],
  byproduct_feed_prices: [16, 'Table 16--Byproduct feeds: Wholesale price, bulk, specified markets, dollars per ton'],
  processed_corn_product_prices: [17, 'Table 17--Processed corn products: Quoted market prices'],
  corn_and_sorghum_exports: [18, 'Table 18--U.S. corn and sorghum exports'],
  barley_and_oats_exports: [19, 'Table 19--U.S. barley and oats exports'],
  corn_and_sorghum_imports: [20, 'Table 20--U.S. corn and sorghum imports'],
  barley_and_oats_imports: [21, 'Table 21--U.S. barley and oats imports'],
  corn_and_sorghum_exports_by_destination: [22, 'Table 22--U.S. corn and sorghum exports by selected destinations'],
  barley_and_oats_exports_by_destination: [23, 'Table 23--U.S. barley and oats exports by selected destinations'],
  corn_and_sorghum_imports_by_source: [24, 'Table 24--U.S. corn and sorghum imports by selected sources'],
  barley_and_oats_imports_by_source: [25, 'Table 25--U.S. barley and oats imports by selected sources'],
  white_corn_exports_by_destination: [26, 'Table 26--U.S. white corn exports by selected destinations'],
  world_coarse_grain_trade: [27, 'Table 27--World coarse grain trade: Selected exporters and importers by commodity'],
  rail_rates_and_grain_shipments: [28, 'Table 28--Rail rates and grain shipments'],
  processed_feeds_fed: [29, 'Table 29--Processed feeds: Quantities fed and feed per grain-consuming animal unit, 1,000 metric tons'],
  animal_unit_indexes: [30, 'Table 30--Indexes of feed consuming animal units, millions'],
  corn_food_seed_and_industrial_use: [31, 'Table 31--Corn: Food, seed, and industrial use, million bushels'],
  ethanol_exports_by_destination: [32, 'Table 32--U.S. exports of ethyl alcohol by selected destinations'],
  ethanol_imports_by_source: [33, 'Table 33--U.S. imports of ethyl alcohol by selected sources'],
  distillers_dregs_exports_by_destination: [34, "Table 34--U.S. exports of brewers' and distillers' dregs and waste by selected destination"],
  distillers_dregs_imports_by_source: [35, "Table 35--U.S. imports of brewers' and distillers' dregs and waste by selected sources"],
}

const NAME_TO_SLUG = new Map(Object.entries(FEED_GRAINS_TABLES).map(([slug, [, name]]) => [name, slug]))

type Observation = { table: string; commodity_group: string; commodity: string; attribute: string; geography: string; year: number; timeperiod: string; unit: string; value: number }

/** `table_key`: the slug of a table name; names the catalog does not know become `table_<n>`. */
function tableKey(tableName: string): string {
  const slug = NAME_TO_SLUG.get(tableName)
  if (slug !== undefined) return slug
  const match = /^Table (\d+)--/.exec(tableName)
  if (!match) throw new Error(`Unrecognized table name: '${tableName}'`)
  return `table_${Number(match[1])}`
}

export async function feedGrainsDatabase(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!Object.prototype.hasOwnProperty.call(FEED_GRAINS_TABLES, table)) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FEED_GRAINS_TABLES).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_rows, keeping this table's rows.
  const filtered: Observation[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, MEDIA_PATH))) {
    const amount = cell(row, 'amount')
    if (!amount) continue
    const slug = tableKey(cell(row, 'table_name'))
    const value = pyFloat(amount)
    if (value === undefined) throw new Error(`could not convert string to float: '${amount}'`)
    const year = pyInt(row.year ?? '')
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${row.year ?? ''}'`)
    if (slug !== table) continue
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    filtered.push({
      table: slug,
      commodity_group: cell(row, 'commodity_group'),
      commodity: cell(row, 'commodity'),
      attribute: cell(row, 'attribute'),
      geography: cell(row, 'geography'),
      year,
      timeperiod: cell(row, 'timeperiod'),
      unit: cell(row, 'unit'),
      value,
    })
  }
  if (filtered.length === 0) return []

  // The series are the attributes, or the commodities when the table has one attribute.
  const seriesField: 'attribute' | 'commodity' | null = new Set(filtered.map((r) => r.attribute)).size > 1 ? 'attribute' : new Set(filtered.map((r) => r.commodity)).size > 1 ? 'commodity' : null
  const seriesValue = (r: Observation): string => (seriesField ? r[seriesField] : r.attribute)
  const seriesValues = new Set(filtered.map(seriesValue))
  const foldDims: (typeof ROW_DIM_CANDIDATES)[number][] = []
  for (const dim of ROW_DIM_CANDIDATES) {
    if (dim === seriesField) continue
    const distinct = new Set(filtered.map((r) => r[dim]).filter((v) => !isNullToken(v)))
    if (distinct.size <= 1) continue
    if (dim === 'commodity_group' && filtered.every((r) => r.commodity_group === r.commodity)) continue
    const pairs = new Set(filtered.map((r) => JSON.stringify([seriesValue(r), r[dim]])))
    if (pairs.size === seriesValues.size) continue
    foldDims.push(dim)
  }

  type Wide = { sort: string[]; year: number; order: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const columnOrder: string[] = []
  const seenColumns = new Set<string>()
  filtered.forEach((r, order) => {
    const dimValues = foldDims.map((d) => r[d])
    const key = JSON.stringify([...dimValues, r.year, r.timeperiod])
    let row = pivoted.get(key)
    if (!row) {
      const labels = dimValues.filter((v) => v && !isNullToken(v))
      const timeLabel = r.timeperiod ? `${r.year} ${r.timeperiod}` : String(r.year)
      row = { sort: dimValues.map((v) => v || ''), year: r.year, order, period: [...labels, timeLabel].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    let column = seriesValue(r)
    if (r.unit && !isNullToken(r.unit) && !column.includes(r.unit)) column = `${column} (${r.unit})`
    if (!seenColumns.has(column)) {
      seenColumns.add(column)
      columnOrder.push(column)
    }
    row.values.set(column, r.value)
  })
  return sortedNested([...pivoted.values()], (w) => [w.sort, w.year, w.order]).map((w) => {
    const out: Row = { period: w.period }
    for (const column of columnOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
