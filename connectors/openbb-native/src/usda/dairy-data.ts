// usda/dairy_data, provider usda. Ported from openbb_government_us/usda/models/dairy_data.py and utils/ers_dairy_data.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, the product page used for cache
// lifetimes is not fetched.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, optInt, pyFloat, pyInt } from './helpers.js'

const DEFAULT_TABLE = 'situation_at_a_glance'
const FREQUENCIES = ['monthly', 'quarterly', 'annual']

/** Table → [media id, file slug]; the file is `/media/<id>/<slug>.csv`. */
const DAIRY_DATA_FILES: Record<string, [number, string]> = {
  situation_at_a_glance: [5501, 'us-dairy-situation-at-a-glance-monthly-and-annual'],
  milk_production_quarterly: [5503, 'us-milk-production-and-related-data-quarterly-and-annual'],
  supply_utilization_products: [5505, 'supply-and-utilization-of-dairy-product-categories-monthly-and-annual'],
  supply_utilization_milk: [5507, 'supply-and-utilization-of-milk-in-all-products-monthly-and-annual'],
  milk_fat_skim_solids_allocation: [7134, 'supply-and-allocation-of-milk-fat-and-skim-solids-by-product-annual'],
  per_capita_consumption: [5510, 'dairy-products-per-capita-consumption-united-states-annual'],
  fluid_milk_sales: [5512, 'fluid-beverage-milk-sales-quantities-by-product-annual'],
  soft_products_domestic_use: [5514, 'selected-soft-dairy-products-domestic-use-annual'],
  milk_cows_by_state: [5516, 'milk-cows-and-production-by-state-and-region-annual'],
  production_factors: [5518, 'annual-milk-production-and-factors-affecting-supply-annual'],
  fluid_milk_plants: [5520, 'number-and-average-size-of-u-s-fluid-milk-product-plants'],
  cheese_per_capita: [5522, 'per-capita-consumption-of-selected-cheese-varieties-annual'],
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The last day of the period a Timeperiod_id names: a month (1-12), a quarter (13-16) or the year. */
function periodEnd(year: number, timeperiodId: number): string {
  const monthEnd = (month: number): string => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`
  if (timeperiodId >= 1 && timeperiodId <= 12) return monthEnd(timeperiodId)
  if (timeperiodId >= 13 && timeperiodId <= 16) return monthEnd((timeperiodId - 12) * 3)
  return `${String(year).padStart(4, '0')}-12-31`
}

function frequencyOf(timeperiodId: number): string {
  if (timeperiodId >= 1 && timeperiodId <= 12) return 'monthly'
  return timeperiodId >= 13 && timeperiodId <= 16 ? 'quarterly' : 'annual'
}

/** `clean_label`: whitespace collapsed, or missing when nothing is left. */
function cleanLabel(value: string | undefined): string | null {
  if (value === undefined) return null
  return value.split(/\s+/).filter(Boolean).join(' ') || null
}

/** `a or b` for CSV cells: the first non-empty one. */
const firstNonEmpty = (...cells: (string | undefined)[]): string => cells.find((c) => c !== undefined && c !== '') ?? ''

type Observation = {
  table: string
  date: string
  year: number
  frequency: string
  sub_table: string | null
  product: string | null
  category: string | null
  data_item: string
  data_item_id: string | null
  region: string | null
  state: string | null
  value: number
  unit: string
}

/** `parse_rows`: one tidy CSV as observations; rows without a value or marked NA are skipped. */
function parseRows(text: string, table: string): Observation[] {
  const rows: Observation[] = []
  for (const row of csvDictRows(text)) {
    const rawValue = firstNonEmpty(row.Value, row.Quantity).trim()
    if (!rawValue || rawValue.toUpperCase() === 'NA') continue
    const year = pyInt(row.Year ?? '')
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${row.Year ?? ''}'`)
    const idText = firstNonEmpty(row.Timeperiod_id, '17').trim()
    const timeperiodId = pyInt(idText)
    if (timeperiodId === undefined) throw new Error(`invalid literal for int() with base 10: '${idText}'`)
    const value = pyFloat(rawValue)
    if (value === undefined) throw new Error(`could not convert string to float: '${rawValue}'`)
    rows.push({
      table,
      date: periodEnd(year, timeperiodId),
      year,
      frequency: frequencyOf(timeperiodId),
      sub_table: cleanLabel(row.Table),
      product: cleanLabel(row.Product),
      category: cleanLabel(row.Category),
      data_item: cleanLabel(row.Data_item) ?? '',
      data_item_id: cleanLabel(row.Data_item_id),
      region: cleanLabel(row.Region),
      state: cleanLabel(row.State),
      value,
      unit: cleanLabel(firstNonEmpty(row.Unit, row.Units)) ?? '',
    })
  }
  return rows
}

export async function dairyData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The table validator takes a name or several, comma-separated or as a list.
  const raw = params.table
  const requested = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
  const tables = requested.length ? requested : [DEFAULT_TABLE]
  const unknown = tables.filter((t) => !Object.prototype.hasOwnProperty.call(DAIRY_DATA_FILES, t))
  if (unknown.length) throw new Error(`Invalid table(s): ${unknown.join(', ')}. Valid tables are: ${Object.keys(DAIRY_DATA_FILES).sort().join(', ')}`)
  const frequency = typeof params.frequency === 'string' && params.frequency !== '' ? params.frequency : undefined
  if (frequency !== undefined && !FREQUENCIES.includes(frequency)) throw new Error(`Input should be 'monthly', 'quarterly' or 'annual': ${frequency}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const data = (
    await Promise.all(
      tables.map(async (table) => {
        const [id, slug] = DAIRY_DATA_FILES[table]!
        return parseRows(await fetchErsText(ctx, `/media/${id}/${slug}.csv`), table)
      }),
    )
  ).flat()

  // One row per series, one column per period end date.
  const pivoted = new Map<string, Row>()
  const observations = new Map<string, Map<string, number>>()
  for (const r of data) {
    if (frequency !== undefined && r.frequency !== frequency) continue
    if (startYear !== undefined && r.year < startYear) continue
    if (endYear !== undefined && r.year > endYear) continue
    const key = JSON.stringify([r.table, r.category, r.data_item, r.unit, r.sub_table, r.product, r.region, r.state, r.data_item_id])
    if (!pivoted.has(key)) {
      observations.set(key, new Map())
      pivoted.set(key, { category: r.category, data_item: r.data_item, unit: r.unit, sub_table: r.sub_table, product: r.product, region: r.region, state: r.state, data_item_id: r.data_item_id })
    }
    observations.get(key)!.set(r.date, r.value)
  }
  const dates = [...new Set([...observations.values()].flatMap((m) => [...m.keys()]))].sort()
  return [...pivoted.entries()].map(([key, row]) => {
    const out: Row = { ...row }
    for (const date of dates) out[date] = observations.get(key)!.get(date) ?? null
    return nullTokensToNone(out)
  })
}
