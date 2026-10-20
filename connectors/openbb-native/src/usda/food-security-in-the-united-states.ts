// usda/food_security_in_the_united_states, provider usda. Ported from openbb_government_us/usda/models/food_security_in_the_united_states.py
// and utils/ers_food_security_in_the_united_states.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead
// of pydantic models.
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { decodeText, fetchErsFile, isNullToken, nullTokensToNone, optInt, optString, pyFloat, sortedBy, zipMember } from './helpers.js'

const MEDIA_PATH = '/media/799/food-security-csv-data-files.zip'
const MEMBER_PREFIX = 'foodsecurity_csv_datafiles/'
const DEFAULT_TABLE = 'national_trend'
const REPLACEMENT = '�'

const STATE_LABEL_FIXES: Record<string, string> = { 'U.S. total': 'United States', 'U.S.': 'United States' }

type Measures = readonly (readonly [string, string])[]
const ALL_HOUSEHOLDS_MEASURES: Measures = [
  ['Total', 'Total households (1,000)'],
  ['Food secure-1,000', 'Food secure (1,000)'],
  ['Food secure-percent', 'Food secure (percent)'],
  ['Food insecure-1,000', 'Food insecure (1,000)'],
  ['Food insecure-percent', 'Food insecure (percent)'],
  ['Low food security-1,000', 'Low food security (1,000)'],
  ['Low food security-percent', 'Low food security (percent)'],
  ['Very low food security-1,000', 'Very low food security (1,000)'],
  ['Very low food security-percent', 'Very low food security (percent)'],
]
const CHILDREN_MEASURES: Measures = [
  ['Total', 'Total households (1,000)'],
  ['Food-secure households-1,000', 'Food-secure households (1,000)'],
  ['Food-secure households-percent', 'Food-secure households (percent)'],
  ['Food-insecure households-1,000', 'Food-insecure households (1,000)'],
  ['Food-insecure households-percent', 'Food-insecure households (percent)'],
  ['Households with food-insecure children-1,000', 'Households with food-insecure children (1,000)'],
  ['Households with food-insecure children-percent', 'Households with food-insecure children (percent)'],
  ['Households with very low food security among children-1,000', 'Households with very low food security among children (1,000)'],
  ['Households with very low food security among children-percent', 'Households with very low food security among children (percent)'],
]
const EDUCATION_MEASURES: Measures = [
  ['Total', 'Total households (1,000)'],
  ['Food insecure-1,000', 'Food insecure (1,000)'],
  ['Food insecure-percent', 'Food insecure (percent)'],
  ['Food insecure-share', 'Food insecure (share of food insecure)'],
  ['Very low food security-1,000', 'Very low food security (1,000)'],
  ['Very low food security-percent', 'Very low food security (percent)'],
  ['Very low food security-share', 'Very low food security (share of very low)'],
]
const STATE_MEASURES: Measures = [
  ['Food insecurity prevalence', 'Food insecurity prevalence (percent)'],
  ['Food insecurity margin of error', 'Food insecurity margin of error'],
  ['Very low food security prevalence', 'Very low food security prevalence (percent)'],
  ['Very low food security margin of error', 'Very low food security margin of error'],
]

type Dim = 'category' | 'subcategory' | 'sub_subcategory' | 'state'
const DIM_FIELDS: Dim[] = ['category', 'subcategory', 'sub_subcategory', 'state']

type TableConfig = {
  member: string
  dims: readonly (readonly [string, Dim])[]
  measures: Measures
  yearIsPeriod: boolean
  categoryMode: 'only_all' | 'exclude_all' | null
}

const ALL_DIMS = [['Category', 'category'], ['Subcategory', 'subcategory'], ['Sub-subcategory', 'sub_subcategory']] as const

const FOOD_SECURITY_TABLES: Record<string, TableConfig> = {
  national_trend: { member: 'foodsecurity-all-households-2024.csv', dims: ALL_DIMS, measures: ALL_HOUSEHOLDS_MEASURES, yearIsPeriod: false, categoryMode: 'only_all' },
  by_characteristic: { member: 'foodsecurity-all-households-2024.csv', dims: ALL_DIMS, measures: ALL_HOUSEHOLDS_MEASURES, yearIsPeriod: false, categoryMode: 'exclude_all' },
  households_with_children: { member: 'foodsecurity-hh-with-children-2024.csv', dims: [['Category', 'category'], ['Subcategory', 'subcategory']], measures: CHILDREN_MEASURES, yearIsPeriod: false, categoryMode: null },
  child_trends: { member: 'foodsecurity-child-trends-2024.csv', dims: [['Category', 'category']], measures: CHILDREN_MEASURES, yearIsPeriod: false, categoryMode: null },
  education_employment_disability: { member: 'foodsecurity-educ-emp-dis-2024.csv', dims: ALL_DIMS, measures: EDUCATION_MEASURES, yearIsPeriod: false, categoryMode: null },
  by_state: { member: 'foodsecurity-state-2024.csv', dims: [['State', 'state']], measures: STATE_MEASURES, yearIsPeriod: true, categoryMode: null },
}

