// usda/global_food_assessment, provider usda. Ported from openbb_government_us/usda/models/global_food_assessment.py
// and utils/ers_global_food_assessment.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'

const MEDIA_PATH = '/media/6171/grain-food-demand-other-demand-total-demand-production-and-implied-additional-supply-required-for-global-food-assessment-countries.csv'
const ELEMENTS = ['Food grain demand', 'Other grain demand', 'Grain production', 'Implied additional supply required', 'Total grain demand']
const REGIONS = ['Asia', 'Former Soviet Union', 'Latin America and the Caribbean', 'Middle East and North Africa', 'Sub-Saharan Africa', 'GFA countries']
const DEFAULT_ELEMENT = 'Total grain demand'
const VALUE_COLUMN = 'Millions of metric tons'
const UNIT = 'Millions of metric tons'

/** `parse_amount`: thousands separators dropped; blank or unparsable is missing. */
function parseAmount(raw: string): number | null {
  const text = raw.replace(/,/g, '').trim()
  if (!text) return null
  return pyFloat(text) ?? null
}

export async function globalFoodAssessment(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const element = optString(params, 'element') ?? DEFAULT_ELEMENT
  if (!ELEMENTS.includes(element)) throw new Error(`Invalid measure: ${element}. Valid measures are: ${ELEMENTS.join(', ')}`)
  const region = optString(params, 'region')
  if (region !== undefined && !REGIONS.includes(region)) throw new Error(`Invalid region: ${region}. Valid regions are: ${REGIONS.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = await fetchErsText(ctx, MEDIA_PATH)
  const columns = new Set<string>()
  const byYear = new Map<number, Row>()
  for (const r of csvDictRows(text)) {
    if (cell(r, 'Element') !== element) continue
    if (region !== undefined && cell(r, 'Region') !== region) continue
    const amount = parseAmount(r[VALUE_COLUMN] ?? '')
    if (amount === null) continue
    const yearLabel = cell(r, 'Year')
    if (!/^\d+$/.test(yearLabel)) continue
    const year = Number(yearLabel)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    const subregion = cell(r, 'Subregion')
    columns.add(subregion)
    let row = byYear.get(year)
    if (!row) byYear.set(year, (row = { year: yearLabel, element, unit: UNIT }))
    row[subregion] = amount
  }
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const source = byYear.get(year)!
      const row: Row = { year: source.year, element: source.element, unit: source.unit }
      for (const column of columns) row[column] = source[column] ?? null
      return nullTokensToNone(row)
    })
}
