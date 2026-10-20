// usda/commodity_costs_and_returns, provider usda. Ported from openbb_government_us/usda/models/commodity_costs_and_returns.py
// and utils/ers_commodity_costs_and_returns.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { CATEGORY_CHOICES, CATEGORY_ORDER, COMMODITY_FILES, COMMODITY_REGIONS } from './commodity-costs-and-returns-data.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy } from './helpers.js'

/** Footnote superscripts are dropped and whitespace collapsed (`clean_item`). */
function cleanItem(item: string): string {
  return item.replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]/g, '').replace(/\s+/g, ' ').trim()
}

export async function commodityCostsAndReturns(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const commodity = optString(params, 'commodity') ?? 'corn'
  const file = COMMODITY_FILES[commodity]
  if (!file) throw new Error(`Invalid commodity: ${commodity}. Valid commodities are: ${Object.keys(COMMODITY_FILES).join(', ')}`)
  const categoryKey = optString(params, 'category')
  if (categoryKey !== undefined && !(categoryKey in CATEGORY_CHOICES)) throw new Error(`Invalid category: ${categoryKey}. Valid categories are: ${Object.keys(CATEGORY_CHOICES).join(', ')}`)
  const category = categoryKey === undefined ? undefined : CATEGORY_CHOICES[categoryKey]
  const region = optString(params, 'region')
  const regionOrder = COMMODITY_REGIONS[commodity] ?? []
  if (region !== undefined && !regionOrder.includes(region)) throw new Error(`Invalid region '${region}' for commodity '${commodity}'. Valid regions are: ${regionOrder.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = await fetchErsText(ctx, `/media/${file.media_id}/${file.slug}.csv`)
  type Wide = { regionIndex: number; categoryOrder: number; totalLast: number; maxYear: number; item: string; dims: Row; years: Map<number, number> }
  const pivoted = new Map<string, Wide>()
  for (const r of csvDictRows(text)) {
    const value = cell(r, 'Value')
    if (!value) continue
    const year = pyInt(cell(r, 'Year'))
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${cell(r, 'Year')}'`)
    const amount = pyFloat(value)
    if (amount === undefined) throw new Error(`could not convert string to float: '${value}'`)
    const rec = {
      commodity: cell(r, 'Commodity'),
      category: cell(r, 'Category'),
      item: cleanItem(r.Item ?? ''),
      units: cell(r, 'Units'),
      region: cell(r, 'Region'),
      surveyBaseYear: cell(r, 'Survey base year'),
    }
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    if (region !== undefined && rec.region !== region) continue
    if (category !== undefined && rec.category !== category) continue
    const key = JSON.stringify([rec.region, rec.category, rec.item, rec.units])
    let row = pivoted.get(key)
    if (!row) {
      const at = regionOrder.indexOf(rec.region)
      row = {
        regionIndex: at >= 0 ? at : regionOrder.length,
        categoryOrder: CATEGORY_ORDER[rec.category] ?? 99,
        totalLast: rec.item.startsWith('Total,') ? 1 : 0,
        maxYear: -1,
        item: rec.item,
        dims: { commodity: rec.commodity, region: rec.region, category: rec.category, item: rec.item, units: rec.units, survey_base_year: null },
        years: new Map(),
      }
      pivoted.set(key, row)
    }
    row.years.set(year, amount)
    if (year > row.maxYear) {
      row.maxYear = year
      row.dims.survey_base_year = rec.surveyBaseYear
    }
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  const allYears = [...new Set([...pivoted.values()].flatMap((w) => [...w.years.keys()]))].sort((a, b) => a - b)
  return sortedBy([...pivoted.values()], (w) => [w.regionIndex, w.categoryOrder, w.totalLast, w.item]).map((w) => {
    const row: Row = { ...w.dims }
    for (const year of allYears) row[String(year)] = w.years.get(year) ?? null
    return nullTokensToNone(row)
  })
}
