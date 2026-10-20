// usda/natural_amenities_scale, provider usda. Ported from openbb_government_us/usda/models/natural_amenities_scale.py and
// utils/ers_natural_amenities_scale.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models;
// the legacy .xls workbook is read with src/usda/xls.ts instead of xlrd.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchErsFile, nullTokensToNone, pyFloat, sortedBy } from './helpers.js'
import { sheetNamed, xlrdRows, xlrdStr } from './helpers-g.js'
import { readXls } from './xls.js'

const MEDIA_PATH = '/media/6172/natural-amenities-scale-including-the-6-components-for-us-counties.xls'
const SHEET = 'NATAMENF'
/** Zero-indexed row where county data begins, after the legend, notes and header band. */
const DATA_START = 105

type Kind = 'text' | 'code' | 'num'
const COLUMN_SPECS: [string, Kind][] = [
  ['fips', 'text'], ['fips_used_for_measures', 'text'], ['state', 'text'], ['county_name', 'text'], ['census_division', 'code'], ['rural_urban_continuum_code', 'code'],
  ['urban_influence_code', 'code'], ['mean_january_temperature', 'num'], ['mean_january_sunlight', 'num'], ['mean_july_temperature', 'num'], ['mean_july_humidity', 'num'],
  ['topography_code', 'code'], ['percent_water_area', 'num'], ['log_water_area', 'num'], ['january_temperature_z', 'num'], ['january_sunlight_z', 'num'], ['july_temperature_z', 'num'],
  ['july_humidity_z', 'num'], ['topography_z', 'num'], ['log_water_area_z', 'num'], ['natural_amenity_scale', 'num'], ['natural_amenity_rank', 'code'],
]

/** The fifty states less Alaska and Hawaii, and DC: the workbook covers the lower 48. */
const STATES = ['AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']

type Value = string | number | boolean | undefined

/** `_to_text`: a stripped string, null when blank. */
const toText = (value: Value): string | null => (value === undefined ? null : xlrdStr(value).trim() || null)

/** `_to_code`: an integer-valued cell as a code string; non-numeric text is kept stripped. */
function toCode(value: Value): string | null {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return null
  const f = typeof value === 'string' ? pyFloat(value) : Number(value)
  if (f !== undefined && Number.isFinite(f)) return String(Math.trunc(f))
  return xlrdStr(value).trim() || null
}

/** `_to_num`: a float, null when blank or not numeric. */
function toNum(value: Value): number | null {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return null
  const f = typeof value === 'string' ? pyFloat(value) : Number(value)
  return f ?? null
}

export async function naturalAmenitiesScale(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  let state: string | undefined
  if (params.state !== undefined && params.state !== '' && !(Array.isArray(params.state) && params.state.length === 0)) {
    const value = Array.isArray(params.state) ? params.state[0] : params.state
    state = String(value).trim().toUpperCase() || undefined
    if (state !== undefined && !STATES.includes(state)) throw new Error(`Invalid state: ${String(value)}. Use a two-letter postal abbreviation, e.g. 'TX'.`)
  }

  const rows = xlrdRows(sheetNamed(readXls(await fetchErsFile(ctx, MEDIA_PATH)), SHEET))
  const records: Row[] = []
  for (const cells of rows.slice(DATA_START)) {
    if (cells.length === 0) continue
    if (xlrdStr(cells[0]).trim() === '') continue
    const record: Row = {}
    COLUMN_SPECS.forEach(([name, kind], index) => {
      const cell = index < cells.length ? cells[index] : undefined
      record[name] = kind === 'text' ? toText(cell) : kind === 'code' ? toCode(cell) : toNum(cell)
    })
    records.push(record)
  }
  const selected = records.filter((r) => state === undefined || r.state === state)
  if (selected.length === 0) throw new Error('No records match the given filters.')
  return sortedBy(selected, (r) => [r.fips as string]).map(nullTokensToNone)
}
