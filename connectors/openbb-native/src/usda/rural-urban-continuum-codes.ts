// usda/rural_urban_continuum_codes, provider usda. Ported from openbb_government_us/usda/models/rural_urban_continuum_codes.py
// and utils/ers_rural_urban_continuum_codes.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic
// models; the 2013 and 2003 workbooks are read with src/lib/xls.ts instead of xlrd.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsFile, fetchErsText, nullTokensToNone } from './helpers.js'
import { cleanText, parsePopulation, pdStr, pickParam, sheetNamed, sheetRecords, sortByText, STATE_NAMES } from './helpers-g.js'
import { readXls } from '../lib/xls.js'

const DEFAULT_VINTAGE = '2023'

type XlsPart = { media: string; sheet: string; fips: string; state: string; name: string; code: string; description: string; population: string }
type Vintage = { format: 'csv'; media: string; codeAttr: string; descriptionAttr: string; populationAttr: string } | { format: 'xls'; parts: XlsPart[] }

const VINTAGES: Record<string, Vintage> = {
  '2023': { format: 'csv', media: '/media/5768/2023-rural-urban-continuum-codes.csv', codeAttr: 'RUCC_2023', descriptionAttr: 'Description', populationAttr: 'Population_2020' },
  '2013': {
    format: 'xls',
    parts: [{ media: '/media/5769/2013-rural-urban-continuum-codes.xls', sheet: 'Rural-urban Continuum Code 2013', fips: 'FIPS', state: 'State', name: 'County_Name', code: 'RUCC_2013', description: 'Description', population: 'Population_2010' }],
  },
  '2003': {
    format: 'xls',
    parts: [
      { media: '/media/5770/2003-rural-urban-continuum-codes.xls', sheet: 'beale03', fips: 'FIPS Code', state: 'State', name: 'County Name', code: '2003 Rural-urban Continuum Code', description: 'Description for 2003 codes', population: '2000 Population' },
      { media: '/media/5771/2003-rural-urban-continuum-codes-codes-for-puerto-rico.xls', sheet: 'pr2003', fips: 'FIPS Code', state: 'State', name: 'Municipio Name', code: 'Rural-urban Continuum Code, 2003', description: 'Description of the 2003 Code', population: 'Population 2003' },
    ],
  },
}

type Record_ = { fips: string; state: string | null; county_name: string | null; rucc_code: string | null; description: string | null; population: number | null }

/** `parse_csv_records`: the melted 2023 CSV (one row per county and attribute) as one record per FIPS. */
function parseCsvRecords(text: string, config: Extract<Vintage, { format: 'csv' }>): Record_[] {
  const rows = new Map<string, Record_>()
  for (const row of csvDictRows(text)) {
    const fips = cell(row, 'FIPS')
    if (!fips) continue
    let entry = rows.get(fips)
    if (!entry) {
      entry = { fips, state: cleanText(row.State), county_name: cleanText(row.County_Name), rucc_code: null, description: null, population: null }
      rows.set(fips, entry)
    }
    const attribute = cell(row, 'Attribute')
    const value = cell(row, 'Value')
    if (attribute === config.codeAttr) entry.rucc_code = value || null
    else if (attribute === config.descriptionAttr) entry.description = value || null
    else if (attribute === config.populationAttr) entry.population = parsePopulation(value)
  }
  return [...rows.values()]
}

/** `parse_xls_records`: a workbook sheet read as strings, one record per county row. */
function parseXlsRecords(content: Uint8Array, part: XlsPart): Record_[] {
  const records: Record_[] = []
  for (const raw of sheetRecords(sheetNamed(readXls(content), part.sheet))) {
    const fips = cleanText(pdStr(raw[part.fips]))
    if (!fips) continue
    records.push({
      fips,
      state: cleanText(pdStr(raw[part.state])),
      county_name: cleanText(pdStr(raw[part.name])),
      rucc_code: cleanText(pdStr(raw[part.code])),
      description: part.description ? cleanText(pdStr(raw[part.description])) : null,
      population: part.population ? parsePopulation(pdStr(raw[part.population])) : null,
    })
  }
  return records
}

export async function ruralUrbanContinuumCodes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const vintage = pickParam(params.vintage, Object.keys(VINTAGES), DEFAULT_VINTAGE, 'vintage', 'vintages')
  let state: string | undefined
  if (params.state !== undefined && params.state !== '' && !(Array.isArray(params.state) && params.state.length === 0)) {
    state = String(Array.isArray(params.state) ? params.state[0] : params.state).trim().toUpperCase()
    if (state && !(state in STATE_NAMES)) throw new Error(`Invalid state: ${state}. Valid states are: ${Object.keys(STATE_NAMES).join(', ')}`)
    state ||= undefined
  }

  const config = VINTAGES[vintage]!
  let records: Record_[]
  if (config.format === 'csv') records = parseCsvRecords(await fetchErsText(ctx, config.media), config)
  else {
    records = []
    for (const part of config.parts) records.push(...parseXlsRecords(await fetchErsFile(ctx, part.media), part))
  }

  const rows = records.filter((r) => state === undefined || r.state === state)
  if (rows.length === 0) throw new Error('No records match the given filters.')
  return sortByText(rows, (r) => r.fips).map((r) => nullTokensToNone({ fips: r.fips, state: r.state, county_name: r.county_name, rucc_code: r.rucc_code, description: r.description, population: r.population }))
}
