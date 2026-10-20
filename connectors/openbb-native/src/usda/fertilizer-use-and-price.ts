// usda/fertilizer_use_and_price, provider usda. Ported from openbb_government_us/usda/models/fertilizer_use_and_price.py and
// utils/ers_fertilizer_use_and_price.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models;
// the legacy .xls workbook is read with src/lib/xls.ts instead of xlrd.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchErsFile, isNullToken, nullTokensToNone, optInt, optString, pyFloat, sortedBy } from './helpers.js'
import { xlrdRows, xlrdStr } from './helpers-g.js'
import { readXls } from '../lib/xls.js'

const DEFAULT_TABLE = 'us_plant_nutrient_consumption'
const WORKBOOK_MEDIA = '/media/5291/all-fertilizer-use-and-price-tables-in-a-single-workbook.xls'

const FOOTNOTE_PREFIXES = ['NA =', 'NA=', '1/', '2/', '3/', '4/', 'Source']
const STATE_FOOTNOTE = /\s*\d+\/\s*$/

const MONTH_ORDER: Record<string, number> = { 'Jan.': 1, 'Feb.': 2, 'Mar.': 3, 'Apr.': 4, May: 5, June: 6, July: 7, 'Aug.': 8, 'Sept.': 9, 'Oct.': 10, 'Nov.': 11, 'Dec.': 12 }

type TableA = { sheet: number; group: 'A'; monthCol: number | null; columns: [number, string][] }
type TableB = { sheet: number; group: 'B'; unit: string }

