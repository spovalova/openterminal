// usda/livestock_and_meat_domestic_data, provider usda. Ported from openbb_government_us/usda/models/livestock_and_meat_domestic_data.py
// and utils/ers_livestock_and_meat_domestic_data.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models, and the two CSVs ERS renamed in the archive (MeatSD.csv is now Meat-Supply-Disappearance.csv, MeatStats.csv
// is now Meat-Statistics.csv) are found under either name; OpenBB looks only for the old ones and fails on five tables.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, decodeText, fetchErsFile, isNullToken, nullTokensToNone, optInt, optString, pyFloat, pyInt, readZip } from './helpers.js'
import { sortedNested } from './helpers-a.js'

const ZIP_MEDIA = '/media/5539/livestock-domestic-data-machine-readable-files.zip'
const ZIP_DIR = 'livestock-data-machine-readable-files'
const DEFAULT_TABLE = 'supply_and_disappearance'
const FOLD_DIM_FIELDS = ['commodity', 'table_name', 'geography'] as const
type FoldDim = (typeof FOLD_DIM_FIELDS)[number]

type TableConfig = {
  /** The CSV inside the archive; ERS renamed two of them, so the current name may follow the one OpenBB looks for. */
  member: string | string[]
  /** Keep only the rows of this `table_name` (MeatStats.csv holds several tables). */
  tableName: string | null
  /** Source column → record field. */
  foldDims: [string, FoldDim][]
  colDims: string[]
  multiUnit: boolean
  /** `month_year_strip` strips the trailing "-<year>" from the period description. */
  period: string | null
  periodSort: string | null
}

const meatStats = (tableName: string): TableConfig => ({ member: ['MeatStats.csv', 'Meat-Statistics.csv'], tableName, foldDims: [['commodity_desc', 'commodity']], colDims: ['attribute_desc'], multiUnit: false, period: 'month_year_strip', periodSort: 'timeperiod_id' })

const LIVESTOCK_AND_MEAT_FILES: Record<string, TableConfig> = {
  supply_and_disappearance: { member: ['MeatSD.csv', 'Meat-Supply-Disappearance.csv'], tableName: null, foldDims: [['commodity_desc', 'commodity']], colDims: ['attribute_desc'], multiUnit: true, period: 'timeperiod_desc', periodSort: 'timeperiod_id' },
  slaughter: meatStats('Livestock and poultry slaughter'),
  production: meatStats('Red meat and poultry production'),
  live_and_dressed_weights: meatStats('Livestock and poultry live and dressed weights'),
  cold_storage: meatStats('Red meat and poultry beginning cold storage stocks'),
  livestock_prices: { member: 'LivestockPrices.csv', tableName: null, foldDims: [], colDims: ['attribute_desc'], multiUnit: true, period: 'month_desc', periodSort: 'month_id' },
  wholesale_prices: { member: 'WholesalePrices.csv', tableName: null, foldDims: [], colDims: ['commodity_desc', 'geography_desc', 'attribute_desc'], multiUnit: true, period: 'month_desc', periodSort: 'month_id' },
  feeder_cattle_outside_feedlots: { member: 'FeederCattleSuppliesOutsideFeedlots.csv', tableName: null, foldDims: [], colDims: ['attribute_desc'], multiUnit: true, period: null, periodSort: null },
  heifers_entering_the_herd: { member: 'heifersenteringherd.csv', tableName: null, foldDims: [['table_name', 'table_name']], colDims: ['attribute_desc'], multiUnit: true, period: null, periodSort: null },
  high_plains_cattle_feeding_simulator: { member: 'highplainscattlefeedingsimulator.csv', tableName: null, foldDims: [], colDims: ['geography_desc', 'attribute_desc'], multiUnit: true, period: 'timeperiod_desc', periodSort: 'month_id' },
}

type Observation = {
  year: number
  period: string | null
  periodSort: number
  column: string
  amount: number | string
  unit: string | null
} & Record<FoldDim, string | null>

const cellText = (row: Record<string, string | undefined>, key: string): string => (row[key] ?? '').trim()

function periodOf(config: TableConfig, row: Record<string, string | undefined>): string | null {
  if (config.period === null) return null
  if (config.period === 'month_year_strip') {
    const desc = cellText(row, 'timeperiod_desc')
    const year = cellText(row, 'year_id')
    if (year && desc.endsWith(`-${year}`)) return desc.slice(0, -(year.length + 1))
    return desc || null
  }
  return cellText(row, config.period) || null
}

function periodSortOf(config: TableConfig, row: Record<string, string | undefined>): number {
  if (config.periodSort === null) return 0
  const text = cellText(row, config.periodSort) || '0'
  const n = pyInt(text)
  if (n === undefined) throw new Error(`invalid literal for int() with base 10: '${text}'`)
  return n
}

/** `_amount`: a number when it parses (commas dropped), the text itself when it does not, missing for blanks and placeholders. */
function amountOf(raw: string | undefined): number | string | null {
  const text = (raw ?? '').trim()
  if (!text || isNullToken(text)) return null
  return pyFloat(text.replace(/,/g, '')) ?? text
}

