// usda/eating_and_health_module_atus, provider usda. Ported from openbb_government_us/usda/models/eating_and_health_module_atus.py
// and utils/ers_eating_and_health_module_atus.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models.
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchErsText, optString, pyFloat } from './helpers.js'

const DEFAULT_TABLE = 'eating_and_drinking_time'
const DEFAULT_YEAR = '2023'
const RELEASE_YEARS = ['2023', '2022']
const VALUE_SUFFIXES = [', mean', ', standard error']

/** Table → release year → media path. */
const EATING_HEALTH_TABLES: Record<string, Record<string, string>> = {
  eating_and_drinking_time: {
    '2023': '/media/6532/table-1-average-minutes-per-day-spent-in-and-percent-of-us-civilian-population-age-15-and-older-and-age-18-and-older-engaged-in-eating-and-drinking-associated-activities-and-secondary-eating-on-an-average-day-in-2023.csv',
    '2022': '/media/6516/table-1-time-spent-in-and-percent-of-us-civilian-population-engaged-in-eating-and-drinking-associated-activities-and-secondary-eating-on-an-average-day-in-2022-age-15-and-older-and-age-18-and-older.csv',
  },
  eating_time_by_subgroup: {
    '2023': '/media/6534/table-2-average-minutes-per-day-spent-in-and-percent-of-us-civilian-population-engaged-in-eating-and-drinking-associated-activities-and-secondary-eating-on-an-average-day-in-2023-by-various-subgroups.csv',
    '2022': '/media/6518/table-2-time-spent-in-and-percent-of-us-civilian-population-engaged-in-eating-and-drinking-associated-activities-and-secondary-eating-on-an-average-day-in-2022-by-various-subgroups.csv',
  },
  grocery_shopper_and_meal_preparer: {
    '2023': '/media/6536/table-3-usual-grocery-shopper-and-usual-meal-preparer-in-the-household-on-an-average-day-in-2023.csv',
    '2022': '/media/6520/table-3-usual-grocery-shopper-and-usual-meal-preparer-in-the-household-on-an-average-day-in-2022.csv',
  },
  fast_food_purchases: {
    '2023': '/media/6538/table-4-fast-food-purchases-number-of-times-over-previous-7-days-on-an-average-day-in-2023-for-us-civilian-population-who-purchased-fast-food-in-the-previous-week.csv',
    '2022': '/media/6522/table-4-fast-food-purchases-number-of-times-over-previous-7-days-on-an-average-day-in-2022-for-us-civilian-population-who-purchased-fast-food-in-the-previous-week.csv',
  },
  activities_by_grocery_responsibility: {
    '2023': '/media/6540/table-5-average-minutes-per-day-spent-in-selected-activities-by-how-much-of-the-grocery-shopping-the-interviewee-is-responsible-for-on-an-average-day-in-2023-age-18-and-older.csv',
    '2022': '/media/6524/table-5-average-time-spent-in-selected-activities-by-how-much-of-the-grocery-shopping-the-interviewee-is-responsible-for-on-an-average-day-in-2022-age-18-and-older.csv',
  },
  activities_by_meal_prep_responsibility: {
    '2023': '/media/6542/table-6-average-minutes-per-day-spent-in-selected-activities-by-how-much-of-the-meal-preparation-the-interviewee-is-responsible-for-on-an-average-day-in-2023-age-18-and-older.csv',
    '2022': '/media/6526/table-6-average-time-spent-in-selected-activities-by-how-much-of-the-meal-preparation-the-interviewee-is-responsible-for-on-an-average-day-in-2022-age-18-and-older.csv',
  },
  activities_by_food_security: {
    '2023': '/media/6544/table-7-average-minutes-per-day-spent-in-selected-food-related-and-other-activities-on-an-average-day-in-2023-age-18-and-older.csv',
    '2022': '/media/6528/table-7-average-minutes-per-day-spent-in-selected-food-related-and-other-activities-on-an-average-day-in-2022-age-18-and-older.csv',
  },
  activities_by_bmi_group: {
    '2023': '/media/6546/table-8-average-minutes-per-day-spent-in-selected-food-related-and-other-activities-on-an-average-day-in-2023-age-20-and-older.csv',
    '2022': '/media/6530/table-8-average-minutes-per-day-spent-in-selected-food-related-and-other-activities-on-an-average-day-in-2022-age-20-and-older.csv',
  },
}

export async function eatingAndHealthModuleAtus(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const media = EATING_HEALTH_TABLES[table]
  if (!media) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(EATING_HEALTH_TABLES).join(', ')}`)
  const year = optString(params, 'year') ?? DEFAULT_YEAR
  if (!RELEASE_YEARS.includes(year)) throw new Error(`Invalid year: ${year}. Valid years are: ${RELEASE_YEARS.join(', ')}`)

  // The first column is a row number; columns ending ", mean" or ", standard error" are values, the rest label the row.
  const [header, ...body] = parseCsv(await fetchErsText(ctx, media[year]!))
  if (!header) return []
  const dimIndices: number[] = []
  const valueColumns: [number, string][] = []
  header.forEach((name, index) => {
    if (index === 0) return
    if (VALUE_SUFFIXES.some((suffix) => name.trim().endsWith(suffix))) valueColumns.push([index, name])
    else dimIndices.push(index)
  })

  // One wide row per (category, subgroup, measure type), in file order.
  const pivoted = new Map<string, Row>()
  for (const row of body) {
    if (!row.some((c) => c.trim())) continue
    const dims = dimIndices.map((i) => (i < row.length ? row[i]!.trim() : ''))
    const category = dims[0] ? dims[0] : null
    const subgroup = dims[1] ? dims[1] : null
    const measureType = dims[2] ? dims[2] : null
    const key = JSON.stringify([category, subgroup, measureType])
    let wide = pivoted.get(key)
    if (!wide) {
      wide = { category, subgroup, measure_type: measureType }
      pivoted.set(key, wide)
    }
    for (const [index, name] of valueColumns) {
      const text = (index < row.length ? row[index]! : '').trim()
      wide[name] = text ? (pyFloat(text.replaceAll(',', '')) ?? null) : null
    }
  }
  return [...pivoted.values()].map((row) => {
    // category and subgroup are required strings in the model.
    for (const field of ['category', 'subgroup']) if (row[field] === null) throw new Error(`${field}: Input should be a valid string`)
    return row
  })
}
