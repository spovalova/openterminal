// usda/county_typology_codes, provider usda. Ported from openbb_government_us/usda/models/county_typology_codes.py and
// utils/ers_county_typology_codes.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models;
// the legacy .xls editions are read with src/lib/xls.ts instead of pandas and xlrd.
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, decodeText, fetchErsFile, nullTokensToNone, sortedBy } from './helpers.js'
import { intOfFloatText, pdObj, sheetNamed, sheetRecords, STATE_FIPS_ABBR, STATE_NAMES, textOf, zfill } from './helpers-g.js'
import { readXls } from '../lib/xls.js'

const DEFAULT_VINTAGE = '2025'
const STATE_ABBRS = Object.keys(STATE_NAMES).filter((s) => !['PR', 'AS', 'GU', 'MP', 'VI'].includes(s))

type Vintage = { media: string; format: 'long_2025' | 'wide_2015' | 'wide_2004' | 'wide_1989' | 'wide_1979'; sheet?: string; ruccCol?: string }
const VINTAGES: Record<string, Vintage> = {
  '2025': { media: '/media/6174/ers-county-typology-codes-2025-edition.csv', format: 'long_2025' },
  '2015': { media: '/media/6176/ers-county-typology-codes-2015-edition.csv', format: 'wide_2015' },
  '2004': { media: '/media/6177/2004-county-typology-codes.xls', format: 'wide_2004', sheet: 'all_final_codes' },
  '1989': { media: '/media/6178/1989-county-typology-codes.xls', format: 'wide_1989', sheet: 'Data' },
  '1979_1986_1983def': { media: '/media/6179/1979-and-1986-county-typology-codes-uses-the-1983-nonmetro-definition.xls', format: 'wide_1979', sheet: 'Data', ruccCol: 'RURALURB83' },
  '1979_1986_1974def': { media: '/media/6180/1979-and-1986-county-typology-codes-uses-the-1974-nonmetro-definition.xls', format: 'wide_1979', sheet: 'Data', ruccCol: 'RURALURB74' },
}

const ECON_2025: Record<number, string> = { 0: 'Nonspecialized', 1: 'Farming', 2: 'Mining', 3: 'Manufacturing', 4: 'Government', 5: 'Recreation' }
const ECON_2015: Record<number, string> = { 0: 'Nonspecialized', 1: 'Farming', 2: 'Mining', 3: 'Manufacturing', 4: 'Federal/State Government', 5: 'Recreation' }
const ECON_2004: Record<number, string> = { 1: 'Farming', 2: 'Mining', 3: 'Manufacturing', 4: 'Federal/State Government', 5: 'Services', 6: 'Nonspecialized' }
const ECON_FLAGS_1989: [string, string][] = [['FM', 'Farming'], ['MI', 'Mining'], ['MF', 'Manufacturing'], ['GV', 'Government'], ['TS', 'Services'], ['NS', 'Nonspecialized']]
const ECON_FLAGS_1979: [string, string][] = [['AGTP79R', 'Farming'], ['MINTP79R', 'Mining'], ['MFGTP79R', 'Manufacturing'], ['GVTTP79R', 'Government'], ['UNCL79', 'Nonspecialized']]

type Source = string | Cell | undefined

/** `cell_int`: an integer code keeping sentinels such as 8, 9, 99 and -1; null for blanks and placeholder tokens. */
function cellInt(value: Source): number | null {
  const text = textOf(value as Cell)
  if (text === null || ['na', 'n/a', '--', '-'].includes(text.toLowerCase())) return null
  return intOfFloatText(text)
}

/** `normalize_fips`: a five-digit zero-padded county FIPS. */
function normalizeFips(value: Source): string | null {
  const text = textOf(value as Cell)
  if (text === null) return null
  const n = intOfFloatText(text)
  return zfill(n === null ? text : String(n), 5)
}

const stateOf = (fips: string): string | null => STATE_FIPS_ABBR[fips.slice(0, 2)] ?? null

const FIELDS = [
  'fips', 'state', 'county_name', 'metro', 'economic_type', 'economic_type_code', 'economic_type_label', 'farming', 'mining', 'manufacturing', 'government', 'recreation',
  'services', 'nonspecialized', 'low_education', 'low_employment', 'population_loss', 'housing_stress', 'retirement_destination', 'persistent_poverty', 'persistent_child_poverty',
  'federal_lands', 'commuting', 'transfers_dependent', 'rural_urban_continuum_code', 'urban_influence_code', 'farming_1986', 'mining_1986', 'manufacturing_1986', 'government_1986', 'nonspecialized_1986',
]
/** `_blank_record` with the given fields set. */
const record = (values: Row): Row => ({ ...Object.fromEntries(FIELDS.map((f) => [f, null])), ...values })