const normalizeHeader = (header: string): string => header.replaceAll(REPLACEMENT, ' ').replace(/\s+/g, ' ').trim()

function cleanNumber(cell: string): number | null {
  const text = cell.replaceAll(REPLACEMENT, '').replaceAll(',', '').trim()
  return text ? (pyFloat(text) ?? null) : null
}

type Observation = { year: string; sortYear: number; dims: Record<Dim, string | null>; series: string; value: number | null }

function parseTable(text: string, config: TableConfig): Observation[] {
  const [headerRow, ...rows] = parseCsv(text)
  if (!headerRow) return []
  const index = new Map<string, number>()
  headerRow.map(normalizeHeader).forEach((name, position) => index.set(name, position))
  const yearIndex = index.get('Year')
  if (yearIndex === undefined) return []
  const records: Observation[] = []
  for (const raw of rows) {
    if (raw.length <= yearIndex) continue
    const cell = raw[yearIndex]!
    const yearLabel = config.yearIsPeriod ? cell.replaceAll(REPLACEMENT, '-').trim() : cell.trim()
    if (!/^\d{4}/.test(yearLabel)) continue
    const dims: Record<Dim, string | null> = { category: null, subcategory: null, sub_subcategory: null, state: null }
    for (const [source, field] of config.dims) {
      const position = index.get(source)
      let value = position !== undefined && position < raw.length ? raw[position]!.trim() : ''
      if (field === 'state') value = STATE_LABEL_FIXES[value] ?? value
      dims[field] = value || null
    }
    if (config.categoryMode === 'only_all' && dims.category !== 'All households') continue
    if (config.categoryMode === 'exclude_all' && dims.category === 'All households') continue
    for (const [source, label] of config.measures) {
      const position = index.get(source)
      if (position === undefined || position >= raw.length) continue
      records.push({ year: yearLabel, sortYear: Number(yearLabel.slice(0, 4)), dims, series: label, value: cleanNumber(raw[position]!) })
    }
  }
  return records
}

export async function foodSecurityInTheUnitedStates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = FOOD_SECURITY_TABLES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FOOD_SECURITY_TABLES).join(', ')}`)
  const category = optString(params, 'category')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const data = parseTable(decodeText(zipMember(await fetchErsFile(ctx, MEDIA_PATH), MEMBER_PREFIX + config.member)), config)
  const filtered = data
    .map((record, order) => ({ record, order }))
    .filter(({ record }) => {
      if (startYear !== undefined && record.sortYear < startYear) return false
      if (endYear !== undefined && record.sortYear > endYear) return false
      return !(category !== undefined && record.dims.category !== null && record.dims.category !== category)
    })

  // Dimensions with more than one value are written into the period label.
  const varying = Object.fromEntries(DIM_FIELDS.map((f) => [f, new Set(filtered.map(({ record }) => record.dims[f]).filter((v): v is string => v !== null && !isNullToken(v))).size > 1])) as Record<Dim, boolean>
  type Wide = { combo: number; sortYear: number; order: number; period: string; values: Map<string, number | null> }
  const pivoted = new Map<string, Wide>()
  const comboOrder = new Map<string, number>()
  const colOrder: string[] = []
  for (const { record, order } of filtered) {
    const combo = JSON.stringify(DIM_FIELDS.map((f) => record.dims[f]))
    const key = JSON.stringify([record.year, combo])
    let row = pivoted.get(key)
    if (!row) {
      if (!comboOrder.has(combo)) comboOrder.set(combo, comboOrder.size)
      const dimValues = DIM_FIELDS.filter((f) => varying[f] && record.dims[f] !== null && !isNullToken(record.dims[f])).map((f) => record.dims[f]!)
      row = { combo: comboOrder.get(combo)!, sortYear: record.sortYear, order, period: [...dimValues, record.year].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    if (!colOrder.includes(record.series)) colOrder.push(record.series)
    row.values.set(record.series, record.value)
  }
  return sortedBy([...pivoted.values()], (r) => [r.combo, r.sortYear, r.order]).map((r) => {
    const out: Row = { period: r.period }
    for (const column of colOrder) out[column] = r.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
