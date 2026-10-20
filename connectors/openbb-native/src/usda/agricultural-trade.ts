// usda/agricultural_trade, provider usda. Ported from openbb_government_us/usda/models/us_agricultural_trade.py
// and utils/ers_fatus_trade.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import {
  DIRECTIONS,
  DIRECTION_LABELS,
  FISCAL_MONTH_ORDER,
  LABEL_FIXES,
  MONTH_INDEX,
  PERIOD_BASIS_ORDER,
  SPREAD_DIMENSION,
  TABLE_MEASURES,
  TRADE_TABLES,
  VALUE_TYPES,
} from './agricultural-trade-data.js'
import { decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy } from './helpers.js'

const MEDIA_PATH = '/media/5029/csv-comma-separated-values-format-of-all-data.csv'
const DEFAULT_TABLE = 'exports_ytd'
const DEFAULT_BASIS: Record<string, string> = { summary: 'Fiscal year', monthly: 'Monthly', exports_ytd: 'Monthly', imports_ytd: 'Monthly', top_export_markets: 'Monthly', top_import_sources: 'Monthly' }
/** The source's long table names → the short names OpenBB takes. */
const TABLE_ALIASES = new Map(Object.entries(TRADE_TABLES).map(([alias, name]) => [name, alias]))
const VINTAGE_PATTERN = /update of ([A-Za-z]+)/

type TradeRecord = {
  table: string
  commodity: string
  country: string
  timePeriod: string
  year: string
  direction: string
  valueType: string
  units: string
  value: number
  updateVersion: string | null
}

const isMonth = (s: string | undefined): boolean => s !== undefined && Object.prototype.hasOwnProperty.call(MONTH_INDEX, s)

/** The update vintage as a fiscal-month number: later updates sort higher. */
function vintageOrder(updateVersion: string | null): number {
  if (!updateVersion) return 0
  const match = VINTAGE_PATTERN.exec(updateVersion)
  return match ? (FISCAL_MONTH_ORDER[match[1]!] ?? 0) : 0
}

function classifyPeriod(period: string): string | null {
  if (period.startsWith('Fiscal year')) return 'Fiscal year'
  if (period.startsWith('Calendar year')) return 'Calendar year'
  if (isMonth(period)) return 'Monthly'
  const parts = period.split('-')
  if (parts.length === 2 && isMonth(parts[0]) && isMonth(parts[1])) return parts[0] === 'January' ? 'Calendar year-to-date' : 'Fiscal year-to-date'
  return null
}

function withinYearRank(basis: string, period: string): number {
  if (basis === 'Monthly') return MONTH_INDEX[period] ?? 0
  if (basis === 'Calendar year-to-date') return MONTH_INDEX[period.split('-')[1] ?? ''] ?? 0
  if (basis === 'Fiscal year-to-date') return FISCAL_MONTH_ORDER[period.split('-')[1] ?? ''] ?? 0
  return 0
}

/** The tables' latest update vintage only; rows without a vintage always stay. */
function filterLatest(records: TradeRecord[]): TradeRecord[] {
  const latest = new Map<string, number>()
  for (const r of records) {
    const order = vintageOrder(r.updateVersion)
    if (order > (latest.get(r.table) ?? 0)) latest.set(r.table, order)
  }
  return records.filter((r) => r.updateVersion === null || vintageOrder(r.updateVersion) === (latest.get(r.table) ?? 0))
}

/** `parse_rows`: the whole file is read, and a row naming an unknown table, direction or value type fails the call. */
function parseRows(text: string): TradeRecord[] {
  const [header, ...rows] = parseCsv(text)
  const index = new Map((header ?? []).map((h, i) => [h.trim(), i] as const))
  const clean = (v: string | undefined): string | null => {
    const t = (v ?? '').trim()
    return !t || t === 'NA' ? null : t
  }
  const out: TradeRecord[] = []
  for (const cells of rows) {
    const r = (name: string): string => (cells[index.get(name) ?? -1] ?? '').trim()
    const valueText = r('Value')
    if (!valueText) continue
    const sourceTable = r('Source_table')
    const table = TABLE_ALIASES.get(sourceTable)
    if (table === undefined) throw new Error(`Unrecognized source table: '${sourceTable}'. Expected one of: ${[...TABLE_ALIASES.keys()].sort().join('; ')}`)
    const directionText = r('US_Trade')
    const direction = DIRECTIONS[directionText]
    if (direction === undefined) throw new Error(`Unrecognized trade direction: '${directionText}'. Expected one of: ${Object.keys(DIRECTIONS).sort().join('; ')}`)
    const valueTypeText = r('Value_type')
    const valueType = VALUE_TYPES[valueTypeText]
    if (valueType === undefined) throw new Error(`Unrecognized value type: '${valueTypeText}'. Expected one of: ${Object.keys(VALUE_TYPES).sort().join('; ')}`)
    const value = pyFloat(valueText)
    if (value === undefined) throw new Error(`could not convert string to float: '${valueText}'`)
    const commodity = r('Commodity')
    const country = r('Country')
    out.push({
      table,
      commodity: LABEL_FIXES[commodity] ?? commodity,
      country: LABEL_FIXES[country] ?? country,
      timePeriod: r('Time_period'),
      year: r('Year'),
      direction,
      valueType,
      units: r('Units'),
      value,
      updateVersion: clean(cells[index.get('Update_version') ?? -1]),
    })
  }
  return out
}

