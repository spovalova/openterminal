// usda/urban_influence_codes, provider usda. Ported from openbb_government_us/usda/models/urban_influence_codes.py and
// utils/ers_urban_influence_codes.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models;
// the legacy .xls vintages are read with src/usda/xls.ts instead of pandas and xlrd.
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsFile, fetchErsText, nullTokensToNone, pyInt, sortedBy } from './helpers.js'
import { cellStr, pdObj, sheetNamed, sheetRecords, STATE_NAMES, zfill } from './helpers-g.js'
import { readXls } from './xls.js'

const DEFAULT_VINTAGE = '2024'
const VINTAGES = ['2024', '2013', '2003', '1993']

const MEDIA_2024_CSV = '/media/6182/2024-urban-influence-codes.csv'
const MEDIA_2013_XLS = '/media/6183/2013-urban-influence-codes.xls'
const MEDIA_2003_1993_XLS = '/media/6184/2003-and-1993-urban-influence-codes-for-us-counties.xls'
const MEDIA_2003_PR_XLS = '/media/6185/2003-urban-influence-codes-for-puerto-rico.xls'
const SHEET_2013 = 'Urban Influence Codes 2013'
const SHEET_2003_1993 = 'Urban Influence Codes'
const SHEET_2003_PR = 'pr2003UrbInf'

/** Every state and territory code, alphabetical by code. */
const STATE_LABELS = Object.keys(STATE_NAMES).sort()
const ALL_TERRITORIES = ['AS', 'GU', 'MP', 'PR', 'VI']
const VINTAGE_TERRITORIES: Record<string, string[]> = { '2024': ['AS', 'GU', 'MP', 'PR', 'VI'], '2013': ['PR'], '2003': ['PR'], '1993': [] }

/** The state codes a vintage is published for: the fifty states and DC plus its territories. */
const allowedStates = (vintage: string): string[] => STATE_LABELS.filter((c) => !ALL_TERRITORIES.includes(c) || (VINTAGE_TERRITORIES[vintage] ?? []).includes(c))

type Value = Cell | undefined

/** `_fips5`: a zero-padded five-character FIPS. */
function fips5(value: Value): string {
  let text = (typeof value === 'string' ? value : cellStr(value)).trim()
  if (text.endsWith('.0')) text = text.slice(0, -2)
  return zfill(text, 5)
}

/** `_state`: the two-letter code stripped of whitespace. */
const stateOf = (value: Value): string => (typeof value === 'string' ? value : cellStr(value)).trim()

/** `_clean_text`: runs of whitespace collapsed, null when empty. */
function cleanText(value: Value): string | null {
  if (value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))) return null
  const text = (typeof value === 'string' ? value : cellStr(value)).split(/\s+/).filter(Boolean).join(' ')
  return text || null
}

/** `_text_int`: a CSV integer as an int, null when blank or not an integer. */
function textInt(value: string | undefined): number | null {
  const text = (value ?? '').trim()
  if (!text) return null
  return pyInt(text) ?? null
}

/** `_cell_number`: a spreadsheet cell as it is, null when blank. */
function cellNumber(value: Value): Cell {
  return value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : value
}

/** `_code`: an ordinal classification code as its bare string. */
function code(value: Value): string | null {
  if (value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))) return null
  if (typeof value === 'string') return value.trim() || null
  return cellStr(value)
}

type Record_ = { fips: string; state: string; county_name: string | null; urban_influence_code: string | null; description: string | null; population: Cell; population_density: Cell }

/** `parse_2024_csv`: the long 2024 CSV (one row per county and attribute) as one record per FIPS. */
function parse2024(text: string): Record_[] {
  const grouped = new Map<string, Record_>()
  for (const row of csvDictRows(text)) {
    const fips = fips5(row['FIPS-UIC'])
    let entry = grouped.get(fips)
    if (!entry) {
      entry = { fips, state: stateOf(row.State ?? 'None'), county_name: cleanText(row.County_Name), urban_influence_code: null, description: null, population: null, population_density: null }
      grouped.set(fips, entry)
    }
    const attribute = (row.Attribute ?? '').trim()
    const value = row.Value
    if (attribute === 'UIC_2024') entry.urban_influence_code = code(value)
    else if (attribute === 'Description') entry.description = cleanText(value)
    else if (attribute === 'Population_2020') entry.population = textInt(value)
  }
  return [...grouped.values()]
}

