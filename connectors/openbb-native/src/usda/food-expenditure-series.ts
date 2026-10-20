// usda/food_expenditure_series, provider usda. Ported from openbb_government_us/usda/models/food_expenditure_series.py
// and utils/ers_food_expenditure_series.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models.
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchErsText, isNullToken, nullTokensToNone, optInt, optString, pyFloat, sortedBy } from './helpers.js'

const DEFAULT_TABLE = 'food_and_alcohol'

const MONTH_ORDER: Record<string, number> = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 }

/** The row labels of the food-and-alcohol files, in column order (their headers vary between files). */
const FOOD_AND_ALCOHOL_LABELS = [
  'Food sales at grocery stores',
  'Food sales at convenience stores',
  'Food sales at other food stores',
  'Food sales at warehouse clubs and supercenters',
  'Food sales at other stores and foodservice',
  'Direct food selling by farmers, manufacturers, and wholesalers',
  'Home food production and donations',
  'Total food-at-home expenditures',
  'Food sales at full-service restaurants',
  'Food sales at limited-service restaurants',
  'Food sales at drinking places',
  'Food sales at hotels and motels',
  'Food sales at retail stores',
  'Food sales at recreational places',
  'Food sales at schools and colleges',
  'Food sales at other establishments, not elsewhere classified',
  'Food furnished and donated',
  'Total food-away-from-home expenditures',
  'Alcohol sales at liquor stores',
  'Alcohol-at-home sales at food stores',
  'Alcohol-at-home sales at other establishments, not elsewhere classified',
  'Total alcohol-at-home sales',
  'Alcohol sales at eating and drinking places',
  'Alcohol sales at hotels and motels',
  'Alcohol-away-from-home sales at other establishments, not elsewhere classified',
  'Total alcohol-away-from-home sales',
]

type TableConfig = {
  dims: ('year' | 'month' | 'state')[]
  measureSelectsFile: boolean
  taxesSelectsFile: boolean
  /** Keyed by the selecting parameters joined with a slash (measure/taxes, taxes, or empty). */
  files: Record<string, string>
  canonicalLabels: string[] | null
}

const FOOD_EXPENDITURE_FILES: Record<string, TableConfig> = {
  food_and_alcohol: {
    dims: ['year'],
    measureSelectsFile: true,
    taxesSelectsFile: true,
    files: {
      'nominal/with': '/media/5188/nominal-food-and-alcohol-expenditures-with-taxes-and-tips-for-all-purchasers.csv',
      'nominal/without': '/media/5190/nominal-food-and-alcohol-expenditures-without-taxes-and-tips-for-all-purchasers.csv',
      'constant/with': '/media/5192/constant-dollar-food-and-alcohol-expenditures-with-taxes-and-tips-for-all-purchasers.csv',
      'constant/without': '/media/5194/constant-dollar-food-and-alcohol-expenditures-without-taxes-and-tips-for-all-purchasers.csv',
    },
    canonicalLabels: FOOD_AND_ALCOHOL_LABELS,
  },
  by_final_purchaser: { dims: ['year'], measureSelectsFile: false, taxesSelectsFile: false, files: { '': '/media/5196/food-expenditures-by-final-purchaser.csv' }, canonicalLabels: null },
  normalized: { dims: ['year'], measureSelectsFile: false, taxesSelectsFile: false, files: { '': '/media/5198/normalized-food-expenditures-by-all-purchasers-and-household-final-users.csv' }, canonicalLabels: null },
  monthly: { dims: ['year', 'month'], measureSelectsFile: false, taxesSelectsFile: false, files: { '': '/media/5202/monthly-sales-of-food-with-taxes-and-tips-for-all-purchasers.csv' }, canonicalLabels: null },
  monthly_by_outlet: { dims: ['year', 'month'], measureSelectsFile: false, taxesSelectsFile: false, files: { '': '/media/5200/monthly-sales-of-food-with-taxes-and-tips-for-all-purchasers-by-outlet-type.csv' }, canonicalLabels: null },
  state: {
    dims: ['year', 'state'],
    measureSelectsFile: false,
    taxesSelectsFile: true,
    files: { with: '/media/5204/state-food-sales-with-taxes-and-tips-for-all-purchasers.csv', without: '/media/5206/state-food-sales-without-taxes-and-tips-for-all-purchasers.csv' },
    canonicalLabels: null,
  },
  state_per_capita: {
    dims: ['year', 'state'],
    measureSelectsFile: false,
    taxesSelectsFile: true,
    files: { with: '/media/5208/state-food-sales-per-capita-with-taxes-and-tips-for-all-purchasers.csv', without: '/media/5210/state-food-sales-per-capita-without-taxes-and-tips-for-all-purchasers.csv' },
    canonicalLabels: null,
  },
}

