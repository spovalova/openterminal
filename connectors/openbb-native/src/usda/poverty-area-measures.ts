// usda/poverty_area_measures, provider usda. Ported from openbb_government_us/usda/models/poverty_area_measures.py and
// utils/ers_poverty_area_measures.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, nullTokensToNone, sortedBy } from './helpers.js'
import { intOfFloatText, pickParam, STATE_NAMES, zfill } from './helpers-g.js'

const DEFAULT_EDITION = '2025'
/** The poverty tables list the 50 states and DC only. */
const STATES = Object.keys(STATE_NAMES).filter((s) => !['PR', 'AS', 'GU', 'MP', 'VI'].includes(s))

type Edition = { media: string; flagSep: string; metroCol: string; bealeCol: string; rucaCol: string; subregCol: string; tractFipsCol: string | null }
const EDITIONS: Record<string, Edition> = {
  '2025': { media: '/media/5041/poverty-area-measures-september-2025-edition.csv', flagSep: '', metroCol: 'MetNonmet2023', bealeCol: 'Beale2023', rucaCol: 'Ruca2020', subregCol: 'Subreg3', tractFipsCol: 'TractFIPS23' },
  '2023': { media: '/media/5043/poverty-area-measures-december-2023-edition.csv', flagSep: '_', metroCol: 'MetNonmet2023', bealeCol: 'Beale2013', rucaCol: 'RUCA_2010', subregCol: 'subreg3', tractFipsCol: null },
  '2022': { media: '/media/5045/poverty-area-measures-november-2022-edition.csv', flagSep: '_', metroCol: 'MetNonmet2013', bealeCol: 'Beale2013', rucaCol: 'RUCA_2010', subregCol: 'subreg3', tractFipsCol: null },
}

const MEASURE_PREFIX: Record<string, string> = { high_poverty: 'HiPov', extreme_poverty: 'ExtPov', persistent_poverty: 'PerPov', enduring_poverty: 'EndurePov' }
const PERIOD_TOKEN: Record<string, string> = { '1960': '60', '1970': '70', '1980': '80', '1990': '90', '2000': '00', '2007_11': '0711', '2015_19': '1519', '2017_21': '1721', '2018_22': '1822', '2019_23': '1923' }
const ALL_PERIODS = ['1960', '1970', '1980', '1990', '2000', '2007_11', '2015_19', '2017_21', '2018_22', '2019_23']
const FLAG_FIELDS: [string, string[]][] = [
  ['high_poverty', ALL_PERIODS],
  ['extreme_poverty', ALL_PERIODS],
  ['persistent_poverty', ['1990', '2000', '2007_11', '2015_19', '2017_21']],
  ['enduring_poverty', ['2007_11', '2015_19', '2017_21']],
]

/** `cell_int`: an integer flag, keeping the -1 not-available sentinel; null for blanks and placeholder tokens. */
function cellInt(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!text || ['na', 'n/a', '--', '-'].includes(text.toLowerCase())) return null
  return intOfFloatText(text)
}

/** `cell_str`. */
function cellStr(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  return text || null
}

/** `normalize_fips` / `normalize_tract_fips`: a zero-padded identifier. */
function normalizeFips(value: string | undefined, width: number): string | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!text) return null
  const n = intOfFloatText(text)
  return zfill(n === null ? text : String(n), width)
}

export async function povertyAreaMeasures(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const edition = pickParam(params.edition, Object.keys(EDITIONS), DEFAULT_EDITION, 'edition', 'editions')
  const level = pickParam(typeof params.level === 'string' ? params.level.toLowerCase() : params.level, ['county', 'tract'], 'county', 'level', 'levels')
  let state: string | undefined
  if (params.state !== undefined && params.state !== '' && !(Array.isArray(params.state) && params.state.length === 0)) {
    state = String(Array.isArray(params.state) ? params.state[0] : params.state).trim().toUpperCase() || undefined
    if (state && !STATES.includes(state)) throw new Error(`Invalid state: ${state}. Valid states are: ${STATES.join(', ')}`)
  }

  const config = EDITIONS[edition]!
  const letter = level === 'county' ? 'c' : 't'
  const text = await fetchErsText(ctx, config.media)

  const seen = new Set<string>()
  const records: Row[] = []
  for (const raw of csvDictRows(text)) {
    const lower: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(raw)) lower[key.trim().toLowerCase()] = value
    const fips = normalizeFips(lower.fips, 5)
    if (fips === null) continue
    let tractFips: string | null = null
    let tract: string | null = null
    let tractName: string | null = null
    let rucaCode: number | null = null
    let bna: number | null = null
    if (level === 'county') {
      if (seen.has(fips)) continue
      seen.add(fips)
    } else {
      if (config.tractFipsCol) tractFips = normalizeFips(lower[config.tractFipsCol.toLowerCase()], 11)
      else {
        const t = lower.tract
        tractFips = t === undefined || !t.trim() ? null : fips + zfill(t.trim(), 6)
      }
      tract = cellStr(lower.tract)
      tractName = cellStr(lower.tractname)
      rucaCode = cellInt(lower[config.rucaCol.toLowerCase()])
      bna = cellInt(lower.bna01)
    }
    const record: Row = {
      fips,
      state: cellStr(lower.stusab),
      county_name: cellStr(lower.countyname),
      region: cellInt(lower.region),
      subregion: cellInt(lower[config.subregCol.toLowerCase()]),
      metro_nonmetro: cellInt(lower[config.metroCol.toLowerCase()]),
      rucc_code: cellInt(lower[config.bealeCol.toLowerCase()]),
      tract_fips: tractFips,
      tract,
      tract_name: tractName,
      ruca_code: rucaCode,
      bna,
    }
    for (const [measure, periods] of FLAG_FIELDS) {
      for (const period of periods) record[`${measure}_${period}`] = cellInt(lower[`${MEASURE_PREFIX[measure]}${PERIOD_TOKEN[period]}${config.flagSep}${letter}`.toLowerCase()])
    }
    records.push(record)
  }

  const rows = records.filter((r) => state === undefined || r.state === state)
  if (rows.length === 0) throw new Error('No records match the given filters.')
  const sorted = sortedBy(rows, (r) => [r.fips as string, (r.tract_fips as string | null) ?? ''])
  if (level === 'tract') for (const r of sorted) if (r.tract_fips) r.fips = r.tract_fips
  return sorted.map(nullTokensToNone)
}
