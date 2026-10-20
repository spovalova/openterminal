// usda/food_price_outlook, provider usda. Ported from openbb_government_us/usda/models/food_price_outlook.py and
// utils/ers_food_price_outlook.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy } from './helpers.js'

const DEFAULT_TABLE = 'cpi_forecast'

type Kind = 'snapshot' | 'annual' | 'history'
const FOOD_PRICE_OUTLOOK_FILES: Record<string, { media: string; kind: Kind }> = {
  cpi_forecast: { media: '/media/6460/changes-in-consumer-price-indexes-2023-through-2026.csv', kind: 'snapshot' },
  ppi_forecast: { media: '/media/6468/changes-in-producer-price-indexes-2023-through-2026.csv', kind: 'snapshot' },
  cpi_annual: { media: '/media/6462/annual-percent-changes-in-selected-consumer-price-indexes-1974-through-2025.csv', kind: 'annual' },
  ppi_annual: { media: '/media/6470/annual-percent-changes-in-selected-producer-price-indexes-1974-through-2025.csv', kind: 'annual' },
  cpi_forecast_history: { media: '/media/6464/historical-consumer-price-index-cpi-forecast-series.csv', kind: 'history' },
  ppi_forecast_history: { media: '/media/6466/historical-producer-price-index-ppi-forecast-series.csv', kind: 'history' },
}

const ITEM_RENAMES: Record<string, string> = { 'Farm-level fruit': 'Farm-level fruits' }
const HIERARCHY_COLUMNS = ['Top-level', 'Aggregate', 'Mid-level', 'Low-level', 'Disaggregate']
const HIERARCHY_FIELDS = ['top_level', 'aggregate', 'mid_level', 'low_level', 'disaggregate']
const SNAPSHOT_YEAR_PATTERN = /^(?:Annual|(?:Lower bound|Mid point|Upper bound) of prediction interval) (\d{4})$/