/** A flag-based vintage's economic type: the labels of the flags set to 1, joined. */
function flagEconomicType(row: Record<string, Cell>, flags: [string, string][]): string | null {
  const labels = flags.filter(([column]) => cellInt(row[column]) === 1).map(([, label]) => label)
  return labels.length ? labels.join(' / ') : null
}

type Csv = Record<string, string | undefined>

function parse2025(text: string): Row[] {
  const byFips = new Map<string, { countyName: string | null; metro: number | null; attrs: Record<string, string | undefined> }>()
  for (const row of csvDictRows(text)) {
    const fips = normalizeFips(row.FIPStxt)
    if (fips === null) continue
    let entry = byFips.get(fips)
    if (!entry) {
      entry = { countyName: textOf(row.County_Name ?? null), metro: cellInt(row.Metro2023), attrs: {} }
      byFips.set(fips, entry)
    }
    entry.attrs[(row.Attribute ?? '').trim()] = row.Value
  }
  return [...byFips].map(([fips, { countyName, metro, attrs }]) => {
    const code = cellInt(attrs.Industry_Dependence_2025)
    return record({
      fips,
      state: stateOf(fips),
      county_name: countyName,
      metro,
      economic_type: code !== null ? (ECON_2025[code] ?? null) : null,
      economic_type_code: code,
      farming: cellInt(attrs.High_Farming_2025),
      mining: cellInt(attrs.High_Mining_2025),
      manufacturing: cellInt(attrs.High_Manufacturing_2025),
      government: cellInt(attrs.High_Government_2025),
      recreation: cellInt(attrs.High_Recreation_2025),
      nonspecialized: cellInt(attrs.Nonspecialized_2025),
      low_education: cellInt(attrs.Low_PostSecondary_Ed_2025),
      low_employment: cellInt(attrs.Low_Employment_2025),
      population_loss: cellInt(attrs.Population_Loss_2025),
      housing_stress: cellInt(attrs.Housing_Stress_2025),
      retirement_destination: cellInt(attrs.Retirement_Destination_2025),
      persistent_poverty: cellInt(attrs.Persistent_Poverty_1721),
    })
  })
}

function parse2015(text: string): Row[] {
  const out: Row[] = []
  for (const row of csvDictRows(text) as Csv[]) {
    const fips = normalizeFips(row.FIPStxt)
    if (fips === null) continue
    const code = cellInt(row['Economic Types Type_2015_Update non-overlapping'])
    out.push(
      record({
        fips,
        state: stateOf(fips),
        county_name: textOf(row.County_name ?? null),
        metro: cellInt(row['Metro-nonmetro status, 2013 0=Nonmetro 1=Metro']),
        economic_type: code !== null ? (ECON_2015[code] ?? null) : null,
        economic_type_code: code,
        economic_type_label: textOf(row.Economic_Type_Label ?? null),
        farming: cellInt(row.Farming_2015_Update),
        mining: cellInt(row['Mining_2015-Update']),
        manufacturing: cellInt(row.Manufacturing_2015_Update),
        government: cellInt(row.Government_2015_Update),
        recreation: cellInt(row.Recreation_2015_Update),
        nonspecialized: cellInt(row.Nonspecialized_2015_Update),
        low_education: cellInt(row.Low_Education_2015_Update),
        low_employment: cellInt(row.Low_Employment_Cnty_2008_2012_25_64),
        population_loss: cellInt(row.Pop_Loss_2010),
        retirement_destination: cellInt(row.Retirement_Dest_2015_Update),
        persistent_poverty: cellInt(row.Persistent_Poverty_2013),
        persistent_child_poverty: cellInt(row.Persistent_Related_Child_Poverty_2013),
      }),
    )
  }
  return out
}

