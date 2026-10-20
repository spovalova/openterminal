// usda/fruit_and_vegetable_prices, provider usda. Ported from openbb_government_us/usda/models/fruit_and_vegetable_prices.py
// and utils/ers_fruit_and_vegetable_prices.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optString, pyFloat, sortedBy } from './helpers.js'

const DEFAULT_TABLE = 'fruit'

const FVP_TABLES: Record<string, { media: string; itemColumn: string }> = {
  fruit: { media: '/media/6210/all-fruits-average-prices-csv-format.csv', itemColumn: 'Fruit' },
  vegetable: { media: '/media/6240/all-vegetables-average-prices-csv-format.csv', itemColumn: 'Vegetable' },
}

/** `parse_value`: a number with thousands separators; empty cells and null tokens are missing. */
function parseValue(raw: string | undefined): number | null {
  const text = (raw ?? '').trim()
  if (!text || isNullToken(text)) return null
  const n = pyFloat(text.replace(/,/g, ''))
  if (n === undefined) throw new Error(`could not convert string to float: '${text.replace(/,/g, '')}'`)
  return n
}

export async function fruitAndVegetablePrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = (optString(params, 'table') ?? DEFAULT_TABLE).toLowerCase()
  const config = FVP_TABLES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FVP_TABLES).join(', ')}`)

  const records: Row[] = []
  for (const raw of csvDictRows(await fetchErsText(ctx, config.media))) {
    // Header names are stripped; a later column of the same stripped name wins.
    const row: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(raw)) row[key.trim()] = value
    const item = (row[config.itemColumn] ?? '').trim()
    if (!item) continue
    records.push({
      item,
      form: (row.Form ?? '').trim() || null,
      average_retail_price: parseValue(row.AverageRetailPrice),
      average_retail_price_unit: (row.AverageRetailPriceUnitOfMeasure ?? '').trim() || null,
      preparation_yield_factor: parseValue(row.PreparationYieldFactor),
      cup_equivalent_size: parseValue(row.SizeOfACupEquivalent),
      cup_equivalent_unit: (row.CupEquivalentUnitOfMeasure ?? '').trim() || null,
      average_price_per_cup_equivalent: parseValue(row.AveragePricePerCupEquivalent),
    })
  }
  if (records.length === 0) throw new Error('No records returned for the given table.')
  return sortedBy(records, (r) => [r.item as string, (r.form as string | null) ?? '']).map((r) => {
    const out = nullTokensToNone(r)
    // item and form are required strings in the model.
    if (out.form === null) throw new Error('form: Input should be a valid string')
    return out
  })
}
