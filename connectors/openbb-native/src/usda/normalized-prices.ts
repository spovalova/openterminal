// usda/normalized_prices, provider usda. Ported from openbb_government_us/usda/models/normalized_prices.py and
// utils/ers_normalized_prices.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, decodeText, fetchErsFile, nullTokensToNone, optString, pyFloat, readZip } from './helpers.js'

const MEDIA_PATH = '/media/5552/all-tables-2025-csv-format.zip'
const INDEX_UNITS = 'Index, 2011=100'
const DEFAULT_TABLE = 'table1_national_prices'

type TableConfig = {
  csvPrefix: string
  dimension: 'year' | 'state'
  commodityField: string
  descriptionField: string | null
  unitsField: string | null
  unitsConstant: string | null
  columnField: string
  valueField: string
}

const NORMALIZED_PRICES_TABLES: Record<string, TableConfig> = {
  table1_national_prices: { csvPrefix: 'table1', dimension: 'year', commodityField: 'Commodity', descriptionField: 'Description', unitsField: 'Units', unitsConstant: null, columnField: 'Report Year', valueField: 'Price' },
  table2_national_indices: { csvPrefix: 'table2', dimension: 'year', commodityField: 'Commodity', descriptionField: null, unitsField: null, unitsConstant: INDEX_UNITS, columnField: 'Price index year', valueField: 'Price' },
  table3_state_prices: { csvPrefix: 'table3', dimension: 'state', commodityField: 'Commodity', descriptionField: 'Description', unitsField: 'Units', unitsConstant: null, columnField: 'State', valueField: 'Price' },
}

/** A year column is four digits; a state column is the stripped name. Anything else drops the row. */
function parseColumn(token: string, dimension: 'year' | 'state'): string | null {
  const text = token.trim()
  if (dimension === 'year') return /^\d{4}$/.test(text) ? String(Number(text)) : null
  return text || null
}

export async function normalizedPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = NORMALIZED_PRICES_TABLES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(NORMALIZED_PRICES_TABLES).join(', ')}`)

  // The first member of the archive whose file name starts with the table's prefix.
  const files = readZip(await fetchErsFile(ctx, MEDIA_PATH))
  const name = Object.keys(files).find((m) => m.split('/').pop()!.startsWith(config.csvPrefix) && m.toLowerCase().endsWith('.csv'))
  if (name === undefined) throw new Error(`no ${config.csvPrefix} CSV in the normalized-prices archive`)

  // One row per (commodity, description, units), in order of first appearance, with a column per year or state.
  type Wide = { commodity: string; units: string | null; description: string | null; values: Map<string, number | null> }
  const pivoted = new Map<string, Wide>()
  const columnKeys = new Set<string>()
  for (const row of csvDictRows(decodeText(files[name]!))) {
    const commodity = (row[config.commodityField] ?? '').trim()
    if (!commodity) continue
    const description = config.descriptionField ? (row[config.descriptionField] ?? '').trim() || null : null
    let units = config.unitsConstant
    if (units === null && config.unitsField) units = (row[config.unitsField] ?? '').trim() || null
    const column = parseColumn(row[config.columnField] ?? '', config.dimension)
    if (column === null) continue
    const valueText = (row[config.valueField] ?? '').trim()
    const parsed = valueText ? pyFloat(valueText) : undefined
    const key = JSON.stringify([commodity, description, units])
    let wide = pivoted.get(key)
    if (!wide) {
      wide = { commodity, units, description, values: new Map() }
      pivoted.set(key, wide)
    }
    columnKeys.add(column)
    wide.values.set(column, parsed ?? null)
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')

  const populated = [...columnKeys].filter((c) => [...pivoted.values()].some((w) => w.values.get(c) !== undefined && w.values.get(c) !== null))
  const ordered = config.dimension === 'year' ? populated.sort((a, b) => Number(a) - Number(b)) : populated.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return [...pivoted.values()].map((w) => {
    const out: Row = { commodity: w.commodity, units: w.units, description: w.description }
    for (const c of ordered) out[c] = w.values.get(c) ?? null
    return nullTokensToNone(out)
  })
}