function parse2004(rows: Record<string, Cell>[]): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const fips = normalizeFips(row.FIPSTXT)
    if (fips === null) continue
    const code = cellInt(row.econdep)
    out.push(
      record({
        fips,
        state: stateOf(fips),
        county_name: textOf(row.County),
        metro: cellInt(row.metro),
        economic_type: code !== null ? (ECON_2004[code] ?? null) : null,
        economic_type_code: code,
        farming: cellInt(row.farm),
        mining: cellInt(row.mine),
        manufacturing: cellInt(row.manf),
        government: cellInt(row.fsgov),
        services: cellInt(row.serv),
        nonspecialized: cellInt(row.nonsp),
        recreation: cellInt(row.rec),
        low_education: cellInt(row.loweduc),
        low_employment: cellInt(row.lowemp),
        population_loss: cellInt(row.poploss),
        housing_stress: cellInt(row.house),
        retirement_destination: cellInt(row.retire),
        persistent_poverty: cellInt(row.perpov),
        persistent_child_poverty: cellInt(row.perchldpov),
        rural_urban_continuum_code: cellInt(row.rururb2003),
        urban_influence_code: cellInt(row.urbinf2003),
      }),
    )
  }
  return out
}

function parse1989(rows: Record<string, Cell>[]): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const fips = normalizeFips(row.FIPS)
    if (fips === null) continue
    const rucc = cellInt(row.RuralUrb93)
    out.push(
      record({
        fips,
        state: stateOf(fips),
        county_name: textOf(row['County name']),
        metro: rucc === null ? null : rucc <= 3 ? 1 : 0,
        economic_type: flagEconomicType(row, ECON_FLAGS_1989),
        farming: cellInt(row.FM),
        mining: cellInt(row.MI),
        manufacturing: cellInt(row.MF),
        government: cellInt(row.GV),
        services: cellInt(row.TS),
        nonspecialized: cellInt(row.NS),
        retirement_destination: cellInt(row.RT),
        federal_lands: cellInt(row.FL),
        commuting: cellInt(row.CM),
        persistent_poverty: cellInt(row.PV),
        transfers_dependent: cellInt(row.TP),
        rural_urban_continuum_code: rucc,
      }),
    )
  }
  return out
}

function parse1979(rows: Record<string, Cell>[], ruccCol: string): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const fips = normalizeFips(row.FIPS)
    if (fips === null) continue
    out.push(
      record({
        fips,
        state: stateOf(fips),
        county_name: textOf(row.County),
        metro: cellInt(row.NMET),
        economic_type: flagEconomicType(row, ECON_FLAGS_1979),
        farming: cellInt(row.AGTP79R),
        mining: cellInt(row.MINTP79R),
        manufacturing: cellInt(row.MFGTP79R),
        government: cellInt(row.GVTTP79R),
        nonspecialized: cellInt(row.UNCL79),
        federal_lands: cellInt(row.FEDTP79),
        retirement_destination: cellInt(row.RETTP79),
        persistent_poverty: cellInt(row.POVTP79),
        rural_urban_continuum_code: cellInt(row[ruccCol]),
        farming_1986: cellInt(row.AGTP86),
        mining_1986: cellInt(row.MINTP86),
        manufacturing_1986: cellInt(row.MFGTP86),
        government_1986: cellInt(row.GVTTP86),
        nonspecialized_1986: cellInt(row.UNCL86),
      }),
    )
  }
  return out
}

export async function countyTypologyCodes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const v = params.vintage
  const vintage = v === undefined || v === '' ? DEFAULT_VINTAGE : typeof v === 'string' ? v.trim() : String(v)
  if (!(vintage in VINTAGES)) throw new Error(`Invalid vintage: ${vintage}. Valid vintages are: ${Object.keys(VINTAGES).join(', ')}`)
  let state: string | undefined
  if (params.state !== undefined && params.state !== '' && !(Array.isArray(params.state) && params.state.length === 0)) {
    state = String(Array.isArray(params.state) ? params.state[0] : params.state).trim().toUpperCase() || undefined
    if (state && !STATE_ABBRS.includes(state)) throw new Error(`Invalid state: ${String(params.state)}. Use a two-letter postal abbreviation, e.g. 'TX'.`)
  }

  const config = VINTAGES[vintage]!
  const content = await fetchErsFile(ctx, config.media)
  let records: Row[]
  if (config.format === 'long_2025') records = parse2025(decodeText(content))
  else if (config.format === 'wide_2015') records = parse2015(decodeText(content))
  else {
    // pandas.read_excel(header=0, dtype=object): NaN for empty cells and default NA strings.
    const rows = sheetRecords(sheetNamed(readXls(content), config.sheet!), 0, false).map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, pdObj(x)])))
    records = config.format === 'wide_2004' ? parse2004(rows) : config.format === 'wide_1989' ? parse1989(rows) : parse1979(rows, config.ruccCol!)
  }
  const selected = records.filter((r) => state === undefined || r.state === state)
  return sortedBy(selected, (r) => [r.fips as string]).map(nullTokensToNone)
}
