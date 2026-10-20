// usda/food_availability_per_capita, provider usda. Ported from openbb_government_us/usda/models/food_availability_per_capita_data_system.py
// and utils/ers_food_availability_per_capita_data_system.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models; the nutrient workbook (a legacy .xls) is read with src/usda/xls.ts instead of xlrd.
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { sheetNamed, xlrdRows } from './helpers-g.js'
import { readXls } from './xls.js'

const DATA_SYSTEMS = ['food_availability', 'loss_adjusted', 'nutrient']
const DEFAULT_DATA_SYSTEM = 'food_availability'
const SYSTEM_DEFAULT_GROUP: Record<string, string> = { food_availability: 'eggs', loss_adjusted: 'fruit', nutrient: 'totals' }

const NULL_TOKENS = new Set(['', '-', '--', '---', '----', 'n/a', 'na', 'null', 'nan'])

/** One downloadable file and how to read it. */
type Source =
  | { format: 'long'; media: string }
  | { format: 'wide_columnar'; media: string; headerRow: number; yearCol: number; blockCol: number; idCols: number[]; dataStart: number }
  | { format: 'wide_fixed'; media: string; block: string; yearCol: number; dataStart: number; columns: [number, string][] }
  | { format: 'nutrient_totals'; media: string; sheet: string; block: string; dataStart: number }
  | { format: 'nutrient_foodgroups'; media: string; sheet: string; dataStart: number }

const NUTRIENT_TOTALS_COLUMNS: [number, string][] = [
  [1, 'Food energy - Kilocalories'],
  [2, 'Carbohydrates - Grams'],
  [3, 'Protein - Grams'],
  [4, 'Total fat - Grams'],
  [5, 'Saturated fat - Grams'],
  [6, 'Monounsaturated fat - Grams'],
  [7, 'Polyunsaturated fat - Grams'],
  [8, 'Cholesterol - Milligrams'],
  [9, 'Dietary fiber - Grams'],
  [10, 'Vitamin A (RE) - Micrograms RE'],
  [11, 'Vitamin A (RAE) - Micrograms RAE'],
  [12, 'Carotene - Micrograms'],
  [13, 'Vitamin E - Milligrams Alpha-TE'],
  [14, 'Vitamin C - Milligrams'],
  [15, 'Thiamin - Milligrams'],
  [16, 'Riboflavin - Milligrams'],
  [17, 'Niacin - Milligrams'],
  [18, 'Vitamin B6 - Milligrams'],
  [19, 'Folate (DFE) - Micrograms'],
  [20, 'Vitamin B12 - Micrograms'],
  [21, 'Calcium - Milligrams'],
  [22, 'Phosphorus - Milligrams'],
  [23, 'Magnesium - Milligrams'],
  [24, 'Iron - Milligrams'],
  [25, 'Zinc - Milligrams'],
  [26, 'Copper - Milligrams'],
  [27, 'Potassium - Milligrams'],
  [28, 'Selenium - Micrograms'],
  [29, 'Sodium - Milligrams'],
]

const NUTRIENT_FOODGROUP_NUTRIENTS: [string, string][] = [
  ['Food energy', 'Kilocalories'],
  ['Carbohydrates', 'Grams'],
  ['Protein', 'Grams'],
  ['Total fat', 'Grams'],
  ['Saturated fat', 'Grams'],
  ['Monounsaturated fat', 'Grams'],
  ['Polyunsaturated fat', 'Grams'],
  ['Cholesterol', 'Milligrams'],
  ['Dietary fiber', 'Grams'],
  ['Vitamin A (RAE)', 'Micrograms RAE'],
  ['Carotene', 'Micrograms'],
  ['Vitamin E', 'Milligrams ATE'],
  ['Vitamin C', 'Milligrams'],
  ['Thiamin', 'Milligrams'],
  ['Riboflavin', 'Milligrams'],
  ['Niacin', 'Milligrams'],
  ['Vitamin B6', 'Milligrams'],
  ['Folate (DFE)', 'Micrograms'],
  ['Vitamin B12', 'Micrograms'],
  ['Calcium', 'Milligrams'],
  ['Phosphorus', 'Milligrams'],
  ['Magnesium', 'Milligrams'],
  ['Iron', 'Milligrams'],
  ['Zinc', 'Milligrams'],
  ['Copper', 'Milligrams'],
  ['Potassium', 'Milligrams'],
  ['Selenium', 'Micrograms'],
  ['Sodium', 'Milligrams'],
]

