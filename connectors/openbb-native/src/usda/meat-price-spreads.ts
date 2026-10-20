// usda/meat_price_spreads, provider usda. Ported from openbb_government_us/usda/models/meat_price_spreads.py and
// utils/ers_meat_price_spreads.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, pyFloat, pyInt, sortedBy } from './helpers.js'

const DEFAULT_TABLE = 'choice_beef'
const FREQUENCIES = ['annual', 'quarterly', 'monthly']
const ANNUAL_DESCRIPTORS = new Set(['Annual', 'Calendar year'])
const ANNUAL_PERIOD_NUMBER = 17

/** Table → [media id, file slug, period column, period-number column]. */
const MEAT_PRICE_SPREADS_FILES: Record<string, [number, string, string, string]> = {
  summary: [5025, 'summary-of-retail-prices-and-price-spreads', 'Month', 'Month_Number'],
  choice_beef: [5020, 'choice-beef-values-and-spreads-and-the-all-fresh-retail-value', 'Period', 'Period_Number'],
  pork: [5026, 'pork-values-and-spreads', 'Period', 'Period_Number'],
  retail_prices: [5024, 'retail-prices-for-beef-pork-poultry-cuts-eggs-and-dairy-products', 'Month', 'Month_Number'],
  historical_monthly: [5028, 'historical-monthly-price-spread-data-for-beef-pork-broilers', 'Month', 'Month-number'],
}

const frequencyFor = (periodNumber: number): string => (periodNumber === ANNUAL_PERIOD_NUMBER ? 'annual' : periodNumber >= 13 && periodNumber <= 16 ? 'quarterly' : 'monthly')

/** The year, with the month or quarter unless the period names the whole year. */
function periodLabel(year: number, period: string): string {
  if (!period || period.startsWith('Yr') || ANNUAL_DESCRIPTORS.has(period)) return String(year)
  if (period.includes(' to ')) return period
  return `${year} ${period}`
}

export async function meatPriceSpreads(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The table validator takes the first non-empty entry of a list.
  const raw = params.table
  const tableValue = Array.isArray(raw) ? raw.find(Boolean) : raw
  const table = tableValue === undefined || tableValue === null || tableValue === '' ? DEFAULT_TABLE : String(tableValue).trim()
  const file = Object.prototype.hasOwnProperty.call(MEAT_PRICE_SPREADS_FILES, table) ? MEAT_PRICE_SPREADS_FILES[table] : undefined
  if (!file) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(MEAT_PRICE_SPREADS_FILES).join(', ')}`)
  const frequency = typeof params.frequency === 'string' && params.frequency !== '' ? params.frequency : undefined
  if (frequency !== undefined && !FREQUENCIES.includes(frequency)) throw new Error(`Input should be 'annual', 'quarterly' or 'monthly': ${frequency}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')
  const [mediaId, slug, periodColumn, numberColumn] = file

  // parse_rows
  type Observation = { year: number; period: string; periodNumber: number; frequency: string; dataItem: string; value: number }
  const data: Observation[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, `/media/${mediaId}/${slug}.csv`))) {
    const text = cell(row, 'Value')
    if (!text || isNullToken(text)) continue
    const value = pyFloat(text.replace(/,/g, ''))
    if (value === undefined) throw new Error(`could not convert string to float: '${text.replace(/,/g, '')}'`)
    const numberText = cell(row, numberColumn) || '0'
    const periodNumber = pyInt(numberText)
    if (periodNumber === undefined) throw new Error(`invalid literal for int() with base 10: '${numberText}'`)
    const year = pyInt(cell(row, 'Year'))
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${cell(row, 'Year')}'`)
    data.push({ year, period: cell(row, periodColumn), periodNumber, frequency: frequencyFor(periodNumber), dataItem: cell(row, 'Data_Item'), value })
  }

  // transform_data: one row per year and period, a column per data item.
  type Wide = { year: number; periodSort: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const colOrder: string[] = []
  for (const r of data) {
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) continue
    if (frequency !== undefined && r.frequency !== frequency) continue
    const key = JSON.stringify([r.year, r.period])
    let row = pivoted.get(key)
    if (!row) {
      row = { year: r.year, periodSort: r.periodNumber, period: periodLabel(r.year, r.period), values: new Map() }
      pivoted.set(key, row)
    }
    if (!colOrder.includes(r.dataItem)) colOrder.push(r.dataItem)
    row.values.set(r.dataItem, r.value)
  }
  return sortedBy([...pivoted.values()], (w) => [w.year, w.periodSort]).map((w) => {
    const out: Row = { period: w.period }
    for (const column of colOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