/** Table key → worksheet index (the workbook's first sheet is the contents page) and layout. Group A: national series by year; group B: crop by State matrices. */
const FERTILIZER_TABLES: Record<string, TableA | TableB> = {
  us_plant_nutrient_consumption: { sheet: 1, group: 'A', monthCol: null, columns: [[1, 'Nitrogen (N)'], [2, 'Phosphate (P2O5)'], [3, 'Potash (K2O)'], [4, 'Total'], [6, 'Nitrogen share'], [7, 'Phosphate share'], [8, 'Potash share']] },
  plant_nutrient_use_by_crop: { sheet: 2, group: 'A', monthCol: null, columns: [[1, 'Nitrogen - Corn'], [2, 'Nitrogen - Cotton'], [3, 'Nitrogen - Soybeans'], [4, 'Nitrogen - Wheat'], [5, 'Nitrogen - Other'], [6, 'Phosphate - Corn'], [7, 'Phosphate - Cotton'], [8, 'Phosphate - Soybeans'], [9, 'Phosphate - Wheat'], [10, 'Phosphate - Other'], [11, 'Potash - Corn'], [12, 'Potash - Cotton'], [13, 'Potash - Soybeans'], [14, 'Potash - Wheat'], [15, 'Potash - Other']] },
  nutrient_material_class_consumption: { sheet: 3, group: 'A', monthCol: null, columns: [[1, 'Multiple-nutrient material'], [2, 'Single-nutrient material'], [3, 'Secondary and micro-nutrients'], [4, 'Total'], [6, 'Multiple-nutrient material share'], [7, 'Single-nutrient material share'], [8, 'Secondary and micronutrients share']] },
  nitrogen_material_consumption: { sheet: 4, group: 'A', monthCol: null, columns: [[1, 'Ammonia (Anhydrous)'], [2, 'Ammonia (Aqua)'], [4, 'Ammonium (Nitrate)'], [5, 'Ammonium (Sulfate)'], [6, 'Nitrogen solutions'], [7, 'Sodium nitrate'], [8, 'Urea'], [9, 'Other']] },
  phosphate_potash_material_consumption: { sheet: 5, group: 'A', monthCol: null, columns: [[1, 'Superphosphates, grades 22% and under'], [2, 'Superphosphates, grades over 22%'], [3, 'Other single phosphates'], [5, 'Diammonium phosphate (18-46-0)'], [6, 'Monoammonium phosphate (11-(51-55)-0)'], [7, 'Other nitrogen-phosphate grades'], [9, 'Potassium chloride'], [10, 'Other single-nutrient potash']] },
  secondary_micronutrient_organic_consumption: { sheet: 6, group: 'A', monthCol: null, columns: [[1, 'Gypsum'], [2, 'Sulfur'], [3, 'Sulfuric Acid'], [4, 'Zinc compound'], [6, 'Compost'], [7, 'Dried manure'], [8, 'Sewage sludge'], [9, 'Other organic materials']] },
  farm_prices: { sheet: 7, group: 'A', monthCol: 1, columns: [[2, 'Anhydrous ammonia'], [3, 'Nitrogen solutions (30%)'], [4, 'Urea 44-46% nitrogen'], [5, 'Ammonium nitrate'], [6, 'Sulfate of ammonium'], [7, 'Super-phosphate 20% phosphate'], [8, 'Super-phosphate 44-46% phosphate'], [9, 'Diammonium phosphate (18-46-0)'], [10, 'Potassium chloride 60% potassium']] },
  price_indexes: { sheet: 8, group: 'A', monthCol: null, columns: [[1, 'Prices paid by farmers for fertilizer'], [2, 'Prices received by farmers for all crops'], [4, 'PPI All fertilizers'], [5, 'PPI Nitrogen'], [6, 'PPI Phosphate'], [7, 'PPI Potash']] },
  corn_nitrogen_share: { sheet: 9, group: 'B', unit: 'Percent' },
  corn_nitrogen_rate: { sheet: 10, group: 'B', unit: 'Pounds/acre' },
  corn_phosphate_share: { sheet: 11, group: 'B', unit: 'Percent' },
  corn_phosphate_rate: { sheet: 12, group: 'B', unit: 'Pounds/acre' },
  corn_potash_share: { sheet: 13, group: 'B', unit: 'Percent' },
  corn_potash_rate: { sheet: 14, group: 'B', unit: 'Pounds/acre' },
  cotton_nitrogen_share: { sheet: 15, group: 'B', unit: 'Percent' },
  cotton_nitrogen_rate: { sheet: 16, group: 'B', unit: 'Pounds/acre' },
  cotton_phosphate_share: { sheet: 17, group: 'B', unit: 'Percent' },
  cotton_phosphate_rate: { sheet: 18, group: 'B', unit: 'Pounds/acre' },
  cotton_potash_share: { sheet: 19, group: 'B', unit: 'Percent' },
  cotton_potash_rate: { sheet: 20, group: 'B', unit: 'Pounds/acre' },
  soybeans_nitrogen_share: { sheet: 21, group: 'B', unit: 'Percent' },
  soybeans_nitrogen_rate: { sheet: 22, group: 'B', unit: 'Pounds/acre' },
  soybeans_phosphate_share: { sheet: 23, group: 'B', unit: 'Percent' },
  soybeans_phosphate_rate: { sheet: 24, group: 'B', unit: 'Pounds/acre' },
  soybeans_potash_share: { sheet: 25, group: 'B', unit: 'Percent' },
  soybeans_potash_rate: { sheet: 26, group: 'B', unit: 'Pounds/acre' },
  wheat_nitrogen_share: { sheet: 27, group: 'B', unit: 'Percent' },
  wheat_nitrogen_rate: { sheet: 28, group: 'B', unit: 'Pounds/acre' },
  wheat_phosphate_share: { sheet: 29, group: 'B', unit: 'Percent' },
  wheat_phosphate_rate: { sheet: 30, group: 'B', unit: 'Pounds/acre' },
  wheat_potash_share: { sheet: 31, group: 'B', unit: 'Percent' },
  wheat_potash_rate: { sheet: 32, group: 'B', unit: 'Pounds/acre' },
}

type Cell_ = string | number | boolean
type Observation = { year: number; period: string | null; series: string; value: number }