export async function agriculturalTrade(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!(table in TRADE_TABLES)) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(TRADE_TABLES).join(', ')}`)
  const requestedBasis = optString(params, 'period_basis')
  const valueType = optString(params, 'value_type')
  const requestedCommodity = optString(params, 'commodity')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')
  const latest = params.latest === true || params.latest === 'true'

  const measures = TABLE_MEASURES[table]!
  const measure = valueType !== undefined && measures.includes(valueType) ? valueType : measures[0]!
  const spread = SPREAD_DIMENSION[table]!
  let records = parseRows(decodeText(await fetchErsFile(ctx, MEDIA_PATH))).filter((r) => r.table === table)
  if (latest) records = filterLatest(records)
  records = records.filter((r) => r.valueType === measure)

  // The reporting basis: the one asked for if the table publishes it, else the table's default, else the first it has.
  const present = new Set(records.map((r) => classifyPeriod(r.timePeriod)))
  const available = PERIOD_BASIS_ORDER.filter((b) => present.has(b))
  const basis = requestedBasis !== undefined && available.includes(requestedBasis) ? requestedBasis : DEFAULT_BASIS[table] !== undefined && available.includes(DEFAULT_BASIS[table]!) ? DEFAULT_BASIS[table]! : (available[0] ?? DEFAULT_BASIS[table]!)
  records = records.filter((r) => classifyPeriod(r.timePeriod) === basis)
  if (spread === 'country') {
    const commodities = [...new Set(records.map((r) => r.commodity))]
    const commodity = requestedCommodity && commodities.includes(requestedCommodity) ? requestedCommodity : commodities[0]
    records = records.filter((r) => r.commodity === commodity)
  }

  const kept: { year: number; r: TradeRecord }[] = []
  for (const r of records) {
    const year = pyInt(r.year.slice(0, 4))
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${r.year.slice(0, 4)}'`)
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    kept.push({ year, r })
  }
  const columnLabel = (r: TradeRecord): string => {
    const base = spread === 'direction' ? DIRECTION_LABELS[r.direction]! : spread === 'commodity' ? r.commodity : r.country
    return r.units ? `${base} (${r.units})` : base
  }
  let columnOrder: string[]
  if (spread === 'direction') {
    const byDirection = new Map<string, string>()
    for (const { r } of kept) if (!byDirection.has(r.direction)) byDirection.set(r.direction, columnLabel(r))
    columnOrder = Object.keys(DIRECTION_LABELS).filter((d) => byDirection.has(d)).map((d) => byDirection.get(d)!)
  } else columnOrder = [...new Set(kept.map(({ r }) => columnLabel(r)))]

  // Later update vintages overwrite earlier ones within a period.
  type Wide = { year: number; rank: number; row: Row }
  const byKey = new Map<string, Wide>()
  for (const { year, r } of sortedBy(kept, (k) => [vintageOrder(k.r.updateVersion)])) {
    const key = JSON.stringify([year, r.timePeriod])
    let wide = byKey.get(key)
    if (!wide) {
      const period = basis === 'Fiscal year' || basis === 'Calendar year' ? String(year) : `${year} ${r.timePeriod}`
      byKey.set(key, (wide = { year, rank: withinYearRank(basis, r.timePeriod), row: { period } }))
    }
    wide.row[columnLabel(r)] = r.value
  }
  return sortedBy([...byKey.values()], (w) => [-w.year, -w.rank]).map((w) => {
    const row: Row = { period: w.row.period }
    for (const column of columnOrder) row[column] = w.row[column] ?? null
    return nullTokensToNone(row)
  })
}
