// usda/us_food_imports, provider usda. Ported from openbb_government_us/usda/models/us_food_imports.py and
// utils/ers_us_food_imports.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy } from './helpers.js'

const MEDIA_PATH = '/media/6495/summary-data-on-annual-food-imports-values-and-volume-by-food-category-and-source-country.csv'
const TABLES = ['by_food_group', 'by_source']

/** Food group code → label. */
const FOOD_GROUPS: Record<string, string> = {
  Animals: 'Live animals',
  Meats: 'Meats',
  Fish: 'Fish and shellfish',
  Dairy: 'Dairy',
  Vegetables: 'Vegetables',
  Fruits: 'Fruits',
  Nuts: 'Nuts',
  Coffee: 'Coffee, tea, and spices',
  Grains: 'Grains',
  VegetablesOil: 'Vegetable oils',
  Sweets: 'Sugar and candy',
  Cocoa: 'Cocoa and chocolate',
  Other: 'Other edible products',
  Beverages: 'Beverages',
}
const DEFAULT_FOOD_GROUP = 'Fruits'
const DEFAULT_COMMODITY = 'Total fruit and preparations'
const AGG_COLUMN_LABELS: Record<string, string> = { 'U.S. imports': 'Total foods', 'Live meat animals': 'Live animals', 'Fish and shellfish': 'Fish' }

type MeasureSpec = { category: string; subcategories: string[]; percent: boolean; uniformUnit: string | null }
const MEASURES: Record<string, MeasureSpec> = {
  value: { category: 'Food dollars', subcategories: ['Total foods', 'Foods'], percent: false, uniformUnit: 'Million $' },
  value_change: { category: 'Food dollars', subcategories: ['Total foods', 'Foods'], percent: true, uniformUnit: 'percent' },
  volume: { category: 'Food volume', subcategories: ['Foods'], percent: false, uniformUnit: null },
  volume_change: { category: 'Food volume', subcategories: ['Foods'], percent: true, uniformUnit: 'percent' },
  unit_price: { category: 'Prices', subcategories: ['Imported food prices'], percent: false, uniformUnit: null },
  inflation: { category: 'Prices', subcategories: ['Import price inflation'], percent: true, uniformUnit: 'percent' },
}
const SOURCE_MEASURES = ['value', 'volume']
const SMALL_WORDS = new Set(['and', 'of', 'or', 'the'])
const COUNTRY_FIXES: Record<string, string> = { 'GERMANY, FED. REPUBLIC': 'Germany', "COTE D'IVOIRE": "Cote d'Ivoire", 'REST OF WORLD': 'Rest of world', WORLD: 'World', 'WORLD (QUANTITY)': 'World' }
const UNIT_LABELS: Record<string, string> = { '1,000': '1,000 head' }