/** `_year_of`: the four-digit year a cell encodes (1900 to 2100), else null. */
function yearOf(cell: Cell_ | undefined): number | null {
  let year: number
  if (typeof cell === 'boolean' || cell === undefined) return null
  if (typeof cell === 'number') year = Math.trunc(cell)
  else {
    const text = cell.trim()
    if (!/^\d{4}/.test(text)) return null
    year = Number(text.slice(0, 4))
  }
  return year >= 1900 && year <= 2100 ? year : null
}

/** `_numeric`: a float, null for blank or non-numeric cells such as 'NA'. */
function numeric(cell: Cell_ | undefined): number | null {
  if (cell === undefined) return null
  if (typeof cell === 'string') return pyFloat(cell) ?? null
  return Number(cell)
}

function parseGroupA(rows: Cell_[][], config: TableA): Observation[] {
  const records: Observation[] = []
  for (const row of rows) {
    if (row.length === 0) continue
    const year = yearOf(row[0])
    if (year === null) continue
    let period: string | null = null
    if (config.monthCol !== null && config.monthCol < row.length) period = xlrdStr(row[config.monthCol]).trim() || null
    for (const [col, series] of config.columns) {
      if (col >= row.length) continue
      const value = numeric(row[col])
      if (value === null) continue
      records.push({ year, period, series, value })
    }
  }
  return records
}

function parseGroupB(rows: Cell_[][]): Observation[] {
  const headerIndex = rows.findIndex((row) => row.length > 0 && xlrdStr(row[0]).trim() === 'State')
  if (headerIndex < 0) return []
  const header = rows[headerIndex]!
  const yearCols: [number, number][] = []
  for (let col = 1; col < header.length; col++) {
    const year = yearOf(header[col])
    if (year !== null) yearCols.push([col, year])
  }
  const records: Observation[] = []
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.length === 0) continue
    let state = xlrdStr(row[0]).trim()
    if (!state || FOOTNOTE_PREFIXES.some((p) => state.startsWith(p))) continue
    state = state.replace(STATE_FOOTNOTE, '').trim()
    for (const [col, year] of yearCols) {
      if (col >= row.length) continue
      const value = numeric(row[col])
      if (value === null) continue
      records.push({ year, period: null, series: state, value })
    }
  }
  return records
}

export async function fertilizerUseAndPrice(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = FERTILIZER_TABLES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FERTILIZER_TABLES).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const sheet = readXls(await fetchErsFile(ctx, WORKBOOK_MEDIA))[config.sheet]
  if (!sheet) throw new Error('list index out of range')
  const rows = xlrdRows(sheet)
  const data = config.group === 'A' ? parseGroupA(rows, config) : parseGroupB(rows)

  // Pivot to one row per year (and month), the series as columns.
  const unit = config.group === 'B' ? config.unit : undefined
  type Wide = { year: number; monthOrder: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const colOrder: string[] = []
  const seenCols = new Set<string>()
  for (const r of data) {
    if (startYear !== undefined && r.year < startYear) continue
    if (endYear !== undefined && r.year > endYear) continue
    const month = r.period === null || isNullToken(r.period) ? null : r.period
    const key = JSON.stringify([r.year, month])
    let row = pivoted.get(key)
    if (!row) {
      row = { year: r.year, monthOrder: month ? (MONTH_ORDER[month] ?? 0) : 0, period: month ? `${r.year} ${month}` : String(r.year), values: new Map() }
      pivoted.set(key, row)
    }
    const column = unit && !r.series.includes(`(${unit})`) ? `${r.series} (${unit})` : r.series
    if (!seenCols.has(column)) {
      seenCols.add(column)
      colOrder.push(column)
    }
    row.values.set(column, r.value)
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  return sortedBy([...pivoted.values()], (r) => [r.year, r.monthOrder]).map((r) => {
    const out: Row = { period: r.period }
    for (const column of colOrder) out[column] = r.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
