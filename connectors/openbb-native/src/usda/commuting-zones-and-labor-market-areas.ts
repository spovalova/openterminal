// usda/commuting_zones_and_labor_market_areas, provider usda. Ported from openbb_government_us/usda/models/commuting_zones_and_labor_market_areas.py
// and utils/ers_commuting_zones_and_labor_market_areas.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models; the 2000 and 1980/1990 workbooks are read with src/usda/xls.ts instead of pandas and xlrd.
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, decodeText, fetchErsFile, nullTokensToNone, pyFloat, readZip, sortedBy } from './helpers.js'
import { cellStr, pdObj, sheetNamed, sheetRecords, zfill } from './helpers-g.js'
import { readXls } from './xls.js'

const DEFAULT_VINTAGE = '2020'

type Vintage = { media: string; format: 'csv' | 'zip_csv' | 'xls'; sheet?: string; memberPrefix?: string }
const VINTAGE_FILES: Record<string, Vintage> = {
  '2020': { media: '/media/6968/2020-commuting-zones.csv', format: 'csv' },
  preliminary_2020: { media: '/media/6969/preliminary-2020-commuting-zones.zip', format: 'zip_csv', memberPrefix: 'preliminary-2020-commuting-zones' },
  '2000': { media: '/media/5688/2000-commuting-zones.xls', format: 'xls', sheet: 'CZ00Equiv' },
  '1980_1990': { media: '/media/5687/1980-and-1990-commuting-zones-and-labor-market-areas.xls', format: 'xls', sheet: 'CZLMA903' },
}

const STATE_FIPS: Record<string, string> = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia',
  '12': 'Florida', '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana',
  '23': 'Maine', '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota', '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska',
  '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma',
  '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont',
  '51': 'Virginia', '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming', '72': 'Puerto Rico',
}
const STATE_NAMES = [...new Set(Object.values(STATE_FIPS))].sort()

const RECORD_KEYS = [
  'fips', 'state', 'county_name', 'commuting_zone', 'commuting_zone_name', 'cz_containment', 'cz_avg_containment', 'cz_1990', 'cz_1980', 'metro_area', 'county_population',
  'commuting_zone_population', 'distance', 'beale_code', 'msa_code', 'msa_name', 'place_code',
]

/** A source value: CSV text, or a cell as pandas gives it (NaN is null). */
type Value = Cell | undefined

const stateName = (fips: string): string | null => STATE_FIPS[fips.slice(0, 2)] ?? null

const isMissing = (v: Value): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) || (typeof v === 'string' && !v.trim())

/** `_text`: a stripped string, or null for a blank cell. */
function text(v: Value): string | null {
  if (isMissing(v)) return null
  return (typeof v === 'string' ? v : cellStr(v)).trim() || null
}

/** `_code`: an integer-like cell as a decimal-free string. */
function code(v: Value): string | null {
  if (isMissing(v)) return null
  if (typeof v === 'string') {
    const t = v.trim()
    return t.endsWith('.0') ? t.slice(0, -2) : t
  }
  if (typeof v === 'number') return String(Math.trunc(v))
  return cellStr(v)
}

/** `_padded`. */
function padded(v: Value, width: number): string | null {
  const c = code(v)
  return c === null ? null : zfill(c, width)
}

/** `_msa_code`: a four-digit MSA code, an all-zero code being no MSA. */
function msaCode(v: Value): string | null {
  const c = padded(v, 4)
  return c === null || /^0+$/.test(c) ? null : c
}

/** `_beale`: a Beale code, '.' being none. */
function beale(v: Value): string | null {
  if (isMissing(v)) return null
  let t = (typeof v === 'string' ? v : cellStr(v)).trim()
  if (t.endsWith('.0')) t = t.slice(0, -2)
  return t === '.' ? null : t || null
}

/** `_num`: a float, or null for a blank or non-numeric cell. */
function num(v: Value): number | null {
  if (isMissing(v)) return null
  if (typeof v === 'string') return pyFloat(v.trim()) ?? null
  return Number(v)
}

/** `_int`. */
function int(v: Value): number | null {
  const n = num(v)
  return n === null ? null : Math.trunc(n)
}

const blank = (values: Row): Row => ({ ...Object.fromEntries(RECORD_KEYS.map((k) => [k, null])), ...values })

function parse2020(csvText: string): Row[] {
  const out: Row[] = []
  for (const row of csvDictRows(csvText)) {
    const fips = (row.FIPStxt ?? '').trim()
    if (!fips) continue
    out.push(blank({ fips, state: stateName(fips) ?? text(row.StateName), county_name: text(row.CountyName), commuting_zone: code(row.CZ2020), commuting_zone_name: text(row.CZName), cz_containment: num(row.CZContainment), cz_avg_containment: num(row.CZAvgContainment) }))
  }
  return out
}

