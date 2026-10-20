// usda/farm_household_income_and_characteristics, provider usda. Ported from openbb_government_us/usda/models/farm_household_income_and_characteristics.py
// and utils/ers_farm_household_income_and_characteristics.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models, and the preliminary "P" year column ERS added to the 2021-26F file is accepted.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy } from './helpers.js'

const DEFAULT_TABLE = 'finances_2021_26f'

type TableConfig = {
  media: string
  shape: 'year' | 'category' | 'combined'
  itemCol?: string
  dimCol?: string
  dimPrefix?: string
  dimDeunderscore?: boolean
}

const TABLE_CONFIG: Record<string, TableConfig> = {
  finances_2021_26f: { media: '/media/7005/principal-us-farm-operator-household-finances-2021-26f.csv', shape: 'year', itemCol: 'Item', dimCol: 'Year' },
  mean_median_income: { media: '/media/7001/mean-and-median-us-farm-operator-household-income-and-ratio-of-farm-household-to-us-household-income-1960-2024.csv', shape: 'year', itemCol: 'IncomeMeasure', dimCol: 'Year' },
  farm_size_class: { media: '/media/6999/all-farms-and-family-farms-by-farm-size-class-gross-sales-1996-2024.csv', shape: 'year', itemCol: 'FarmType', dimCol: 'Year' },
  by_farm_type_2024: { media: '/media/6995/principal-farm-operator-household-finances-by-farm-type-2024.csv', shape: 'category', itemCol: 'Item', dimCol: 'FarmType', dimDeunderscore: true },
  by_occupation_2024: { media: '/media/6997/finances-and-characteristics-of-principal-farm-operator-households-by-major-occupation-2024.csv', shape: 'category', itemCol: 'Item', dimCol: 'Occupation', dimPrefix: 'Major occupation of principal operator: ' },
  by_age_2024: { media: '/media/20794/characteristics-of-principal-farm-operator-households-by-age-of-principal-operators-2024.csv', shape: 'combined' },
  by_experience_2024: { media: '/media/20796/characteristics-of-principal-farm-operator-households-by-experience-of-operators-2024.csv', shape: 'combined' },
  by_management_team_2024: { media: '/media/20798/characteristics-of-principal-farm-operator-households-by-type-of-management-team-2024.csv', shape: 'combined' },
  by_limited_resource_2024: { media: '/media/20800/characteristics-of-principal-farm-operator-households-by-limited-resource-farm-status-2024.csv', shape: 'combined' },
  by_sex_2024: { media: '/media/20802/characteristics-of-principal-farm-operator-households-by-sex-of-principal-operator-2024.csv', shape: 'combined' },
}

const cleanLabel = (value: string | undefined): string => (value ?? '').replaceAll('\xa0', '').trim()

function cleanColumn(config: TableConfig, raw: string | undefined): string {
  let value = raw ?? ''
  if (config.dimPrefix && value.startsWith(config.dimPrefix)) value = value.slice(config.dimPrefix.length)
  if (config.dimDeunderscore) value = value.replaceAll('_', ' ')
  return value.trim()
}

/** `int(text)`, else `float(text)`, else missing. */
function parseValue(raw: string | undefined): number | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  return pyInt(text) ?? pyFloat(text) ?? null
}

/**
 * `int(column.rstrip("F"))`: a column like "2026F" is the forecast of 2026. ERS now also publishes a preliminary
 * "2025P" column in the 2021-26F file, which OpenBB's parser rejects (HTTP 422), so a trailing P is stripped too.
 */
function parseYear(column: string): number {
  const digits = column.replace(/[FP]+$/, '')
  const year = pyInt(digits)
  if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${digits}'`)
  return year
}

export async function farmHouseholdIncomeAndCharacteristics(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = TABLE_CONFIG[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(TABLE_CONFIG).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const records: { item: string; column: string; value: number | null }[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, config.media))) {
    let item: string
    let column: string
    if (config.shape === 'combined') {
      const label = row.Combined_Label ?? ''
      const at = label.indexOf(': ')
      if (at < 0) continue
      column = cleanLabel(label.slice(0, at))
      item = cleanLabel(label.slice(at + 2))
    } else {
      item = cleanLabel(row[config.itemCol!])
      column = cleanColumn(config, row[config.dimCol!])
    }
    if (!item || !column) continue
    records.push({ item, column, value: parseValue(row.Value) })
  }

  // A grid of items by columns; the year tables are filtered by year and ordered by it ("2026F" after "2026").
  const itemOrder = new Map<string, number>()
  const columnOrder = new Map<string, number>()
  const grid = new Map<string, number | null>()
  for (const r of records) {
    if (config.shape === 'year') {
      const year = parseYear(r.column)
      if (startYear !== undefined && year < startYear) continue
      if (endYear !== undefined && year > endYear) continue
    }
    if (!itemOrder.has(r.item)) itemOrder.set(r.item, itemOrder.size)
    if (!columnOrder.has(r.column)) columnOrder.set(r.column, columnOrder.size)
    grid.set(JSON.stringify([r.item, r.column]), r.value)
  }
  const columns = config.shape === 'year' ? sortedBy([...columnOrder.keys()], (c) => [parseYear(c), c.endsWith('F') ? 1 : 0]) : [...columnOrder.keys()]
  const live = columns.filter((c) => [...itemOrder.keys()].some((item) => (grid.get(JSON.stringify([item, c])) ?? null) !== null))
  if (itemOrder.size === 0 || live.length === 0) throw new Error('No records match the given filters.')
  return [...itemOrder.keys()].map((item) => {
    const row: Row = { item }
    for (const c of live) row[c] = grid.get(JSON.stringify([item, c])) ?? null
    const out = nullTokensToNone(row)
    if (out.item === null) throw new Error('item: Input should be a valid string')
    return out
  })
}