/** A source country as written in the file ("UNITED KINGDOM") in title case, with the known spellings fixed. */
function cleanCountry(raw: string): string {
  const text = raw.replaceAll('�', "'").trim()
  const fix = COUNTRY_FIXES[text.toUpperCase()]
  if (fix !== undefined) return fix
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase()
      return index && SMALL_WORDS.has(lower) ? lower : lower.slice(0, 1).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

const unitLabel = (uom: string): string => UNIT_LABELS[uom.trim()] ?? uom.trim()
const foodGroupColumnLabel = (commodity: string): string => AGG_COLUMN_LABELS[commodity] ?? commodity

type Observation = { commodity: string; country: string; uom: string; category: string; subcategory: string; rowNumber: number; year: number; value: number }

function parseRows(text: string): Observation[] {
  const records: Observation[] = []
  for (const row of csvDictRows(text)) {
    const yearToken = (row.YearNum ?? '').trim()
    if (!/^\d+$/.test(yearToken)) continue
    const value = pyFloat((row.FoodValue ?? '').trim())
    if (value === undefined) continue
    const rowNumber = pyInt((row.RowNumber ?? '').trim())
    if (rowNumber === undefined) continue
    records.push({
      commodity: (row.Commodity ?? '').trim(),
      country: (row.Country ?? '').trim(),
      uom: (row.UOM ?? '').trim(),
      category: (row.Category ?? '').trim(),
      subcategory: (row.SubCategory ?? '').trim(),
      rowNumber,
      year: Number(yearToken),
      value,
    })
  }
  return records
}

/** A product line's names in the order they first appear in the file within one food group. */
function productLines(records: Observation[], foodGroup: string): string[] {
  const firstSeen = new Map<string, number>()
  for (const r of records) {
    if (r.category !== foodGroup) continue
    const seen = firstSeen.get(r.commodity)
    if (seen === undefined || r.rowNumber < seen) firstSeen.set(r.commodity, r.rowNumber)
  }
  return sortedBy([...firstSeen.keys()], (name) => [firstSeen.get(name)!])
}

export async function usFoodImports(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? 'by_food_group'
  if (!TABLES.includes(table)) throw new Error(`Invalid table: ${table}. Valid tables are: ${TABLES.join(', ')}`)
  const measure = optString(params, 'measure') ?? 'value'
  const spec = MEASURES[measure]
  if (!spec) throw new Error(`Invalid measure: ${measure}. Valid measures are: ${Object.keys(MEASURES).join(', ')}`)
  const foodGroup = optString(params, 'food_group') ?? DEFAULT_FOOD_GROUP
  if (!(foodGroup in FOOD_GROUPS)) throw new Error(`Invalid food group: ${foodGroup}. Valid food groups are: ${Object.keys(FOOD_GROUPS).join(', ')}`)
  let commodity = optString(params, 'commodity')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const records = parseRows(await fetchErsText(ctx, MEDIA_PATH))
  // Which rows feed the columns, and how a record names its column.
  let selected: Observation[]
  let columnOf: (r: Observation) => string
  let leading: (year: number) => Row
  if (table === 'by_source') {
    if (!SOURCE_MEASURES.includes(measure)) return []
    if (!commodity) commodity = productLines(records, foodGroup)[0] ?? DEFAULT_COMMODITY
    const chosen = commodity
    selected = records.filter((r) => r.category === foodGroup && r.subcategory === 'Foods' && r.commodity === chosen && (r.uom === 'Million $') === (measure === 'value'))
    columnOf = (r) => columnKey(cleanCountry(r.country), spec.uniformUnit, r.uom)
    leading = (year) => ({ year, food_group: FOOD_GROUPS[foodGroup] ?? foodGroup, commodity: chosen, unit: spec.uniformUnit })
  } else {
    selected = records.filter((r) => r.category === spec.category && spec.subcategories.includes(r.subcategory) && (r.uom === 'percent') === spec.percent)
    columnOf = (r) => columnKey(foodGroupColumnLabel(r.commodity), spec.uniformUnit, r.uom)
    leading = (year) => ({ year, food_group: null, commodity: null, unit: spec.uniformUnit })
  }

  // Columns in the file's row order, one row per year.
  const columns = new Set<string>()
  for (const r of sortedBy(selected, (x) => [x.rowNumber])) columns.add(columnOf(r))
  const byYear = new Map<number, Row>()
  for (const r of selected) {
    if (startYear !== undefined && r.year < startYear) continue
    if (endYear !== undefined && r.year > endYear) continue
    let row = byYear.get(r.year)
    if (!row) {
      row = leading(r.year)
      byYear.set(r.year, row)
    }
    row[columnOf(r)] = r.value
  }
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const source = byYear.get(year)!
      const out: Row = { year: source.year, food_group: source.food_group, commodity: source.commodity, unit: source.unit }
      for (const key of columns) out[key] = source[key] ?? null
      return nullTokensToNone(out)
    })
}

/** A column named by its label, plus the unit when the measure has no single unit. */
function columnKey(base: string, uniformUnit: string | null, uom: string): string {
  return uniformUnit === null ? `${base} (${unitLabel(uom)})` : base
}
