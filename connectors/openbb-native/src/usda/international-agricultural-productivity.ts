// usda/international_agricultural_productivity, provider usda. Ported from openbb_government_us/usda/models/international_agricultural_productivity.py
// and utils/ers_international_agricultural_productivity.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { ENTITY_LABEL, GROUPINGS, MEASURES } from './international-agricultural-productivity-data.js'

const MEDIA_PATH = '/media/5403/machine-readable-and-long-format-file-of-tfp-indices-and-components-for-countries-regions-countries-grouped-by-income-level-and-the-world-1961-2023.csv'
const DEFAULT_GROUPING = 'country_grouping'
const DEFAULT_COUNTRY = 220
const DEFAULT_MEASURE = 'productivity_indices'

export async function internationalAgriculturalProductivity(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const grouping = optString(params, 'grouping') ?? DEFAULT_GROUPING
  if (!(grouping in GROUPINGS)) throw new Error(`Invalid grouping: ${grouping}. Valid groupings are: ${Object.keys(GROUPINGS).join(', ')}`)
  const measure = optString(params, 'measure') ?? DEFAULT_MEASURE
  const spec = MEASURES[measure]
  if (!spec) throw new Error(`Invalid measure: ${measure}. Valid measures are: ${Object.keys(MEASURES).join(', ')}`)
  const country = optString(params, 'country') === undefined ? DEFAULT_COUNTRY : Number(optString(params, 'country'))
  if (!Number.isInteger(country)) throw new Error(`Invalid country: ${String(params.country)}.`)
  if (!(String(country) in ENTITY_LABEL)) throw new Error(`Invalid country order: ${country}. It is not a published entity.`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // The long file holds every entity; only this country's rows of the selected measure's variables are kept.
  const headerByVariable = new Map(spec.columns)
  const target = String(country)
  const byYear = new Map<number, Map<string, number>>()
  const present = new Set<string>()
  for (const r of csvDictRows(await fetchErsText(ctx, MEDIA_PATH))) {
    if (cell(r, 'Order') !== target) continue
    const variable = cell(r, 'Variable')
    const header = headerByVariable.get(variable)
    if (header === undefined) continue
    const yearRaw = cell(r, 'Year')
    if (!/^\d{4}$/.test(yearRaw)) continue
    const value = pyFloat(cell(r, 'Value'))
    if (value === undefined) continue
    const year = Number(yearRaw)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    present.add(variable)
    let values = byYear.get(year)
    if (!values) byYear.set(year, (values = new Map()))
    values.set(header, value)
  }
  if (byYear.size === 0) throw new Error('No records match the given filters.')
  const headers = spec.columns.filter(([variable]) => present.has(variable)).map(([, header]) => header)
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const values = byYear.get(year)!
      const row: Row = { year }
      for (const header of headers) row[header] = values.get(header) ?? null
      return nullTokensToNone(row)
    })
}