const CATALOG: Record<string, Record<string, Source>> = {
  food_availability: {
    coffee_tea_cocoa: { format: 'wide_columnar', media: '/media/5327/coffee-tea-cocoa-and-spices-availability.csv', headerRow: 0, yearCol: 0, blockCol: 3, idCols: [0, 1, 2, 3], dataStart: 1 },
    dairy_fluid_milk: { format: 'long', media: '/media/5329/dairy-fluid-milk.csv' },
    dairy_products: { format: 'long', media: '/media/5331/dairy-products.csv' },
    eggs: { format: 'long', media: '/media/5333/eggs.csv' },
    fats_and_oils_added: {
      format: 'wide_fixed',
      media: '/media/5335/fats-and-oils-added.csv',
      block: 'Added fats and oils (product weight): Per capita food availability',
      yearCol: 0,
      dataStart: 5,
      columns: [[1, 'U.S. total population, July 1 - Millions'], [2, 'Butter - Pounds'], [3, 'Margarine - Pounds'], [4, 'Lard - Pounds'], [5, 'Edible tallow - Pounds'], [6, 'Shortening - Pounds'], [7, 'Salad and cooking oils - Pounds'], [8, 'Other edible fats and oils - Pounds'], [9, 'Total - Pounds']],
    },
    fish_and_shellfish: { format: 'long', media: '/media/5337/fish-and-shellfish.csv' },
    fruit_all_uses: { format: 'long', media: '/media/5339/fruit-all-uses.csv' },
    fruit_canned: { format: 'long', media: '/media/5341/fruit-canned.csv' },
    fruit_dried: { format: 'long', media: '/media/5343/fruit-dried.csv' },
    fruit_fresh: { format: 'long', media: '/media/5345/fruit-fresh.csv' },
    fruit_frozen: { format: 'long', media: '/media/5347/fruit-frozen.csv' },
    fruit_juices: { format: 'long', media: '/media/5349/fruit-juices.csv' },
    fruit_and_vegetables: { format: 'long', media: '/media/5351/fruit-and-vegetables.csv' },
    grains: { format: 'long', media: '/media/5353/grains.csv' },
    peanuts_and_tree_nuts: { format: 'long', media: '/media/5355/peanuts-and-tree-nuts.csv' },
    population: {
      format: 'wide_fixed',
      media: '/media/5357/population.csv',
      block: 'Population: Resident and resident plus Armed Forces overseas',
      yearCol: 0,
      dataStart: 8,
      columns: [[1, 'Resident population plus Armed Forces overseas - January 1 - Millions'], [2, 'Resident population plus Armed Forces overseas - July 1 - Millions'], [3, 'Resident - January 1 - Millions'], [4, 'Resident - July 1 - Millions'], [5, 'ERS estimate of resident plus Armed Forces overseas - July 1 - Millions']],
    },
    poultry_chicken_and_turkey: { format: 'long', media: '/media/5359/poultry-chicken-and-turkey.csv' },
    red_meat: { format: 'long', media: '/media/5361/red-meat-beef-veal-pork-lamb-and-mutton.csv' },
    red_meat_poultry_and_fish: { format: 'long', media: '/media/5363/red-meat-poultry-and-fish.csv' },
    sugar_and_sweeteners_added: { format: 'long', media: '/media/5365/sugar-and-sweeteners-added.csv' },
    vegetables_all_uses: { format: 'long', media: '/media/5367/vegetables-all-uses.csv' },
    vegetables_canned: { format: 'long', media: '/media/5369/vegetables-canned.csv' },
    vegetables_fresh: { format: 'long', media: '/media/5371/vegetables-fresh.csv' },
    vegetables_frozen: { format: 'long', media: '/media/5373/vegetables-frozen.csv' },
    vegetables_potatoes: { format: 'long', media: '/media/5375/vegetables-potatoes.csv' },
    vegetables_processed: { format: 'long', media: '/media/5377/vegetables-processed.csv' },
    vegetables_pulses: { format: 'long', media: '/media/5379/vegetables-pulses.csv' },
  },
  loss_adjusted: {
    calories: {
      format: 'wide_fixed',
      media: '/media/5381/calories.csv',
      block: 'Average daily per capita calories from the U.S. food availability, adjusted for spoilage and other waste',
      yearCol: 0,
      dataStart: 5,
      columns: [[1, 'Meat, eggs, and nuts'], [2, 'Dairy'], [3, 'Fruit'], [4, 'Vegetables'], [5, 'Flour and cereal products'], [6, 'Added fats and oils and dairy fats'], [7, 'Sugar and sweeteners (added)'], [8, 'Total']],
    },
    dairy: { format: 'long', media: '/media/5383/dairy-fluid-milk-cream-and-other-products.csv' },
    fats_and_oils_added: {
      format: 'wide_fixed',
      media: '/media/5385/fats-and-oils-added.csv',
      block: 'Butter: Per capita availability adjusted for loss',
      yearCol: 0,
      dataStart: 6,
      columns: [[1, 'Primary weight - Lbs/year'], [2, 'Loss from primary to retail weight - Percent'], [3, 'Retail weight - Lbs/year'], [4, 'Loss from retail/institutional to consumer level - Percent'], [5, 'Consumer weight - Lbs/year'], [6, 'Loss at consumer level - Nonedible share - Percent'], [7, 'Loss at consumer level - Edible weight - Lbs/year'], [8, 'Loss at consumer level - Other (cooking loss and uneaten food) - Percent'], [9, 'Total loss, all levels - Percent'], [10, 'Per capita availability adjusted for loss - Lbs/year'], [11, 'Per capita availability adjusted for loss - Oz/day'], [12, 'Per capita availability adjusted for loss - G/day'], [13, 'Calories per fat gram - Number']],
    },
    food_pattern_equivalents: {
      format: 'wide_fixed',
      media: '/media/5387/food-pattern-equivalents.csv',
      block: 'Average daily per capita food pattern equivalents from the U.S. food availability, adjusted for spoilage and other waste',
      yearCol: 0,
      dataStart: 7,
      columns: [[1, 'Meat, eggs, and nuts - Ounces'], [2, 'Dairy - Cups'], [3, 'Fruit - Cups'], [4, 'Vegetables - Cups'], [5, 'Flour and cereal products - Ounces'], [6, 'Added fats and oils and dairy fats - Grams'], [7, 'Added sugars - Teaspoons']],
    },
    fruit: { format: 'long', media: '/media/5389/fruit.csv' },
    grains: { format: 'long', media: '/media/5391/grains.csv' },
    meat_poultry_fish_eggs_and_nuts: { format: 'long', media: '/media/5393/meat-poultry-fish-eggs-and-nuts.csv' },
    sugar_and_sweeteners_added: { format: 'long', media: '/media/5395/sugar-and-sweeteners-added.csv' },
    vegetables: { format: 'long', media: '/media/5397/vegetables.csv' },
  },
  nutrient: {
    totals: { format: 'nutrient_totals', media: '/media/5325/nutrient-availability-food-energy-nutrients-and-dietary-components.xls', sheet: 'Totals', block: 'Totals', dataStart: 6 },
    food_group: { format: 'nutrient_foodgroups', media: '/media/5325/nutrient-availability-food-energy-nutrients-and-dietary-components.xls', sheet: 'Foodgroups', dataStart: 4 },
  },
}

