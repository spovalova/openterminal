// usda/international_baseline_data, provider usda. Ported from openbb_government_us/usda/models/international_baseline_data.py
// and utils/ers_international_baseline_data.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, readZip } from './helpers.js'

const MEDIA_PATH = '/media/5324/international-baseline-data-sets.zip'
const COMMODITIES = ['Barley', 'Beef and veal', 'Corn', 'Cotton', 'Pork', 'Poultry', 'Rice', 'Sorghum', 'Soybean meal', 'Soybean oil', 'Soybeans', 'Wheat']
const DEFAULT_COMMODITY = 'Wheat'
const DEFAULT_ATTRIBUTE = 'Production'

/** `parse_amount`: thousands separators dropped; blank or unparsable is missing. */
function parseAmount(raw: string): number | null {
  const text = raw.replace(/,/g, '').trim()
  return text ? (pyFloat(text) ?? null) : null
}

export async function internationalBaselineData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const commodity = optString(params, 'commodity') ?? DEFAULT_COMMODITY
  if (!COMMODITIES.includes(commodity)) throw new Error(`Invalid commodity: ${commodity}. Valid commodities are: ${COMMODITIES.join(', ')}`)
  const attribute = optString(params, 'attribute') ?? DEFAULT_ATTRIBUTE
  const country = optString(params, 'country')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // The archive holds one CSV; its first member is read.
  const members = readZip(await fetchErsFile(ctx, MEDIA_PATH))
  const name = Object.keys(members).find((n) => n.toLowerCase().endsWith('.csv'))
  if (name === undefined) throw new Error('No CSV member found in the international baseline archive.')

  const columns = new Set<string>()
  const byYear = new Map<number, Row>()
  for (const r of csvDictRows(decodeText(members[name]!))) {
    if (cell(r, 'Commodity') !== commodity) continue
    if (cell(r, 'Attribute') !== attribute) continue
    const recordCountry = cell(r, 'Country')
    if (country !== undefined && recordCountry !== country) continue
    const amount = parseAmount(r.Amount ?? '')
    if (amount === null) continue
    const yearLabel = cell(r, 'Year')
    if (!/^\d{4}/.test(yearLabel)) continue
    const year = Number(yearLabel.slice(0, 4))
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    columns.add(recordCountry)
    let row = byYear.get(year)
    if (!row) {
      byYear.set(year, (row = { year: yearLabel, commodity, attribute, unit: cell(r, 'Unit'), year_type: cell(r, 'Year_type'), topic: cell(r, 'Topic') }))
    }
    row[recordCountry] = amount
  }
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const source = byYear.get(year)!
      const row: Row = { year: source.year, commodity: source.commodity, attribute: source.attribute, unit: source.unit, year_type: source.year_type, topic: source.topic }
      for (const column of columns) row[column] = source[column] ?? null
      return nullTokensToNone(row)
    })
}
