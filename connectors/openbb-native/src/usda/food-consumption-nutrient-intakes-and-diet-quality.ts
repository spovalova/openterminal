// usda/food_consumption_nutrient_intakes_and_diet_quality, provider usda. Ported from
// openbb_government_us/usda/models/food_consumption_nutrient_intakes_and_diet_quality.py and
// utils/ers_food_consumption_nutrient_intakes_and_diet_quality.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, sortedBy } from './helpers.js'

const DEFAULT_TABLE = '2_nutrient_intake'
const SAMPLE_TABLE = '1_sample_sizes'
const RECOMMENDED_TABLE = '8_recommended_vs_actual_density'
const NUTRIENT_TABLES = new Set(['2_nutrient_intake', '3_nutrient_intake_share', '4_nutrient_density'])

const TABLE_FILES: Record<string, string> = {
  '1_sample_sizes': '/media/5463/table-1-sample-sizes-by-population-subgroups-for-each-survey-cycle.csv',
  '2_nutrient_intake': '/media/5465/table-2-daily-nutrient-intake-by-food-source-1977-2018.csv',
  '3_nutrient_intake_share': '/media/5467/table-3-daily-nutrient-intake-and-share-by-food-source-1977-2018.csv',
  '4_nutrient_density': '/media/5469/table-4-nutrient-density-by-food-source-1977-2018.csv',
  '5_food_group_intake': '/media/5471/table-5-intakes-of-food-group-by-food-source-1977-2018.csv',
  '6_food_group_intake_share': '/media/5473/table-6-daily-food-equivalent-group-intake-and-share-by-food-source-1977-2018.csv',
  '7_food_group_density': '/media/5475/table-7-density-of-food-group-by-food-source-1977-2018.csv',
  '8_recommended_vs_actual_density': '/media/5477/table-8-the-2020-2025-recommended-and-2017-2018-nutrient-and-food-group-density.csv',
}

const FOOD_SOURCES = ['Total', 'FAH', 'FAFH', 'FAFH: Restaurant', 'FAFH: Fast food', 'FAFH: School', 'FAFH: Others']
const DEMOGRAPHICS = [
  'US consumers aged 2 and above',
  'Sex - Males',
  'Sex - Females',
  'Ages 2-19',
  'Ages 20-64',
  'Ages 65 and above',
  'Cohort - Boys age 2-19',
  'Cohort - Girls age 2-19',
  'Cohort - Men age 20 and above',
  'Cohort - Women age 20 and above',
  'Income - low-income households',
  'Income - mid-income households',
  'Income - high-income households',
  'Race - Non-Hispanic White',
  'Race - Non-Hispanic Black',
  'Race - Hispanic',
  'Race - Other racial & ethnic',
  'Edu. - Less than high school',
  'Edu. - High school degree',
  'Edu. - College attended',
]
const DEFAULT_DEMOGRAPHIC = 'US consumers aged 2 and above'
const STATISTIC_CHOICES: Record<string, string> = { mean: 'Mean', se_of_mean: 'SE of mean' }
const DEFAULT_STATISTIC = 'mean'

/** Table 8's raw `Variable` → column label, in column order. */
const RECOMMENDED_COLUMNS: [string, string][] = [
  ['Recommended density*:Nutrient or food group amount per 1,000 calories', 'Recommended'],
  ['2017-2018 Actual density-Total-Nutrient or food group amount per 1,000 calories', 'Actual: Total'],
  ['2017-2018 Actual density-FAH-Nutrient or food group amount per 1,000 calories', 'Actual: FAH'],
  ['2017-2018 Actual density-FAFH-Nutrient or food group amount per 1,000 calories', 'Actual: FAFH'],
  ['2017-2018 Actual density-Restaurant-Nutrient or food group amount per 1,000 calories', 'Actual: Restaurant'],
  ['2017-2018 Actual density-Fast food-Nutrient or food group amount per 1,000 calories', 'Actual: Fast food'],
  ['2017-2018 Actual density-School-Nutrient or food group amount per 1,000 calories', 'Actual: School'],
  ['2017-2018 density as a ratio of the recommended density-Total-Ratio of actual density to the recommended density', 'Ratio: Total'],
  ['2017-2018 density as a ratio of the recommended density-FAH-Ratio of actual density to the recommended density', 'Ratio: FAH'],
  ['2017-2018 density as a ratio of the recommended density-FAFH-Ratio of actual density to the recommended density', 'Ratio: FAFH'],
  ['2017-2018 density as a ratio of the recommended density-Restaurant-Ratio of actual density to the recommended density', 'Ratio: Restaurant'],
  ['2017-2018 density as a ratio of the recommended density-Fast food-Ratio of actual density to the recommended density', 'Ratio: Fast food'],
  ['2017-2018 density as a ratio of the recommended density-School-Ratio of actual density to the recommended density', 'Ratio: School'],
]
const RECOMMENDED_COLUMN_MAP = new Map(RECOMMENDED_COLUMNS)
const RECOMMENDED_COLUMN_ORDER = RECOMMENDED_COLUMNS.map(([, label]) => label)

const UNIT_ALIASES: Record<string, string> = { 'Grams per 1,000': 'Grams per 1,000 calories' }

const normalizeUnit = (measurement: string | undefined): string | null => {
  const unit = (measurement ?? '').trim()
  return unit ? (UNIT_ALIASES[unit] ?? unit) : null
}