type Observation = { block: string; year: number; attribute: string; value: number | null }

/** `parse_value`: a float with thousands separators removed; null for blanks, placeholders and non-numbers. */
function parseValue(raw: string | number | boolean | undefined): number | null {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'boolean') return raw ? 1 : 0
  const text = (raw ?? '').trim()
  if (NULL_TOKENS.has(text.toLowerCase())) return null
  return pyFloat(text.replace(/,/g, '')) ?? null
}

/** `is_year_token`: a four-digit calendar year. */
const isYearToken = (token: string): boolean => /^\d{4}$/.test(token.trim())

/** `clean_block_label`: surrounding whitespace and trailing footnote digits dropped. */
const cleanBlockLabel = (raw: string): string => raw.trim().replace(/[0-9]+$/, '').trim()

/** `_year_from_cell`. */
function yearFromCell(value: string | number | boolean): number | null {
  if (typeof value === 'number') {
    const year = Math.trunc(value)
    return year >= 1500 && year <= 2100 ? year : null
  }
  const text = (typeof value === 'string' ? value : value ? 'True' : '').trim()
  return isYearToken(text) ? Number(text) : null
}

/** A tidy [Commodity, Year, Attribute, Value] file; rows whose year is not a calendar year are skipped. */
function parseLong(text: string): Observation[] {
  const [, ...rows] = parseCsv(text)
  const out: Observation[] = []
  for (const row of rows) {
    if (row.length < 4) continue
    const yearToken = row[1]!.trim()
    if (!isYearToken(yearToken)) continue
    out.push({ block: row[0]!.trim(), year: Number(yearToken), attribute: row[2]!.trim(), value: parseValue(row[3]) })
  }
  return out
}

/** A columnar wide file with one header row. */
function parseWideColumnar(text: string, config: Extract<Source, { format: 'wide_columnar' }>): Observation[] {
  const rows = parseCsv(text)
  const header = rows[config.headerRow] ?? []
  const idCols = new Set(config.idCols)
  const measureCols = header.map((_, i) => i).filter((i) => !idCols.has(i))
  const out: Observation[] = []
  for (const row of rows.slice(config.dataStart)) {
    if (row.length <= config.yearCol || !isYearToken(row[config.yearCol]!)) continue
    const block = row.length > config.blockCol ? row[config.blockCol]!.trim() : ''
    const year = Number(row[config.yearCol]!.trim())
    for (const col of measureCols) out.push({ block, year, attribute: header[col]!.trim(), value: parseValue(col < row.length ? row[col] : '') })
  }
  return out
}

