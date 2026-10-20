// usda/rural_urban_commuting_area_codes, provider usda. Ported from openbb_government_us/usda/models/rural_urban_commuting_area_codes.py
// and utils/ers_rural_urban_commuting_area_codes.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic
// models; the 2010 workbook is read with src/lib/xlsx.ts and the 2000 and 1990 ones with src/usda/xls.ts.
import type { Cell } from '../lib/xlsx.js'
import { readXlsx } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsFile, fetchErsText, nullTokensToNone, pyFloat } from './helpers.js'
import { pyFloatRepr, sheetNamed, sortByText, STATE_NAMES, xlrdRows, xlrdStr, zfill } from './helpers-g.js'
import { readXls } from './xls.js'

const DEFAULT_TABLE = 'tract_2020'
const DEFAULT_STATE = 'DE'

type TableKind = 'csv' | 'xlsx' | 'xls'
const TABLE_CATALOG: Record<string, [string, TableKind]> = {
  tract_2020: ['/media/5443/2020-rural-urban-commuting-area-codes-census-tracts.csv', 'csv'],
  tract_2010: ['/media/5438/2010-rural-urban-commuting-area-codes-revised-732019.xlsx', 'xlsx'],
  tract_2000: ['/media/5437/2000-rural-urban-commuting-area-codes.xls', 'xls'],
  tract_1990: ['/media/5436/1990-rural-urban-commuting-area-codes.xls', 'xls'],
  zip_2020: ['/media/5444/2020-rural-urban-commuting-area-codes-zip-codes.csv', 'csv'],
  zip_2010: ['/media/5440/2010-rural-urban-commuting-area-codes-zip-code-file.csv', 'csv'],
}

const PRIMARY_DESCRIPTIONS: Record<string, string> = {
  '1': 'Metropolitan core',
  '2': 'Metropolitan high commuting',
  '3': 'Metropolitan low commuting',
  '4': 'Micropolitan core',
  '5': 'Micropolitan high commuting',
  '6': 'Micropolitan low commuting',
  '7': 'Small town core',
  '8': 'Small town high commuting',
  '9': 'Small town low commuting',
  '10': 'Rural area',
  '99': 'Not coded',
}

// The misspellings are the source's.
const SECONDARY_DESCRIPTIONS: Record<string, string> = {
  '1': 'Metropolitan core, no addtional code',
  '1.1': 'Metropolitan core, secondary flow to larger UA',
  '2': 'Metropolitan high commuting, no additional code',
  '2.1': 'Metropolitan high commuting, seconary flow to larger UA',
  '3': 'Metropolitan low commuting, no additional code',
  '4': 'Micropolitan core, no additional code',
  '4.1': 'Micropolitan core, secondary flow to metro UA',
  '5': 'Micropolitan high commuting, no additional code',
  '5.1': 'Micropolitan high commuting, seconary flow to metro UA',
  '6': 'Micropolitan low commuting, no additional code',
  '7': 'Small town core, no additional code',
  '7.1': 'Small town core, secondary flow to metro UA',
  '7.2': 'Small town core, secondary flow to micro UA',
  '8': 'Small town high commuting, no additional code',
  '8.1': 'Small town high commuting, seconary flow to metro UA',
  '8.2': 'Small town high commuting, secondary flow to micro UA',
  '9': 'Small town low commuting, no additional code',
  '10': 'Rural area, no additional code',
  '10.1': 'Rural area, seconary flow to metro UA',
  '10.2': 'Rural area, secondary flow to micro UA',
  '10.3': 'Rural area, secondary flow to small town UA',
  '99': 'Not coded',
}

const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
}

const TERRITORIES = ['AS', 'GU', 'MP', 'PR', 'VI']
const STATES_50_DC = Object.keys(STATE_NAMES).filter((c) => !TERRITORIES.includes(c)).sort()
const STATES_50_DC_PR = [...STATES_50_DC, 'PR'].sort()
const STATES_ALL = Object.keys(STATE_NAMES).sort()
const TABLE_STATES: Record<string, string[]> = {
  tract_2020: STATES_ALL,
  zip_2020: STATES_ALL,
  tract_2010: STATES_50_DC_PR,
  zip_2010: STATES_50_DC_PR,
  tract_2000: STATES_50_DC,
  tract_1990: STATES_50_DC,
}