/** The sheet as `pandas.read_excel(sheet_name=..., header=0)` gives it. */
function frame(content: Uint8Array, sheet: string): Record<string, Cell>[] {
  return sheetRecords(sheetNamed(readXls(content), sheet), 0, false).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, pdObj(v)])))
}

/** `row[column]`: pandas raises KeyError for a column the sheet does not have. */
function col(row: Record<string, Cell>, name: string): Cell {
  if (!(name in row)) throw new Error(`'${name}'`)
  return row[name] ?? null
}

function parse2013(content: Uint8Array): Record_[] {
  return frame(content, SHEET_2013).map((row) => ({
    fips: fips5(col(row, 'FIPS')),
    state: stateOf(col(row, 'State')),
    county_name: cleanText(col(row, 'County_Name')),
    urban_influence_code: code(col(row, 'UIC_2013')),
    description: cleanText(col(row, 'Description')),
    population: cellNumber(col(row, 'Population_2010')),
    population_density: null,
  }))
}

/** The 2003 or 1993 columns of the combined U.S. counties workbook. */
function parseCombined(content: Uint8Array, year: '2003' | '1993'): Record_[] {
  return frame(content, SHEET_2003_1993).map((row) => ({
    fips: fips5(col(row, 'FIPS Code')),
    state: stateOf(col(row, 'State')),
    county_name: cleanText(col(row, 'County name')),
    urban_influence_code: code(col(row, `${year} Urban Influence Code`)),
    description: cleanText(col(row, `${year} Urban Influence Code description`)),
    population: cellNumber(col(row, '2000 Population')),
    population_density: cellNumber(col(row, '2000 Persons per square mile')),
  }))
}

function parse2003PuertoRico(content: Uint8Array): Record_[] {
  return frame(content, SHEET_2003_PR).map((row) => ({
    fips: fips5(col(row, 'FIPS Code')),
    state: stateOf(col(row, 'State')),
    county_name: cleanText(col(row, 'Municipio Name')),
    urban_influence_code: code(col(row, 'Urban Influence  Code, 2003')),
    description: cleanText(col(row, 'Description of the 2003 Code')),
    population: cellNumber(col(row, 'Population 2003 ')),
    population_density: null,
  }))
}

export async function urbanInfluenceCodes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const v = params.vintage
  const vintage = v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ? DEFAULT_VINTAGE : String(Array.isArray(v) ? v[0] : v).trim()
  if (!VINTAGES.includes(vintage)) throw new Error(`Invalid vintage: ${vintage}. Valid vintages are: ${VINTAGES.join(', ')}`)
  let state: string | undefined
  if (params.state !== undefined && params.state !== '' && !(Array.isArray(params.state) && params.state.length === 0)) {
    state = String(Array.isArray(params.state) ? params.state[0] : params.state).trim().toUpperCase() || undefined
    if (state !== undefined) {
      if (!STATE_LABELS.includes(state)) throw new Error(`Invalid state: ${state}. Valid states are: ${STATE_LABELS.join(', ')}`)
      if (!allowedStates(vintage).includes(state)) throw new Error(`Invalid state '${state}' for vintage '${vintage}'. This vintage is published for: ${allowedStates(vintage).join(', ')}`)
    }
  }

  let data: Record_[]
  if (vintage === '2024') data = parse2024(await fetchErsText(ctx, MEDIA_2024_CSV))
  else if (vintage === '2013') data = parse2013(await fetchErsFile(ctx, MEDIA_2013_XLS))
  else if (vintage === '2003') {
    const us = await fetchErsFile(ctx, MEDIA_2003_1993_XLS)
    const pr = await fetchErsFile(ctx, MEDIA_2003_PR_XLS)
    data = [...parseCombined(us, '2003'), ...parse2003PuertoRico(pr)]
  } else data = parseCombined(await fetchErsFile(ctx, MEDIA_2003_1993_XLS), '1993')

  const rows = state === undefined ? data : data.filter((r) => r.state === state)
  if (rows.length === 0) throw new Error('No records match the given filters.')
  return sortedBy(rows, (r) => [r.fips]).map((r) => nullTokensToNone({ ...r }))
}