function columnLabel(config: TableConfig, row: Record<string, string | undefined>): string {
  let label = config.colDims.map((col) => cellText(row, col)).filter(Boolean).join(' ')
  if (config.multiUnit) {
    const unit = cellText(row, 'unit_desc')
    if (unit) label = `${label} (${unit})`
  }
  return label
}

/** The year, or the year with its month or quarter: ranges ("Jan to Mar") are kept as published. */
function periodLabel(year: number, period: string | null): string {
  if (!period || period.startsWith('Yr')) return String(year)
  if (period.includes(' to ')) return period
  return `${year} ${period}`
}

export async function livestockAndMeatDomesticData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = Object.prototype.hasOwnProperty.call(LIVESTOCK_AND_MEAT_FILES, table) ? LIVESTOCK_AND_MEAT_FILES[table] : undefined
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(LIVESTOCK_AND_MEAT_FILES).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_table
  const archive = readZip(await fetchErsFile(ctx, ZIP_MEDIA))
  const names = Array.isArray(config.member) ? config.member : [config.member]
  const found = names.map((name) => archive[`${ZIP_DIR}/${name}`]).find((bytes) => bytes !== undefined)
  if (!found) throw new Error(`There is no item named '${ZIP_DIR}/${names[0]}' in the archive`)
  const text = decodeText(found)
  const rows: Observation[] = []
  for (const row of csvDictRows(text)) {
    if (config.tableName !== null && cellText(row, 'table_name') !== config.tableName) continue
    const amount = amountOf(row.amount)
    if (amount === null) continue
    const yearLabel = cellText(row, 'year_id')
    if (!/^\d+$/.test(yearLabel)) continue
    const record: Observation = { commodity: null, table_name: null, geography: null, unit: null, year: Number(yearLabel), period: periodOf(config, row), periodSort: periodSortOf(config, row), column: columnLabel(config, row), amount }
    for (const [source, field] of config.foldDims) record[field] = cellText(row, source) || null
    if (!config.multiUnit) record.unit = cellText(row, 'unit_desc') || null
    if ((startYear !== undefined && record.year < startYear) || (endYear !== undefined && record.year > endYear)) continue
    rows.push(record)
  }
  if (rows.length === 0) return []

  // _classify_dims: a folded dimension joins the column name when it partitions the series.
  const foldDims = FOLD_DIM_FIELDS.filter((f) => new Set(rows.map((r) => r[f])).size > 1)
  const columnDims: FoldDim[] = []
  const rowDims: FoldDim[] = []
  for (const field of foldDims) {
    const distinct = new Set(rows.map((r) => r[field]).filter(Boolean))
    const seriesValues = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!r[field]) continue
      let set = seriesValues.get(r.column)
      if (!set) seriesValues.set(r.column, (set = new Set()))
      set.add(r[field]!)
    }
    if (distinct.size === 0 || seriesValues.size === 0) {
      rowDims.push(field)
      continue
    }
    let total = 0
    for (const s of seriesValues.values()) total += s.size
    if (total / seriesValues.size <= 0.6 * distinct.size || seriesValues.size <= distinct.size) columnDims.push(field)
    else rowDims.push(field)
  }

  // _pivot
  type Wide = { combo: number; order: number; year: number; periodSort: number; period: string; values: Map<string, number | string> }
  const pivoted = new Map<string, Wide>()
  const comboOrder = new Map<string, number>()
  const groupOrder = new Map<string, number>()
  const seriesOrder = new Map<string, number>()
  const colRank = new Map<string, [number, number]>()
  rows.forEach((r, order) => {
    const dims = rowDims.map((f) => r[f])
    const key = JSON.stringify([...dims, r.year, r.period])
    let row = pivoted.get(key)
    if (!row) {
      const comboKey = JSON.stringify(dims)
      if (!comboOrder.has(comboKey)) comboOrder.set(comboKey, comboOrder.size)
      row = { combo: comboOrder.get(comboKey)!, order, year: r.year, periodSort: r.periodSort, period: [...dims.filter(Boolean), periodLabel(r.year, r.period)].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    const columnValues = columnDims.map((f) => r[f]).filter(Boolean) as string[]
    const base = [...columnValues, r.column].join(' — ')
    const column = r.unit ? `${base} (${r.unit})` : base
    if (!colRank.has(column)) {
      const groupKey = JSON.stringify(columnValues)
      if (!groupOrder.has(groupKey)) groupOrder.set(groupKey, groupOrder.size)
      if (!seriesOrder.has(r.column)) seriesOrder.set(r.column, seriesOrder.size)
      colRank.set(column, [groupOrder.get(groupKey)!, seriesOrder.get(r.column)!])
    }
    row.values.set(column, r.amount)
  })
  const colOrder = sortedNested([...colRank.keys()], (c) => colRank.get(c)!)
  return sortedNested([...pivoted.values()], (w) => [w.combo, -w.year, -w.periodSort, -w.order]).map((w) => {
    const out: Row = { period: w.period }
    for (const column of colOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