/** A source value: CSV text, or what the workbook readers give (xlrd: floats and '' for empty cells; openpyxl: numbers and null). */
type Value = string | number | boolean | null | undefined

/** `normalize_code`: a RUCA code as text, a whole number without '.0'; text that is not a number is kept. */
function normalizeCode(value: Value): string | null {
  if (value === null || value === undefined) return null
  let n: number
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const f = pyFloat(text)
    if (f === undefined) return text
    n = f
  } else n = Number(value)
  return Number.isInteger(n) ? String(n) : pyFloatRepr(n)
}

const primaryDescription = (code: string | null): string | null => (code === null ? null : (PRIMARY_DESCRIPTIONS[code] ?? null))

/** The 2020 label when the exact code is published, otherwise the primary label of the code's integer part. */
function secondaryDescription(code: string | null): string | null {
  if (code === null) return null
  return SECONDARY_DESCRIPTIONS[code] ?? PRIMARY_DESCRIPTIONS[code.split('.')[0]!] ?? null
}

/** `_to_int`: `int(float(text))` for text, `int(value)` otherwise; null when blank or not a number. */
function toInt(value: Value): number | null {
  if (value === null || value === undefined) return null
  let n: number | undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    n = pyFloat(text)
  } else n = Number(value)
  return n === undefined || !Number.isFinite(n) ? null : Math.trunc(n)
}

/** `_to_float`. */
function toFloat(value: Value): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? (pyFloat(text) ?? null) : null
  }
  return Number(value)
}

/** `_fips_str`: a fixed-width identifier, zero-padded when it is all digits. */
function fipsStr(value: Value, width: number): string | null {
  if (value === null || value === undefined) return null
  let text: string
  if (typeof value === 'string') text = value.trim()
  else {
    const n = toInt(value)
    text = n === null ? '' : String(n)
  }
  if (!text) return null
  return /^\d+$/.test(text) ? zfill(text, width) : text
}

function mapped(area_fips: string | null, state: string | null, primary: string | null, secondary: string | null, extra: Row = {}): Row {
  return {
    area_fips,
    state,
    area_name: extra.area_name ?? null,
    county: extra.county ?? null,
    area_type: extra.area_type ?? null,
    primary_ruca: primary,
    primary_ruca_description: extra.primary_desc ? extra.primary_desc : primaryDescription(primary),
    secondary_ruca: secondary,
    secondary_ruca_description: extra.secondary_desc ? extra.secondary_desc : secondaryDescription(secondary),
    population: extra.population ?? null,
    land_area: extra.land_area ?? null,
    population_density: extra.population_density ?? null,
  }
}

const strip = (v: string | undefined): string | null => (v ?? '').trim() || null

function parseTract2020(text: string, state: string | null): Row[] {
  const out: Row[] = []
  for (const row of csvDictRows(text)) {
    const rowState = FIPS_TO_STATE[(row.StateFIPS20 ?? '').trim()] ?? null
    if (state !== null && rowState !== state) continue
    out.push(
      mapped(fipsStr(row.TractFIPS20, 11), rowState, normalizeCode(row.PrimaryRUCA), normalizeCode(row.SecondaryRUCA), {
        county: strip(row.CountyName20),
        area_name: strip(row.TractName20),
        population: toInt(row.Population),
        land_area: toFloat(row.LandArea),
        population_density: toFloat(row.PopDensity),
        primary_desc: strip(row.PrimaryRUCADescription),
        secondary_desc: strip(row.SecondaryRUCADescription),
      }),
    )
  }
  return out
}

function parseZip2020(text: string, state: string | null): Row[] {
  const out: Row[] = []
  for (const row of csvDictRows(text)) {
    const rowState = (row.State ?? '').trim().toUpperCase() || null
    if (state !== null && rowState !== state) continue
    out.push(mapped(fipsStr(row.ZIPCode, 5), rowState, normalizeCode(row.PrimaryRUCA), normalizeCode(row.SecondaryRUCA), { area_name: strip(row.POName), area_type: strip(row.ZIPCodeType) }))
  }
  return out
}

function parseZip2010(text: string, state: string | null): Row[] {
  const out: Row[] = []
  for (const row of csvDictRows(text)) {
    const rowState = (row.STATE ?? '').trim().toUpperCase() || null
    if (state !== null && rowState !== state) continue
    const rawZip = (row["''ZIP_CODE''"] ?? '').trim().replace(/^'+|'+$/g, '')
    out.push(mapped(fipsStr(rawZip, 5), rowState, normalizeCode(row.RUCA1), normalizeCode(row.RUCA2), { area_type: strip(row.ZIP_TYPE) }))
  }
  return out
}