/** `rpartition("-")` of "1977-1978-Mean": the survey cycle and the variable. */
function splitCycleVariable(value: string | undefined): [string, string] {
  const text = value ?? ''
  const at = text.lastIndexOf('-')
  return at < 0 ? ['', text.trim()] : [text.slice(0, at).trim(), text.slice(at + 1).trim()]
}

const toNumber = (raw: string | undefined): number | null => {
  const text = (raw ?? '').trim()
  return text ? (pyFloat(text) ?? null) : null
}

const toNumberOrText = (raw: string | undefined): number | string | null => {
  const text = (raw ?? '').trim()
  return text ? (pyFloat(text) ?? text) : null
}

/** The first four characters as a year, when they are digits. */
const cycleYear = (cycle: string): number | null => (/^\d+$/.test(cycle.slice(0, 4)) ? Number(cycle.slice(0, 4)) : null)

type Group = { order: number; sourceIndex: number; item: string; foodSource: string | null; units: string | null; itemOrder: number; values: Map<string, number | string | null> }

export async function foodConsumptionNutrientIntakesAndDietQuality(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!(table in TABLE_FILES)) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(TABLE_FILES).join(', ')}`)
  const demographics = optString(params, 'demographics') ?? DEFAULT_DEMOGRAPHIC
  if (!DEMOGRAPHICS.includes(demographics)) throw new Error(`Invalid demographics: ${demographics}. Valid subgroups are: ${DEMOGRAPHICS.join(', ')}`)
  const statisticKey = optString(params, 'statistic') ?? DEFAULT_STATISTIC
  if (!(statisticKey in STATISTIC_CHOICES)) throw new Error(`Invalid statistic: ${statisticKey}. Valid statistics are: ${Object.keys(STATISTIC_CHOICES).join(', ')}`)
  const statistic = STATISTIC_CHOICES[statisticKey]!
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')
  const inYears = (year: number): boolean => !((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear))

  const rows = csvDictRows(await fetchErsText(ctx, TABLE_FILES[table]!))
  const groups = new Map<string, Group>()
  const itemFirst = new Map<string, number>()
  const present = new Set<string>()
  let columnOrder: string[]

  if (table === SAMPLE_TABLE) {
    // Population subgroup by survey cycle: the sample size.
    rows.forEach((row, order) => {
      const subgroup = (row.Demographics ?? '').trim()
      const cycle = (row['Survey years'] ?? '').trim()
      const size = (row['Sample size'] ?? '').trim()
      const year = cycleYear(cycle)
      if (year === null || !inYears(year)) return
      if (!itemFirst.has(subgroup)) itemFirst.set(subgroup, order)
      let g = groups.get(subgroup)
      if (!g) {
        g = { order, sourceIndex: 0, item: subgroup, foodSource: null, units: null, itemOrder: 0, values: new Map() }
        groups.set(subgroup, g)
      }
      g.values.set(cycle, /^\d+$/.test(size) ? Number(size) : null)
      present.add(cycle)
    })
    columnOrder = [...present].sort((a, b) => (cycleYear(a) ?? 0) - (cycleYear(b) ?? 0))
  } else if (table === RECOMMENDED_TABLE) {
    // Nutrient or food group by recommended, actual and ratio columns.
    rows.forEach((row, order) => {
      const column = RECOMMENDED_COLUMN_MAP.get((row.Variable ?? '').trim())
      if (column === undefined) return
      const item = (row['Nutrient or Food group'] ?? '').trim()
      if (!itemFirst.has(item)) itemFirst.set(item, order)
      let g = groups.get(item)
      if (!g) {
        g = { order, sourceIndex: 0, item, foodSource: null, units: null, itemOrder: 0, values: new Map() }
        groups.set(item, g)
      }
      g.values.set(column, toNumberOrText(row.Value))
    })
    columnOrder = RECOMMENDED_COLUMN_ORDER
  } else {
    // Nutrient or food group by food source, one column per survey cycle for the chosen subgroup and statistic.
    const itemColumn = NUTRIENT_TABLES.has(table) ? 'Nutrient' : 'Food group'
    rows.forEach((row, order) => {
      if ((row.Demographics ?? '').trim() !== demographics) return
      const [cycle, stat] = splitCycleVariable(row['Survey years:Variable'])
      if (stat !== statistic) return
      const year = cycleYear(cycle)
      if (year === null || !inYears(year)) return
      const item = (row[itemColumn] ?? '').trim()
      const source = (row['Food source'] ?? '').trim()
      const units = normalizeUnit(row.Measurement)
      if (!itemFirst.has(item)) itemFirst.set(item, order)
      const key = JSON.stringify([item, source])
      let g = groups.get(key)
      if (!g) {
        const at = FOOD_SOURCES.indexOf(source)
        g = { order, sourceIndex: at < 0 ? 0 : at, item, foodSource: source, units, itemOrder: 0, values: new Map() }
        groups.set(key, g)
      }
      if (g.units === null && units !== null) g.units = units
      g.values.set(cycle, toNumber(row.Value))
      present.add(cycle)
    })
    columnOrder = [...present].sort((a, b) => (cycleYear(a) ?? 0) - (cycleYear(b) ?? 0))
  }
  if (groups.size === 0) throw new Error('No records match the given filters.')
  for (const g of groups.values()) g.itemOrder = itemFirst.get(g.item)!

  return sortedBy([...groups.values()], (g) => [g.itemOrder, g.sourceIndex, g.order]).map((g) => {
    const out: Row = { item: g.foodSource ? `${g.item} — ${g.foodSource}` : g.item, food_source: g.foodSource, units: g.units }
    for (const column of columnOrder) out[column] = g.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
