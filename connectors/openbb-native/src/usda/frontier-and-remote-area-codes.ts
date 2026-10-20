// usda/frontier_and_remote_area_codes, provider usda. Ported from openbb_government_us/usda/models/frontier_and_remote_area_codes.py
// and utils/ers_frontier_and_remote_area_codes.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic
// models; the 2020 and 2010 workbooks are read with src/lib/xlsx.ts and the 2000 one with src/usda/xls.ts.
import type { Cell } from '../lib/xlsx.js'
import { readXlsx } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchErsFile, nullTokensToNone, pyFloat } from './helpers.js'
import { cellStr, sortByText } from './helpers-g.js'
import { readXls } from './xls.js'

const DEFAULT_YEAR = '2020'
const DEFAULT_STATE = 'MT'

const CANONICAL_COLUMNS = [
  'zip_code', 'state', 'po_name', 'far_level_1', 'far_level_2', 'far_level_3', 'far_level_4', 'grid_population', 'land_area_sq_mi', 'population_density',
  'far_level_1_population', 'far_level_2_population', 'far_level_3_population', 'far_level_4_population',
  'far_level_1_population_pct', 'far_level_2_population_pct', 'far_level_3_population_pct', 'far_level_4_population_pct',
]
const CANONICAL_COLUMNS_NO_NAME = CANONICAL_COLUMNS.filter((c) => c !== 'po_name')

type Vintage = { mediaId: number; slug: string; ext: 'xlsx' | 'xls'; sheet: string; dataStart: number; columns: string[] }
const FAR_ZIP_FILES: Record<string, Vintage> = {
  '2020': { mediaId: 7072, slug: '2020-far-codes-zip-codes', ext: 'xlsx', sheet: 'FAR2020 ZIP Code Data', dataStart: 2, columns: CANONICAL_COLUMNS },
  '2010': { mediaId: 5621, slug: '2010-far-codes-zip-codes', ext: 'xlsx', sheet: 'FAR ZIP Code Data', dataStart: 2, columns: CANONICAL_COLUMNS },
  '2000': { mediaId: 5618, slug: '2000-far-codes-zip-codes', ext: 'xls', sheet: 'FAR ZIP Code Data', dataStart: 1, columns: CANONICAL_COLUMNS_NO_NAME },
}

const STATES_51 = [
  'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND',
  'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
]

const STR_FIELDS = new Set(['zip_code', 'state', 'po_name'])
const INT_FIELDS = new Set(['far_level_1', 'far_level_2', 'far_level_3', 'far_level_4'])

type Value = Cell | undefined

/** `_to_str`: a stripped string, null when blank. */
function toStr(value: Value): string | null {
  if (value === null || value === undefined) return null
  return (typeof value === 'string' ? value : cellStr(value)).trim() || null
}

/** `float(value)` of a cell, or undefined where Python raises. */
function floatOf(value: Value): number | undefined {
  if (typeof value === 'string') return pyFloat(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return value === null || value === undefined ? undefined : value
}

/** `_to_int`: an integer flag, null when blank or not numeric. */
function toInt(value: Value): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null
  const n = floatOf(value)
  return n === undefined || !Number.isFinite(n) ? null : Math.trunc(n)
}

/** `_to_float`. */
function toFloat(value: Value): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null
  return floatOf(value) ?? null
}

/** `_map_row`: positional cells to the canonical columns. */
function mapRow(cells: Value[], columns: string[]): Row {
  const record: Row = {}
  columns.forEach((name, index) => {
    const value = index < cells.length ? cells[index] : null
    record[name] = STR_FIELDS.has(name) ? toStr(value) : INT_FIELDS.has(name) ? toInt(value) : toFloat(value)
  })
  return record
}

/** The data sheet's rows: openpyxl's values for .xlsx, xlrd's (floats, '' for empty) for .xls. */
function sheetRows(content: Uint8Array, config: Vintage): Value[][] {
  if (config.ext === 'xls') {
    const sheet = readXls(content).find((s) => s.name === config.sheet)
    if (!sheet) throw new Error(`No sheet named <'${config.sheet}'>`)
    return sheet.rows.map((row) => row.map((c) => (c === null ? '' : c)))
  }
  const sheet = readXlsx(content).find((s) => s.name === config.sheet)
  if (!sheet) throw new Error(`Worksheet ${config.sheet} does not exist.`)
  return sheet.rows.map((row) => [...(row ?? [])])
}

export async function frontierAndRemoteAreaCodes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const year = params.year === undefined || params.year === '' ? DEFAULT_YEAR : String(params.year).trim()
  if (!(year in FAR_ZIP_FILES)) throw new Error(`Invalid vintage: ${year}. Valid vintages are: ${Object.keys(FAR_ZIP_FILES).join(', ')}`)
  const state = params.state === undefined || params.state === '' ? DEFAULT_STATE : String(params.state).trim().toUpperCase()
  if (!STATES_51.includes(state)) throw new Error(`Invalid state: ${state}. Valid states are: ${STATES_51.join(', ')}`)

  const config = FAR_ZIP_FILES[year]!
  const content = await fetchErsFile(ctx, `/media/${config.mediaId}/${config.slug}.${config.ext}`)
  const records: Row[] = []
  for (const cells of sheetRows(content, config).slice(config.dataStart)) {
    if (cells.length === 0) continue
    const first = cells[0]
    if (first === null || first === undefined || (typeof first === 'string' ? first : cellStr(first)).trim() === '') continue
    records.push(mapRow(cells, config.columns))
  }
  const rows = records.filter((r) => r.state === state)
  return sortByText(rows, (r) => (r.zip_code as string | null) ?? '').map(nullTokensToNone)
}
