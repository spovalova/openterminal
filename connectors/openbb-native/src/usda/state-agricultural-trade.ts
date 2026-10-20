// usda/state_agricultural_trade, provider usda. Ported from openbb_government_us/usda/models/state_agricultural_trade.py
// and utils/ers_state_agricultural_trade.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { COMMODITIES, DATASET_A_STATE_NAMES, DATASET_B_STATE_NAMES, STATE_CODE_TO_NAME, TABLE_LABELS, TABLE_UNITS } from './state-agricultural-trade-data.js'

const ALL_DATA_CSV = '/media/5420/csv-comma-separated-values-format-of-all-data.csv'
const TOP_EXPORTS_CSV = '/media/5422/top-5-us-agricultural-export-commodities-by-state-fiscal-year.csv'
const TOP_IMPORTS_CSV = '/media/5424/top-5-us-agricultural-import-commodities-by-state-fiscal-year.csv'
const FILES: Record<string, string> = { exports_by_commodity: ALL_DATA_CSV, exports_by_state: ALL_DATA_CSV, top_exports: TOP_EXPORTS_CSV, top_imports: TOP_IMPORTS_CSV }
const STATE_NAME_TO_CODE = Object.fromEntries(Object.entries(STATE_CODE_TO_NAME).map(([code, name]) => [name, code]))
const DEFAULT_TABLE = 'exports_by_commodity'
const DEFAULT_STATE = 'California'
const DEFAULT_COMMODITY = 'Total agricultural exports'

type Observation = { commodity: string; state: string; year: number; value: number | null }

/** A numeric cell, missing when blank or not a number. */
function parseValue(raw: string | undefined): number | null {
  const text = (raw ?? '').trim()
  return text ? (pyFloat(text) ?? null) : null
}

function parseDatasetA(text: string): Observation[] {
  const out: Observation[] = []
  for (const r of csvDictRows(text)) {
    const yearToken = cell(r, 'Year')
    if (!/^\d+$/.test(yearToken)) continue
    out.push({ commodity: cell(r, 'Commodity'), state: cell(r, 'State'), year: Number(yearToken), value: parseValue(r.Value) })
  }
  return out
}

/** The top-five fiscal-year files: world totals for the whole fiscal year only. */
function parseDatasetB(text: string): Observation[] {
  const out: Observation[] = []
  for (const r of csvDictRows(text)) {
    if (cell(r, 'Country') !== 'World') continue
    if (cell(r, 'Fiscal quarter') !== '0') continue
    const yearToken = cell(r, 'Fiscal year')
    if (!/^\d+$/.test(yearToken)) continue
    out.push({ state: cell(r, 'State'), year: Number(yearToken), commodity: cell(r, 'Commodity name'), value: parseValue(r['Dollar value']) })
  }
  return out
}

export async function stateAgriculturalTrade(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!(table in TABLE_LABELS)) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(TABLE_LABELS).join(', ')}`)
  // A two-letter code or a full state name.
  const stateParam = optString(params, 'state') ?? DEFAULT_STATE
  let state: string
  if (stateParam.toUpperCase() in STATE_CODE_TO_NAME) state = STATE_CODE_TO_NAME[stateParam.toUpperCase()]!
  else if (stateParam in STATE_NAME_TO_CODE) state = stateParam
  else throw new Error(`Invalid state: ${stateParam}. Valid states are: ${Object.keys(STATE_NAME_TO_CODE).join(', ')}`)
  const commodityParam = optString(params, 'commodity') ?? DEFAULT_COMMODITY
  if (!COMMODITIES.includes(commodityParam)) throw new Error(`Invalid commodity: ${commodityParam}. Valid commodities are: ${COMMODITIES.join(', ')}`)
  const datasetB = table === 'top_exports' || table === 'top_imports'
  if (table !== 'exports_by_state') {
    const names = datasetB ? DATASET_B_STATE_NAMES : DATASET_A_STATE_NAMES
    if (!names.includes(state)) throw new Error(`Invalid state '${state}' for table '${table}'. This table is published for: ${names.join(', ')}`)
  }
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = await fetchErsText(ctx, FILES[table]!)
  const data = datasetB ? parseDatasetB(text) : parseDatasetA(text)
  const unit = TABLE_UNITS[table]!

  let records: Observation[]
  let columnOf: 'commodity' | 'state'
  let orderRef: string[] | null
  let dims: Row
  if (table === 'exports_by_commodity') {
    records = data.filter((r) => r.state === state)
    columnOf = 'commodity'
    orderRef = COMMODITIES
    dims = { state, commodity: null, unit }
  } else if (table === 'exports_by_state') {
    records = data.filter((r) => r.commodity === commodityParam)
    columnOf = 'state'
    orderRef = DATASET_A_STATE_NAMES
    dims = { state: null, commodity: commodityParam, unit }
  } else {
    const code = STATE_NAME_TO_CODE[state] ?? state
    records = data.filter((r) => r.state === code)
    columnOf = 'commodity'
    orderRef = null
    dims = { state, commodity: null, unit }
  }

  const byYear = new Map<number, Row>()
  const present = new Set<string>()
  for (const r of records) {
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) continue
    const column = r[columnOf]
    present.add(column)
    let row = byYear.get(r.year)
    if (!row) byYear.set(r.year, (row = {}))
    row[column] = r.value
  }
  if (byYear.size === 0) throw new Error('No records match the given filters.')
  const sortedPresent = [...present].sort()
  const columnOrder = orderRef === null ? sortedPresent : [...orderRef.filter((c) => present.has(c)), ...sortedPresent.filter((c) => !orderRef.includes(c))]
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const source = byYear.get(year)!
      const row: Row = { year, ...dims }
      for (const column of columnOrder) row[column] = source[column] ?? null
      return nullTokensToNone(row)
    })
}
