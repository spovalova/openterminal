// usda/area_and_road_ruggedness_scales, provider usda. Ported from openbb_government_us/usda/models/area_and_road_ruggedness_scales.py
// and utils/ers_area_and_road_ruggedness_scales.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone } from './helpers.js'
import { capitalizeText, cleanText, parseFloatCell, parsePopulation, pickParam, sortByText, STATE_CODES_BY_NAME, STATE_NAMES } from './helpers-g.js'

const DEFAULT_VINTAGE = '2020'
const DEFAULT_STATE = 'WV'
const STATES = ['AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY']

type Vintage = { media: string; identifiers: Record<string, string>; stateColumn: string; stateKind: 'name' | 'postal' }
const VINTAGES: Record<string, Vintage> = {
  '2020': {
    media: '/media/5414/2020-area-and-road-ruggedness-scales.csv',
    identifiers: { tract_fips: 'TractFIPS20', tract_name: 'TractName20', county_fips: 'CountyFIPS20', county_name: 'CountyName20', state_fips: 'StateFIPS20' },
    stateColumn: 'StateName20',
    stateKind: 'name',
  },
  '2010': {
    media: '/media/5412/area-and-road-ruggedness-scales.csv',
    identifiers: { tract_fips: 'TractFIPS', tract_name: 'TractName', county_fips: 'CountyFIPS', county_name: 'CountyName', state_fips: 'StateFIPS' },
    stateColumn: 'State',
    stateKind: 'postal',
  },
}

const STR_COLUMNS: Record<string, string> = { rs_region: 'RSRegion', rs_region_name: 'RSRegionName', primary_ruca: 'PrimaryRUCA', rurality_code: 'RuralityCode', ars: 'ARS', rrs: 'RRS' }
const CAPITALIZED_COLUMNS: Record<string, string> = { rurality_name: 'RuralityName', ars_description: 'ARSDescription', rrs_description: 'RRSDescription' }
const INT_COLUMNS: Record<string, string> = { population: 'Population', area_tri_count: 'AreaTRI_Count', road_tri_count: 'RoadTRI_Count' }
const FLOAT_COLUMNS: Record<string, string> = {
  land_area: 'LandArea', pop_density: 'PopDensity', area_tri_mean: 'AreaTRI_Mean', area_tri_std_dev: 'AreaTRI_StdDev', area_tri_median: 'AreaTRI_Median',
  area_tri_min: 'AreaTRI_Min', area_tri_max: 'AreaTRI_Max', area_tri_range: 'AreaTRI_Range', road_tri_mean: 'RoadTRI_Mean', road_tri_std_dev: 'RoadTRI_StdDev',
  road_tri_median: 'RoadTRI_Median', road_tri_min: 'RoadTRI_Min', road_tri_max: 'RoadTRI_Max', road_tri_range: 'RoadTRI_Range',
}

export async function areaAndRoadRuggednessScales(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const vintage = pickParam(params.vintage, Object.keys(VINTAGES), DEFAULT_VINTAGE, 'vintage', 'vintages')
  const stateParam = params.state === undefined || params.state === '' ? DEFAULT_STATE : String(Array.isArray(params.state) ? params.state[0] : params.state).trim().toUpperCase()
  const state = stateParam || DEFAULT_STATE
  if (!STATES.includes(state)) throw new Error(`Invalid state: ${state}. Valid states are: ${[...STATES].sort().join(', ')}`)

  const config = VINTAGES[vintage]!
  const text = await fetchErsText(ctx, config.media)

  const rows: Row[] = []
  for (const row of csvDictRows(text)) {
    if (!cleanText(row[config.identifiers.tract_fips!])) continue
    const record: Row = {}
    for (const [canonical, source] of Object.entries(config.identifiers)) record[canonical] = cleanText(row[source])
    if (config.stateKind === 'name') {
      const stateName = cleanText(row[config.stateColumn])
      record.state = stateName ? (STATE_CODES_BY_NAME[stateName] ?? null) : null
      record.state_name = stateName
    } else {
      const code = cleanText(row[config.stateColumn])
      record.state = code
      record.state_name = code ? (STATE_NAMES[code] ?? null) : null
    }
    if (record.state !== state) continue
    for (const [canonical, source] of Object.entries(STR_COLUMNS)) record[canonical] = cleanText(row[source])
    for (const [canonical, source] of Object.entries(CAPITALIZED_COLUMNS)) record[canonical] = capitalizeText(row[source])
    for (const [canonical, source] of Object.entries(INT_COLUMNS)) record[canonical] = parsePopulation(row[source])
    for (const [canonical, source] of Object.entries(FLOAT_COLUMNS)) record[canonical] = parseFloatCell(row[source])
    rows.push(record)
  }
  if (rows.length === 0) throw new Error('No records match the given filters.')
  return sortByText(rows, (r) => (r.tract_fips as string | null) ?? '').map(nullTokensToNone)
}
