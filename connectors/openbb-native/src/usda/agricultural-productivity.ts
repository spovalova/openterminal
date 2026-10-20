// usda/agricultural_productivity, provider usda. Ported from openbb_government_us/usda/models/agricultural_productivity.py
// and utils/ers_agricultural_productivity.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'

const NATIONAL_STATE = 'US'
const DEFAULT_TABLE = 'national_indices'

type TableConfig = { media: string; geography: 'national' | 'state'; seriesCol: string; stateCol: string | null }

const FILES: Record<string, TableConfig> = {
  national_indices: {
    media: '/media/5406/table-1-indices-of-farm-outputs-inputs-and-total-factor-productivity-for-the-united-states-1948-2021.csv',
    geography: 'national',
    seriesCol: 'Attribute',
    stateCol: null,
  },
  national_price_quantity: {
    media: '/media/5407/table-1a-price-indices-and-implicit-quantities-of-farm-outputs-and-inputs-for-the-united-states-1948-2021.csv',
    geography: 'national',
    seriesCol: 'Attribute',
    stateCol: null,
  },
  state_relative_levels: {
    media: '/media/5410/table-2-relative-levels-of-agricultural-total-factor-productivity-tfp-and-price-and-quantity-indices-for-outputs-and-inputs-for-the-48-contiguous-states-for-the-years-1960-2015.csv',
    geography: 'state',
    seriesCol: 'Variable Name',
    stateCol: 'State',
  },
}

const STATE_LABELS: Record<string, string> = {
  US: 'United States', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine',
  MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana', NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NV: 'Nevada', NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VA: 'Virginia', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming',
}
const CONTIGUOUS_STATES = Object.keys(STATE_LABELS).filter((c) => c !== NATIONAL_STATE)

/** The state codes a table can answer for: the national tables only 'US'. */
function allowedStates(config: TableConfig): string[] {
  return config.geography === 'national' ? [NATIONAL_STATE] : CONTIGUOUS_STATES
}

export async function agriculturalProductivity(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = FILES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FILES).join(', ')}`)
  // A state the table does not cover is replaced by its first code (the model's after-validator).
  let state = (optString(params, 'state') ?? NATIONAL_STATE).toUpperCase()
  const codes = allowedStates(config)
  if (!codes.includes(state)) state = codes[0]!
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = await fetchErsText(ctx, config.media)
  const stateLabel = STATE_LABELS[state] ?? state
  const seriesOrder: string[] = []
  const seen = new Set<string>()
  const pivoted = new Map<number, Row>()
  for (const r of csvDictRows(text)) {
    const value = pyFloat(cell(r, 'Value'))
    if (value === undefined) continue
    const yearRaw = cell(r, 'Year')
    if (!/^\d{4}$/.test(yearRaw)) continue
    const series = cell(r, config.seriesCol)
    if (!series) continue
    const rowState = config.stateCol ? cell(r, config.stateCol).toUpperCase() || null : null
    if (rowState !== null && rowState !== state) continue
    const year = Number(yearRaw)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    let row = pivoted.get(year)
    if (!row) pivoted.set(year, (row = { year, state: stateLabel }))
    if (!seen.has(series)) {
      seen.add(series)
      seriesOrder.push(series)
    }
    row[series] = value
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  return [...pivoted.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const row = pivoted.get(year)!
      const ordered: Row = { year: row.year, state: row.state }
      for (const series of seriesOrder) if (series in row) ordered[series] = row[series]
      return nullTokensToNone(ordered)
    })
}
