// usda/agricultural_trade_multipliers, provider usda. Ported from openbb_government_us/usda/models/agricultural_trade_multipliers.py
// and utils/ers_agricultural_trade_multipliers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models, one function for the long parse and the wide pivot.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, pyFloat, pyInt } from './helpers.js'

const MEDIA = '/media/6492/agricultural-trade-multipliers.csv'
const AGGREGATE_COMMODITY = 'All agricultural exports'

/** CSV `Variable` → OpenBB field. */
const VARIABLE_FIELDS: Record<string, string> = {
  'Producer Output Multiplier': 'producer_output_multiplier',
  'Producer Employment Multiplier': 'producer_employment_multiplier',
  'Port Output Multiplier': 'port_output_multiplier',
  'Port Employment Multiplier': 'port_employment_multiplier',
  'Export Value': 'export_value',
}

/** A value cell as a float: thousands separators are dropped, null tokens are missing. */
function parseValue(raw: string): number | null {
  if (raw === '' || isNullToken(raw)) return null
  const n = pyFloat(raw.replace(/,/g, ''))
  if (n === undefined) throw new Error(`could not convert string to float: '${raw}'`)
  return n
}

export async function agriculturalTradeMultipliers(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const text = await fetchErsText(ctx, MEDIA)

  // One wide row per (commodity id, commodity, year), in order of first appearance.
  const wide = new Map<string, Row>()
  for (const r of csvDictRows(text)) {
    const field = VARIABLE_FIELDS[cell(r, 'Variable')]
    if (field === undefined) continue
    const name = cell(r, 'CommodityName')
    const aggregate = isNullToken(name)
    const idText = cell(r, 'COMMID')
    const commodityId = aggregate || idText === '' || isNullToken(idText) ? null : pyInt(idText)
    if (commodityId === undefined) throw new Error(`invalid literal for int() with base 10: '${idText}'`)
    const commodity = aggregate ? AGGREGATE_COMMODITY : name
    const year = pyInt(cell(r, 'Year'))
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${cell(r, 'Year')}'`)
    const key = JSON.stringify([commodityId, commodity, year])
    let row = wide.get(key)
    if (!row) {
      row = { commodity_id: commodityId, commodity, year }
      wide.set(key, row)
    }
    row[field] = parseValue(cell(r, 'Value'))
  }
  return [...wide.values()]
}
