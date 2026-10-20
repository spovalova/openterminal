// usda/agricultural_and_food_rd_expenditures, provider usda. Ported from openbb_government_us/usda/models/agricultural_and_food_research_and_development_expenditures_in_the_united_states.py
// and the matching utils/ers_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'

const MEDIA_PATH = '/media/5692/agricultural-and-food-research-and-development-rd-expenditures-in-the-united-states-1970-2022.csv'
const MEASURES = ['nominal', 'real']
const DEFAULT_MEASURE = 'real'

/** Source Attribute label (without its trailing parenthetical) → series field. */
const SERIES: Record<string, string> = {
  'Public agricultural and food R&D': 'public_total',
  'Public agricultural and food R&D performed by USDA intramural agencies': 'public_usda_intramural',
  'Public agricultural & food R&D performed by State universities and cooperating institutions': 'public_state_universities',
  'Private agriculture input industries R&D': 'private_input_industries',
  'Private food industry R&D': 'private_food_industry',
  'R&D Price Index': 'rd_price_index',
}
const SERIES_ORDER = ['public_total', 'public_usda_intramural', 'public_state_universities', 'private_input_industries', 'private_food_industry', 'rd_price_index']

const PAREN = /\s*\([^)]*\)\s*$/

/** `parse_attribute`: the series field and its measure (null for the measure-agnostic price index). */
function parseAttribute(attribute: string): [string, string | null] | undefined {
  const text = attribute.trim()
  const descriptor = (PAREN.exec(text)?.[0] ?? '').toLowerCase()
  const field = SERIES[text.replace(PAREN, '').trim()]
  if (field === undefined) return undefined
  if (descriptor.includes('constant')) return [field, 'real']
  if (descriptor.includes('current')) return [field, 'nominal']
  return [field, null]
}

export async function agriculturalAndFoodRdExpenditures(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const measure = (optString(params, 'measure') ?? DEFAULT_MEASURE).toLowerCase()
  if (!MEASURES.includes(measure)) throw new Error(`Invalid measure: ${measure}. Valid measures are: ${MEASURES.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = await fetchErsText(ctx, MEDIA_PATH)
  const pivoted = new Map<number, Row>()
  for (const r of csvDictRows(text)) {
    const yearLabel = cell(r, 'Year')
    if (!/^\d{4}/.test(yearLabel)) continue
    const parsed = parseAttribute(r.Attribute ?? '')
    if (!parsed) continue
    const [series, recordMeasure] = parsed
    const raw = cell(r, 'Value')
    let value: number | null = null
    if (!isNullToken(raw)) {
      const n = pyFloat(raw)
      if (n === undefined) throw new Error(`could not convert string to float: '${raw}'`)
      value = n
    }
    if (recordMeasure !== null && recordMeasure !== measure) continue
    const year = Number(yearLabel.slice(0, 4))
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    let row = pivoted.get(year)
    if (!row) pivoted.set(year, (row = {}))
    row[series] = value
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  return [...pivoted.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const row = pivoted.get(year)!
      const ordered: Row = { year }
      for (const series of SERIES_ORDER) if (series in row) ordered[series] = row[series]
      return nullTokensToNone(ordered)
    })
}
