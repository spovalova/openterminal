// usda/international_macroeconomic_data_set, provider usda. Ported from openbb_government_us/usda/models/international_macroeconomic_data_set.py
// and utils/ers_international_macroeconomic_data_set.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { INTERNATIONAL_MACRO_FILES } from './international-macroeconomic-data-set-files.js'

const DEFAULT_VARIABLE = 'real_gdp'
const DEFAULT_MEASURE = 'level'
const MEASURES = ['level', 'growth']
const GROWTH_MARKER = 'Percent Change'
const OBSERVATION_RELABEL: Record<string, string> = { 'US Ag. Trade Weighted Exchange Rate, 2017=100': 'US Ag. Trade Weighted' }

/** `repair_mojibake`: UTF-8 text that was read as latin-1, put back; unchanged when it does not round-trip. */
function repairMojibake(text: string): string {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0xff) return text
    bytes[i] = code
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return text
  }
}

type Observation = { observation: string; year: number; unit: string; value: number }

function parseRows(text: string, mojibake: boolean): Observation[] {
  const records: Observation[] = []
  for (const r of csvDictRows(text)) {
    let observation = cell(r, 'Observation')
    const yearToken = cell(r, 'Year')
    const unit = cell(r, 'Unit')
    const rawValue = cell(r, 'Value')
    if (!(observation || yearToken || unit || rawValue)) continue
    if (!/^\d+$/.test(yearToken)) continue
    if (isNullToken(rawValue)) continue
    const value = pyFloat(rawValue)
    if (value === undefined) continue
    if (mojibake) observation = repairMojibake(observation)
    observation = OBSERVATION_RELABEL[observation] ?? observation
    records.push({ observation, year: Number(yearToken), unit, value })
  }
  return records
}

export async function internationalMacroeconomicDataSet(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const variable = optString(params, 'variable') ?? DEFAULT_VARIABLE
  const config = INTERNATIONAL_MACRO_FILES[variable]
  if (!config) throw new Error(`Invalid variable: ${variable}. Valid variables are: ${Object.keys(INTERNATIONAL_MACRO_FILES).join(', ')}`)
  const measure = optString(params, 'measure') ?? DEFAULT_MEASURE
  if (!MEASURES.includes(measure)) throw new Error(`Invalid measure: ${measure}. Valid measures are: ${MEASURES.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const growth = measure === 'growth'
  const selected = parseRows(await fetchErsText(ctx, config.media), config.mojibake).filter((r) => r.unit.includes(GROWTH_MARKER) === growth)
  const columns = new Set(selected.map((r) => r.observation))
  const unit = selected[0]?.unit
  const byYear = new Map<number, Row>()
  for (const r of selected) {
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) continue
    let row = byYear.get(r.year)
    if (!row) byYear.set(r.year, (row = { year: r.year, unit: unit ?? null }))
    row[r.observation] = r.value
  }
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const source = byYear.get(year)!
      const row: Row = { year, unit: source.unit }
      for (const column of columns) row[column] = source[column] ?? null
      return nullTokensToNone(row)
    })
}