/** `clean_label`: superscript digits and asterisks (footnote marks) removed, then stripped. */
const cleanLabel = (text: string | undefined): string => (text ?? '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹*]/g, '').trim()
const normalizeItem = (text: string | undefined): string => {
  const label = cleanLabel(text)
  return ITEM_RENAMES[label] ?? label
}

/** The value of the "... Price Index item" column, whatever its exact header. */
function itemValue(row: Record<string, string | undefined>): string {
  for (const [key, value] of Object.entries(row)) if (key && key.trim().endsWith('Price Index item')) return value || ''
  throw new Error(`No 'Price Index item' column found. Columns: ${Object.keys(row).join(', ')}`)
}

function int(text: string | undefined): number {
  const n = pyInt(text ?? '')
  if (n === undefined) throw new Error(`invalid literal for int() with base 10: '${text}'`)
  return n
}

function float(text: string): number {
  const n = pyFloat(text)
  if (n === undefined) throw new Error(`could not convert string to float: '${text}'`)
  return n
}

type Observation = { item: string; attribute: string; unit: string; year: number | null; value: number; forecastDate?: string; levels?: (string | null)[] }

function parseSnapshotRows(text: string): Observation[] {
  const rows: Observation[] = []
  for (const row of csvDictRows(text)) {
    const value = (row.Value ?? '').trim()
    if (!value) continue
    const attribute = cleanLabel(row.Attribute)
    const year = SNAPSHOT_YEAR_PATTERN.exec(attribute)
    const record: Observation = { attribute, unit: cleanLabel(row.Unit), year: year ? Number(year[1]) : null, value: float(value), item: '' }
    if ('Top-level' in row) {
      const levels = HIERARCHY_COLUMNS.map((col) => cleanLabel(row[col]))
      record.levels = levels.map((l) => l || null)
      record.item = [...levels].reverse().find((l) => l) ?? ''
    } else record.item = normalizeItem(itemValue(row))
    rows.push(record)
  }
  return rows
}

function parseAnnualRows(text: string): Observation[] {
  const rows: Observation[] = []
  for (const row of csvDictRows(text)) {
    const value = (row['Percent change'] ?? '').trim()
    if (!value) continue
    rows.push({ item: normalizeItem(itemValue(row)), attribute: 'Annual percent change', unit: 'Percent change', year: int((row.Year ?? '').trim()), value: float(value) })
  }
  return rows
}

function parseHistoryRows(text: string): Observation[] {
  const rows: Observation[] = []
  for (const row of csvDictRows(text)) {
    const value = (row['Forecast percent change'] ?? '').trim()
    if (!value) continue
    const year = int((row['Year of forecast'] ?? '').trim())
    const month = int((row['Month of forecast'] ?? '').trim())
    rows.push({
      item: normalizeItem(itemValue(row)),
      attribute: cleanLabel(row.Attribute),
      unit: 'Percent change',
      year: int((row['Year being forecast'] ?? '').trim()),
      forecastDate: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
      value: float(value),
    })
  }
  return rows
}

export async function foodPriceOutlook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const file = FOOD_PRICE_OUTLOOK_FILES[table]
  if (!file) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FOOD_PRICE_OUTLOOK_FILES).join(', ')}`)
  const selected = optString(params, 'item')?.toLowerCase()
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = await fetchErsText(ctx, file.media)
  const data = file.kind === 'snapshot' ? parseSnapshotRows(text) : file.kind === 'annual' ? parseAnnualRows(text) : parseHistoryRows(text)
  const withinYears = (year: number | null): boolean => year === null || ((startYear === undefined || year >= startYear) && (endYear === undefined || year <= endYear))
  const itemMatches = (item: string): boolean => selected === undefined || item.toLowerCase() === selected
  const keep = data.map((record, order) => ({ record, order })).filter(({ record }) => withinYears(record.year) && itemMatches(record.item))

  if (file.kind === 'annual') {
    // One row per year with a column per item.
    const pivoted = new Map<number, { year: number; row: Row }>()
    for (const { record } of keep) {
      let wide = pivoted.get(record.year!)
      if (!wide) {
        wide = { year: record.year!, row: { item: String(record.year), unit: record.unit } }
        pivoted.set(record.year!, wide)
      }
      wide.row[record.item] = record.value
    }
    return sortedBy([...pivoted.values()], (w) => [w.year]).map((w) => nullTokensToNone(w.row))
  }
  if (file.kind === 'history') {
    // One row per (item, year being forecast, forecast month) with a column per attribute.
    type Wide = { order: number; item: string; year: number; forecastDate: string; row: Row }
    const pivoted = new Map<string, Wide>()
    for (const { record, order } of keep) {
      const key = JSON.stringify([record.item, record.year, record.forecastDate])
      let wide = pivoted.get(key)
      if (!wide) {
        wide = { order, item: record.item, year: record.year!, forecastDate: record.forecastDate!, row: { item: record.item, year: record.year, forecast_date: record.forecastDate, unit: record.unit } }
        pivoted.set(key, wide)
      }
      wide.row[record.attribute] = record.value
    }
    return sortedBy([...pivoted.values()], (w) => [w.item, w.year, w.forecastDate, w.order]).map((w) => nullTokensToNone(w.row))
  }
  // Snapshot: one row per item and hierarchy path with a column per attribute, in file order.
  const pivoted = new Map<string, Row>()
  for (const { record } of keep) {
    const key = JSON.stringify([record.item, ...(record.levels ?? HIERARCHY_FIELDS.map(() => null))])
    let row = pivoted.get(key)
    if (!row) {
      const created: Row = { item: record.item }
      HIERARCHY_FIELDS.forEach((field, i) => {
        created[field] = record.levels?.[i] ?? null
      })
      row = created
      pivoted.set(key, row)
    }
    row[record.attribute] = record.value
  }
  return [...pivoted.values()].map(nullTokensToNone)
}
