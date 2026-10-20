// usda/food_dollar_series, provider usda. Ported from openbb_government_us/usda/models/food_dollar_series.py and
// utils/ers_food_dollar_series.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, pyInt } from './helpers.js'

const NULL_STRINGS = new Set(['', 'Not available'])

type SeriesConfig = { media: string; valueColumns: string[]; units: Record<string, string>; tables: number[] }
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

const FOOD_DOLLAR_FILES: Record<string, SeriesConfig> = {
  nominal: {
    media: '/media/7055/food-dollar-nominal-data-2011-model-1993-2023.csv',
    valueColumns: ['Salary_and_benefits', 'Property_income', 'Output_taxes', 'Imports', 'Total'],
    units: { share: 'Cents per Domestic Food Dollar', level: 'million dollars' },
    tables: range(22),
  },
  real: {
    media: '/media/7057/food-dollar-real-data-2011-model-1993-2023.csv',
    valueColumns: ['Value_added', 'Imports', 'Total'],
    units: { share: 'Cents per Domestic Real Food Dollar', level: 'million 2017 dollars' },
    tables: range(6),
  },
}

const COMPONENT_COLUMNS: Record<string, string> = {
  total: 'Total',
  salary_and_benefits: 'Salary_and_benefits',
  property_income: 'Property_income',
  output_taxes: 'Output_taxes',
  imports: 'Imports',
  value_added: 'Value_added',
}

const SERIES_COMPONENTS: Record<string, string[]> = {
  nominal: ['total', 'salary_and_benefits', 'property_income', 'output_taxes', 'imports'],
  real: ['total', 'value_added', 'imports'],
}

function toFloat(value: string | undefined): number | null {
  const text = (value ?? '').trim()
  if (NULL_STRINGS.has(text)) return null
  const n = pyFloat(text)
  if (n === undefined) throw new Error(`could not convert string to float: '${text}'`)
  return n
}

function toInt(value: string | undefined): number {
  const n = pyInt(value ?? '')
  if (n === undefined) throw new Error(`invalid literal for int() with base 10: '${value}'`)
  return n
}

export async function foodDollarSeries(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const series = (optString(params, 'series') ?? 'nominal').toLowerCase()
  const units = (optString(params, 'units') ?? 'share').toLowerCase()
  const component = (optString(params, 'component') ?? 'total').toLowerCase()
  const table = optInt(params, 'table') ?? 1
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')
  const entry = FOOD_DOLLAR_FILES[series]
  if (!entry) throw new Error(`series: Input should be 'nominal' or 'real'`)
  if (!(units in entry.units)) throw new Error(`units: Input should be 'share' or 'level'`)
  const components = SERIES_COMPONENTS[series]!
  if (!components.includes(component)) throw new Error(`Invalid component '${component}' for series '${series}'. Valid components are: ${components.join(', ')}`)
  if (!entry.tables.includes(table)) throw new Error(`Invalid table ${table} for series '${series}'. Valid tables are ${entry.tables[0]}-${entry.tables.at(-1)}.`)
  const unitsLabel = entry.units[units]!
  const componentColumn = COMPONENT_COLUMNS[component]!

  // One row per category with a column per year, for the chosen table, units and component.
  type Wide = { categoryNum: number; industryGroup: string; years: Map<number, number | null> }
  const pivoted = new Map<number, Wide>()
  for (const row of csvDictRows(await fetchErsText(ctx, entry.media))) {
    const record = {
      tableNum: toInt(row.Table_num),
      categoryNum: toInt(row.Category_num),
      industryGroup: (row.Category_desc ?? '').trim(),
      year: toInt(row.Year),
      units: (row.Units ?? '').trim(),
      values: Object.fromEntries(entry.valueColumns.map((c) => [c, toFloat(row[c])])) as Record<string, number | null>,
    }
    if (record.tableNum !== table || record.units !== unitsLabel) continue
    if (startYear !== undefined && record.year < startYear) continue
    if (endYear !== undefined && record.year > endYear) continue
    let wide = pivoted.get(record.categoryNum)
    if (!wide) {
      wide = { categoryNum: record.categoryNum, industryGroup: record.industryGroup, years: new Map() }
      pivoted.set(record.categoryNum, wide)
    }
    wide.years.set(record.year, record.values[componentColumn] ?? null)
  }
  const results = [...pivoted.values()].sort((a, b) => a.categoryNum - b.categoryNum).filter((w) => [...w.years.values()].some((v) => v !== null))
  if (results.length === 0) throw new Error('No records match the given filters.')
  return results.map((w) => {
    const out: Row = { industry_group: w.industryGroup }
    for (const year of [...w.years.keys()].sort((a, b) => a - b)) out[String(year)] = w.years.get(year)
    return nullTokensToNone(out)
  })
}