/** `(str(v).strip().upper() or None) if v else None` */
function stateOfCell(v: Value): string | null {
  if (!v) return null
  return String(v).trim().toUpperCase() || null
}

function parseTract2010(content: Uint8Array, state: string | null): Row[] {
  const sheet = readXlsx(content).find((s) => s.name === 'Data')
  if (!sheet) throw new Error('Worksheet Data does not exist.')
  const out: Row[] = []
  for (const row of sheet.rows.slice(2)) {
    const r = (i: number): Cell => row?.[i] ?? null
    const rowState = stateOfCell(r(1))
    if (state !== null && rowState !== state) continue
    out.push(
      mapped(fipsStr(r(3), 11), rowState, normalizeCode(r(4)), normalizeCode(r(5)), {
        county: r(2) ? String(r(2)).trim() || null : null,
        population: toInt(r(6)),
        land_area: toFloat(r(7)),
        population_density: toFloat(r(8)),
      }),
    )
  }
  return out
}

/** The 'Data' sheet the way xlrd's `cell_value` gives it: numbers as floats and '' for an empty cell. */
const xlsDataRows = (content: Uint8Array): Value[][] => xlrdRows(sheetNamed(readXls(content), 'Data'))

function parseTract2000(content: Uint8Array, state: string | null): Row[] {
  const out: Row[] = []
  for (const row of xlsDataRows(content).slice(1)) {
    const rowState = row[1] ? xlrdStr(row[1]).trim().toUpperCase() || null : null
    if (state !== null && rowState !== state) continue
    out.push(
      mapped(fipsStr(row[3], 11), rowState, normalizeCode(row[4]), normalizeCode(row[5]), {
        county: row[2] ? xlrdStr(row[2]).trim() || null : null,
        population: toInt(row[6]),
      }),
    )
  }
  return out
}

/** The 1990 file carries one combined code: its integer part is the primary code, and the FIPS '010010201.00' becomes '01001020100'. */
function parseTract1990(content: Uint8Array, state: string | null): Row[] {
  const out: Row[] = []
  for (const row of xlsDataRows(content).slice(2)) {
    const areaFips = fipsStr(xlrdStr(row[0]).replace(/\./g, ''), 11)
    const rowState = areaFips ? (FIPS_TO_STATE[areaFips.slice(0, 2)] ?? null) : null
    if (state !== null && rowState !== state) continue
    const secondary = normalizeCode(row[1])
    const primary = secondary ? secondary.split('.')[0]! : null
    out.push(mapped(areaFips, rowState, primary, secondary, { population: toInt(row[2]), land_area: toFloat(row[3]) }))
  }
  return out
}

export async function ruralUrbanCommutingAreaCodes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const t = params.table
  const table = t === undefined || t === '' ? DEFAULT_TABLE : String(Array.isArray(t) ? t[0] : t).trim()
  if (!(table in TABLE_CATALOG)) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(TABLE_CATALOG).join(', ')}`)
  // An absent state is the default (DE); a blank one means every area.
  let state: string | null
  if (params.state === undefined) state = DEFAULT_STATE
  else if (params.state === '' || (Array.isArray(params.state) && params.state.length === 0)) state = null
  else state = String(Array.isArray(params.state) ? params.state[0] : params.state).trim().toUpperCase() || null
  if (state !== null && !TABLE_STATES[table]!.includes(state)) throw new Error(`Invalid state '${state}' for table '${table}'. Valid states are: ${TABLE_STATES[table]!.join(', ')}`)

  const [media, kind] = TABLE_CATALOG[table]!
  let data: Row[]
  if (kind === 'csv') {
    const text = await fetchErsText(ctx, media)
    data = (table === 'tract_2020' ? parseTract2020 : table === 'zip_2020' ? parseZip2020 : parseZip2010)(text, state)
  } else {
    const content = await fetchErsFile(ctx, media)
    data = (table === 'tract_2010' ? parseTract2010 : table === 'tract_2000' ? parseTract2000 : parseTract1990)(content, state)
  }
  if (data.length === 0) throw new Error('No records match the given filters.')
  return sortByText(data, (r) => (r.area_fips as string | null) ?? '').map(nullTokensToNone)
}
