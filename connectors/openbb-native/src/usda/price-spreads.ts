// usda/price_spreads, provider usda. Ported from openbb_government_us/usda/models/price_spreads.py and
// utils/ers_price_spreads.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, pyFloat, pyInt, sortedBy } from './helpers.js'

const CATEGORIES = ['dairy', 'fresh_fruit', 'fresh_vegetables', 'processed', 'field_crops']

/** Item → [media id, file slug, category]. */
const PRICE_SPREADS_FILES: Record<string, [number, string, string]> = {
  milk_and_dairy_basket: [5716, 'milk-and-dairy-basket', 'dairy'],
  butter: [5718, 'butter-1-pound', 'dairy'],
  cheddar_cheese: [5720, 'cheddar-cheese-1-pound', 'dairy'],
  ice_cream: [5722, 'ice-cream-regular-one-half-gallon', 'dairy'],
  whole_milk: [5724, 'whole-milk-1-gallon', 'dairy'],
  fresh_fruit_basket: [5734, 'fresh-fruit-basket', 'fresh_fruit'],
  fresh_apples: [5736, 'fresh-apples', 'fresh_fruit'],
  fresh_grapefruit: [5738, 'fresh-grapefruit', 'fresh_fruit'],
  fresh_grapes: [5740, 'fresh-grapes', 'fresh_fruit'],
  fresh_oranges: [5742, 'fresh-oranges', 'fresh_fruit'],
  fresh_peaches: [5744, 'fresh-peaches', 'fresh_fruit'],
  fresh_strawberries: [5746, 'fresh-strawberries', 'fresh_fruit'],
  fresh_vegetables_basket: [5748, 'fresh-vegetables-basket', 'fresh_vegetables'],
  fresh_broccoli: [5750, 'fresh-broccoli', 'fresh_vegetables'],
  fresh_carrots: [5752, 'fresh-carrots', 'fresh_vegetables'],
  fresh_lettuce_iceberg: [5754, 'fresh-lettuce-iceberg', 'fresh_vegetables'],
  fresh_lettuce_romaine: [5756, 'fresh-lettuce-romaine', 'fresh_vegetables'],
  fresh_potatoes: [5758, 'fresh-potatoes', 'fresh_vegetables'],
  fresh_tomatoes: [5760, 'fresh-tomatoes', 'fresh_vegetables'],
  orange_juice_nfc: [5762, 'orange-juice-not-from-concentrate-one-gallon', 'processed'],
  flour: [5726, 'flour-white-all-purpose-per-pound', 'field_crops'],
  vegetable_oil: [5728, 'vegetable-soybean-oil-per-gallon', 'field_crops'],
  sugar: [5730, 'sugar-white-per-pound', 'field_crops'],
  white_pan_bread: [5732, 'white-pan-bread-per-pound', 'field_crops'],
}

/** The CSV `Attribute` (a measure and its unit in brackets) → the output field. */
const MEASURE_NAMES: Record<string, string> = {
  'Retail price': 'retail_price',
  'Farm price': 'farm_price',
  'Farm value': 'farm_value',
  'Farm share': 'farm_share',
  'Farm-value share': 'farm_share',
  'Retail cost': 'retail_cost_index',
  'Farm-to-retail spread': 'farm_to_retail_spread_index',
}

/** `parse_attribute`: the measure an attribute such as "Farm value (index, 1990-92 = 100)" names. */
function measureOf(attribute: string): string {
  const match = /^(.+?)\s*\(([^)]+)\)$/.exec(attribute.trim())
  if (!match) throw new Error(`Unrecognized attribute format: '${attribute}'`)
  const measureText = match[1]!.trim()
  const unit = match[2]!.trim()
  let measure = Object.prototype.hasOwnProperty.call(MEASURE_NAMES, measureText) ? MEASURE_NAMES[measureText] : undefined
  if (measure === undefined) throw new Error(`Unrecognized measure '${measureText}' in attribute '${attribute}'. Expected one of: ${Object.keys(MEASURE_NAMES).sort().join(', ')}`)
  if (measure === 'farm_value' && unit.includes('= 100')) measure = 'farm_value_index'
  return measure
}

export async function priceSpreads(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The item validator takes names comma-separated or as a list.
  const raw = params.item
  const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).map((i) => String(i).trim()).filter(Boolean)
  const unknown = names.filter((i) => !Object.prototype.hasOwnProperty.call(PRICE_SPREADS_FILES, i))
  if (unknown.length) throw new Error(`Invalid item(s): ${unknown.join(', ')}. Valid items are: ${Object.keys(PRICE_SPREADS_FILES).sort().join(', ')}`)
  const category = typeof params.category === 'string' && params.category !== '' ? params.category : undefined
  if (category !== undefined && !CATEGORIES.includes(category)) throw new Error(`Input should be 'dairy', 'fresh_fruit', 'fresh_vegetables', 'processed' or 'field_crops': ${category}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  let selected = names.length ? names : Object.keys(PRICE_SPREADS_FILES).sort()
  if (category !== undefined) selected = selected.filter((item) => PRICE_SPREADS_FILES[item]![2] === category)
  if (selected.length === 0) throw new Error("No items match the combination of 'item' and 'category' filters.")

  type Observation = { item: string; commodity: string; category: string; year: string; attribute: string; value: number }
  const perItem = await Promise.all(
    selected.map(async (item): Promise<Observation[]> => {
      const [mediaId, slug, itemCategory] = PRICE_SPREADS_FILES[item]!
      const rows: Observation[] = []
      for (const row of csvDictRows(await fetchErsText(ctx, `/media/${mediaId}/${slug}.csv`))) {
        const text = cell(row, 'Value')
        if (!text) continue
        const value = pyFloat(text)
        if (value === undefined) throw new Error(`could not convert string to float: '${text}'`)
        rows.push({ item, commodity: cell(row, 'Commodity'), category: itemCategory, year: cell(row, 'Year'), attribute: cell(row, 'Attribute'), value })
      }
      return rows
    }),
  )

  // transform_data: one row per item and year, a column per measure.
  type Wide = { item: string; commodity: string; category: string; year: number; marketingYear: string | null; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  for (const r of perItem.flat()) {
    const marketingYear = r.year.includes('/') ? r.year : null
    const year = marketingYear ? pyInt(r.year.slice(0, 4)) : pyInt(r.year)
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${marketingYear ? r.year.slice(0, 4) : r.year}'`)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    const measure = measureOf(r.attribute)
    const key = JSON.stringify([r.item, year, marketingYear])
    let row = pivoted.get(key)
    if (!row) {
      row = { item: r.item, commodity: r.commodity, category: r.category, year, marketingYear, values: new Map() }
      pivoted.set(key, row)
    }
    row.values.set(measure, r.value)
  }
  return sortedBy([...pivoted.values()], (w) => [w.item, w.year]).map((w) => {
    const out: Row = { commodity: w.commodity, category: w.category, year: w.year, marketing_year: w.marketingYear }
    for (const [measure, value] of w.values) out[measure] = value
    return nullTokensToNone(out)
  })
}