/** `clean_header`: the series label of a column header and the measure ("nominal", "constant") its unit names, if any. */
function cleanHeader(header: string): [string, string | null] {
  const text = header.trim()
  const cut = text.indexOf(' (')
  let label = cut !== -1 ? text.slice(0, cut) : text
  const unit = cut !== -1 ? text.slice(cut).toLowerCase() : ''
  for (const phrase of [' with taxes and tips', ' without taxes and tips']) if (label.endsWith(phrase)) label = label.slice(0, -phrase.length)
  label = label.trim()
  if (unit.includes('percentage')) return [label, null]
  if (unit.includes('constant')) return [label, 'constant']
  if (unit.includes('nominal')) return [label, 'nominal']
  return [label, null]
}

/** `extract_unit`: the parenthesised unit at the end of a header. */
function extractUnit(header: string): string {
  const text = header.trim()
  const cut = text.indexOf(' (')
  if (cut === -1) return ''
  const unit = text.slice(cut + 2).trimEnd()
  return unit.endsWith(')') ? unit.slice(0, -1) : unit
}

type Observation = { year: number; month: string | null; state: string | null; category: string; measure: string | null; unit: string; value: number }

function parseTable(text: string, config: TableConfig): Observation[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  const nDims = config.dims.length
  const specs: { col: number; label: string; measure: string | null; unit: string }[] = []
  for (let col = nDims; col < header.length; col++) {
    const unit = extractUnit(header[col]!)
    if (config.canonicalLabels) {
      const label = config.canonicalLabels[col - nDims]
      if (label === undefined) throw new Error('list index out of range')
      specs.push({ col, label, measure: null, unit })
    } else {
      const [label, measure] = cleanHeader(header[col]!)
      specs.push({ col, label, measure, unit })
    }
  }
  const records: Observation[] = []
  for (const row of rows) {
    if (row.length === 0 || !/^\d+$/.test(row[0]!.slice(0, 4))) continue
    const year = Number(row[0]!.slice(0, 4))
    const second = config.dims.includes('month') || config.dims.includes('state') ? row[1]!.trim() || null : null
    const month = config.dims.includes('month') ? second : null
    const state = config.dims.includes('state') ? second : null
    for (const { col, label, measure, unit } of specs) {
      const value = pyFloat(col < row.length ? row[col]!.trim() : '')
      if (value === undefined) continue
      records.push({ year, month, state, category: label, measure, unit, value })
    }
  }
  return records
}

export async function foodExpenditureSeries(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = FOOD_EXPENDITURE_FILES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FOOD_EXPENDITURE_FILES).join(', ')}`)
  const measure = optString(params, 'measure') ?? 'nominal'
  const taxes = optString(params, 'taxes') ?? 'with'
  if (measure !== 'nominal' && measure !== 'constant') throw new Error("measure: Input should be 'nominal' or 'constant'")
  if (taxes !== 'with' && taxes !== 'without') throw new Error("taxes: Input should be 'with' or 'without'")
  const stateParam = optString(params, 'state')
  const stateFilter = stateParam ? stateParam.toLowerCase() : undefined
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const fileKey = [config.measureSelectsFile ? measure : null, config.taxesSelectsFile ? taxes : null].filter((k) => k !== null).join('/')
  const data = parseTable(await fetchErsText(ctx, config.files[fileKey]!), config)

  const filtered = data.filter((r) => {
    if (r.measure !== null && r.measure !== measure) return false
    if (startYear !== undefined && r.year < startYear) return false
    if (endYear !== undefined && r.year > endYear) return false
    return !(stateFilter !== undefined && r.state !== null && !r.state.toLowerCase().includes(stateFilter))
  })
  const stateVaries = new Set(filtered.map((r) => r.state).filter((s): s is string => !!s && !isNullToken(s))).size > 1
  const units = new Set(filtered.map((r) => r.unit))
  const unitSuffix = units.size === 1 && !units.has('') ? ` (${[...units][0]})` : ''

  type Wide = { state: string; year: number; monthOrder: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const colOrder: string[] = []
  const seen = new Set<string>()
  for (const r of filtered) {
    const key = JSON.stringify([r.state ?? '', r.year, r.month])
    let row = pivoted.get(key)
    if (!row) {
      const dimValues = stateVaries && r.state && !isNullToken(r.state) ? [r.state] : []
      const timeLabel = r.month ? `${r.year} ${r.month}` : String(r.year)
      row = { state: r.state ?? '', year: r.year, monthOrder: MONTH_ORDER[r.month ?? ''] ?? 0, period: [...dimValues, timeLabel].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    const column = `${r.category}${unitSuffix}`
    if (!seen.has(column)) {
      seen.add(column)
      colOrder.push(column)
    }
    row.values.set(column, r.value)
  }
  return sortedBy([...pivoted.values()], (r) => [r.state, r.year, r.monthOrder]).map((r) => {
    const out: Row = { period: r.period }
    for (const column of colOrder) out[column] = r.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