function parsePreliminary2020(csvText: string): Row[] {
  const out: Row[] = []
  for (const row of csvDictRows(csvText)) {
    const fips = (row.FIPStxt ?? '').trim()
    if (!fips) continue
    out.push(blank({ fips, state: stateName(fips), county_name: text(row.CountyName), commuting_zone: code(row.PreliminaryCZ2020) }))
  }
  return out
}

/** The sheet as `pandas.read_excel(sheet_name=...)` gives it: header row 0, NaN for empty cells and default NA strings. */
function frame(content: Uint8Array, sheet: string): Record<string, Cell>[] {
  return sheetRecords(sheetNamed(readXls(content), sheet), 0, false).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, pdObj(v)])))
}

function parse2000(content: Uint8Array): Row[] {
  const out: Row[] = []
  for (const rec of frame(content, 'CZ00Equiv')) {
    const fips = padded(rec.FIPS, 5)
    if (fips === null) continue
    out.push(
      blank({
        fips,
        state: stateName(fips),
        county_name: text(rec['County name']),
        commuting_zone: code(rec['Commuting Zone ID, 2000']),
        cz_1990: code(rec['Commuting Zone ID, 1990']),
        cz_1980: code(rec['Commuting Zone ID, 1980']),
        metro_area: text(rec['Metropolitan area, 2003']),
        county_population: int(rec['County population 2000']),
        commuting_zone_population: int(rec['Commuting zone population 2000']),
      }),
    )
  }
  return out
}

function parse1980and1990(content: Uint8Array): Row[] {
  const out: Row[] = []
  for (const rec of frame(content, 'CZLMA903')) {
    const fips = padded(rec['County FIPS Code'], 5)
    if (fips === null) continue
    out.push(
      blank({
        fips,
        state: stateName(fips),
        county_name: text(rec['County name']),
        commuting_zone: code(rec.CZ90),
        cz_1980: code(rec.CZ80),
        commuting_zone_name: text(rec['Name of largest place in commuting zone']),
        county_population: int(rec['Population 1990']),
        distance: num(rec.Distance),
        beale_code: beale(rec['Rural-urban Continuum Code 1993 (Beale Code)']),
        msa_code: msaCode(rec['MSA 1993']),
        msa_name: text(rec['MSA name']),
        place_code: padded(rec['State place code'], 7),
      }),
    )
  }
  return out
}

/** `extract_inner_csv`: the first '.csv' member of the archive whose file name starts with the prefix. */
function innerCsv(zip: Uint8Array, prefix: string): string {
  const files = readZip(zip)
  const name = Object.keys(files).find((m) => m.split('/').pop()!.startsWith(prefix) && m.toLowerCase().endsWith('.csv'))
  if (name === undefined) throw new Error('StopIteration')
  return decodeText(files[name]!)
}

export async function commutingZonesAndLaborMarketAreas(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const v = params.vintage
  const vintage = v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ? DEFAULT_VINTAGE : String(Array.isArray(v) ? v[0] : v).trim()
  if (!(vintage in VINTAGE_FILES)) throw new Error(`Invalid vintage: ${vintage}. Valid vintages are: ${Object.keys(VINTAGE_FILES).join(', ')}`)
  let state: string | undefined
  if (params.state !== undefined && params.state !== '' && !(Array.isArray(params.state) && params.state.length === 0)) {
    const given = String(Array.isArray(params.state) ? params.state[0] : params.state).trim()
    state = STATE_NAMES.find((n) => n.toLowerCase() === given.toLowerCase())
    if (state === undefined) throw new Error(`Invalid state: ${given}. Valid states are: ${STATE_NAMES.join(', ')}`)
  }

  const config = VINTAGE_FILES[vintage]!
  const content = await fetchErsFile(ctx, config.media)
  let records: Row[]
  if (vintage === '2020') records = parse2020(decodeText(content))
  else if (vintage === 'preliminary_2020') records = parsePreliminary2020(innerCsv(content, config.memberPrefix!))
  else if (vintage === '2000') records = parse2000(content)
  else records = parse1980and1990(content)

  const rows = records.filter((r) => state === undefined || ((r.state as string | null) ?? '').toLowerCase() === state.toLowerCase())
  if (rows.length === 0) throw new Error('No records match the given filters.')
  return sortedBy(rows, (r) => [r.fips as string]).map(nullTokensToNone)
}