/** A single-block wide file with a hardcoded column map. */
function parseWideFixed(text: string, config: Extract<Source, { format: 'wide_fixed' }>): Observation[] {
  const out: Observation[] = []
  for (const row of parseCsv(text).slice(config.dataStart)) {
    if (row.length <= config.yearCol || !isYearToken(row[config.yearCol]!)) continue
    const year = Number(row[config.yearCol]!.trim())
    for (const [col, name] of config.columns) out.push({ block: config.block, year, attribute: name, value: parseValue(col < row.length ? row[col] : '') })
  }
  return out
}

function parseNutrientTotals(content: Uint8Array, config: Extract<Source, { format: 'nutrient_totals' }>): Observation[] {
  const rows = xlrdRows(sheetNamed(readXls(content), config.sheet))
  const out: Observation[] = []
  for (const row of rows.slice(config.dataStart)) {
    const year = yearFromCell(row[0]!)
    if (year === null) continue
    for (const [col, name] of NUTRIENT_TOTALS_COLUMNS) out.push({ block: config.block, year, attribute: name, value: parseValue(row[col]) })
  }
  return out
}

/** `foodgroup_columns`: a value column then a percent-of-total column for each nutrient, in sheet order. */
const FOODGROUP_COLUMNS: [number, string][] = NUTRIENT_FOODGROUP_NUTRIENTS.flatMap(([nutrient, unit], index): [number, string][] => [
  [index * 2 + 1, `${nutrient} - ${unit}`],
  [index * 2 + 2, `${nutrient} - Percent of total`],
])

function parseNutrientFoodgroups(content: Uint8Array, config: Extract<Source, { format: 'nutrient_foodgroups' }>): Observation[] {
  const rows = xlrdRows(sheetNamed(readXls(content), config.sheet))
  const out: Observation[] = []
  let block: string | null = null
  for (const row of rows.slice(config.dataStart)) {
    const first = row[0]!
    const year = yearFromCell(first)
    if (year === null) {
      if (typeof first === 'string' && first.trim()) block = cleanBlockLabel(first)
      continue
    }
    if (block === null) continue
    for (const [col, name] of FOODGROUP_COLUMNS) out.push({ block, year, attribute: name, value: parseValue(row[col]) })
  }
  return out
}

function parseRecords(content: Uint8Array, config: Source): Observation[] {
  switch (config.format) {
    case 'long':
      return parseLong(decodeText(content))
    case 'wide_columnar':
      return parseWideColumnar(decodeText(content), config)
    case 'wide_fixed':
      return parseWideFixed(decodeText(content), config)
    case 'nutrient_totals':
      return parseNutrientTotals(content, config)
    case 'nutrient_foodgroups':
      return parseNutrientFoodgroups(content, config)
  }
}

export async function foodAvailabilityPerCapita(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const dataSystem = optString(params, 'data_system') ?? DEFAULT_DATA_SYSTEM
  if (!DATA_SYSTEMS.includes(dataSystem)) throw new Error(`Invalid data system: ${dataSystem}. Valid data systems are: ${DATA_SYSTEMS.join(', ')}`)
  const files = CATALOG[dataSystem]!
  const foodGroup = optString(params, 'food_group') ?? SYSTEM_DEFAULT_GROUP[dataSystem]!
  const config = files[foodGroup]
  if (!config) throw new Error(`Invalid food group '${foodGroup}' for data system '${dataSystem}'. Valid food groups are: ${Object.keys(files).join(', ')}`)
  const commodity = optString(params, 'commodity')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const data = parseRecords(await fetchErsFile(ctx, config.media), config)

  // Pivot the selected block's measures into columns, oldest year first; a column with no value anywhere is dropped.
  const block = commodity ?? data[0]?.block
  const columnOrder = new Set<string>()
  const populated = new Set<string>()
  const byYear = new Map<number, Map<string, number | null>>()
  for (const r of data) {
    if (r.block !== block) continue
    if (startYear !== undefined && r.year < startYear) continue
    if (endYear !== undefined && r.year > endYear) continue
    columnOrder.add(r.attribute)
    if (r.value !== null) populated.add(r.attribute)
    let row = byYear.get(r.year)
    if (!row) {
      row = new Map()
      byYear.set(r.year, row)
    }
    row.set(r.attribute, r.value)
  }
  if (byYear.size === 0) throw new Error('No records match the given filters.')
  const columns = [...columnOrder].filter((name) => populated.has(name))
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const source = byYear.get(year)!
      const out: Row = { year }
      for (const name of columns) out[name] = source.get(name) ?? null
      return nullTokensToNone(out)
    })
}
