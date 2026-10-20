// usda/livestock_and_meat_international_trade_data, provider usda. Ported from
// openbb_government_us/usda/models/livestock_and_meat_international_trade_data.py and
// utils/ers_livestock_and_meat_international_trade_data.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead
// of pydantic models, workbooks read with src/lib/xlsx.ts instead of openpyxl, and the workbook reader follows the layout
// ERS publishes now (one tidy sheet: commodity, trade flow, unit, geography code and name, then a column per year or month)
// instead of the stacked "Import/export" blocks OpenBB still looks for, which makes OpenBB answer every call empty.
import { readXlsx, type Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchErsFile, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { sortedNested } from './helpers-a.js'

const DEFAULT_TABLE = 'beef_veal'
const DEFAULT_DIRECTION = 'imports'
const DEFAULT_FREQUENCY = 'annual'
const DIRECTIONS = ['imports', 'exports']
const FREQUENCIES = ['annual', 'monthly']
const HEADER_MARKER = 'Commodity description'
/** Columns before the first year or month: commodity, trade flow, unit, geography code, geography name. */
const FIRST_TIME_COLUMN = 5
const MONTH_ORD: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }
const NULL_TOKENS = new Set(['', '-', '--', '---', 'n/a', 'na', 'null', 'none', 'nan'])

type Species = { annual: string; monthly: string }

const SPECIES: Record<string, Species> = {
  beef_veal: { annual: '/media/5598/beef-and-veal-annual-and-cumulative-year-to-date-us-trade-carcass-weight-1000-pounds.xlsx', monthly: '/media/5608/beef-and-veal-monthly-us-trade-carcass-weight-1000-pounds.xlsx' },
  cattle: { annual: '/media/5599/cattle-annual-and-cumulative-year-to-date-us-trade-head.xlsx', monthly: '/media/5609/cattle-monthly-us-trade-head.xlsx' },
  pork: { annual: '/media/5600/pork-annual-and-cumulative-year-to-date-us-trade-carcass-weight-1000-pounds.xlsx', monthly: '/media/5610/pork-monthly-us-trade-carcass-weight-1000-pounds.xlsx' },
  hogs: { annual: '/media/5601/hogs-annual-and-cumulative-year-to-date-us-trade-head.xlsx', monthly: '/media/5611/hogs-monthly-us-trade-head.xlsx' },
  lamb_mutton: { annual: '/media/5602/lamb-and-mutton-annual-and-cumulative-year-to-date-us-trade-carcass-weight-1000-pounds.xlsx', monthly: '/media/5612/lamb-and-mutton-monthly-us-trade-carcass-weight-1000-pounds.xlsx' },
  sheep_goats: { annual: '/media/5603/sheep-and-goats-annual-and-cumulative-year-to-date-us-trade-head.xlsx', monthly: '/media/5613/sheep-and-goats-monthly-us-trade-head.xlsx' },
  poultry_eggs: { annual: '/media/5604/chickens-turkeys-and-eggs-annual-and-cumulative-year-to-date-us-trade.xlsx', monthly: '/media/5614/chickens-turkeys-and-eggs-monthly-us-trade.xlsx' },
}

type TimeColumn = { index: number; year: number; month: string | null; monthOrd: number; colKey: string; isYtd: boolean }
type Observation = { geographyCode: number | null; unit: string | null; country: string; year: number; month: string | null; monthOrd: number; colKey: string; isYtd: boolean; rank: number; value: number }

const expandYear = (twoDigit: number): number => (twoDigit < 50 ? 2000 + twoDigit : 1900 + twoDigit)
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
const normalizeLabel = (value: unknown): string => String(value).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()

/** A cell as a number: numbers as they are, text with thousands separators parsed, placeholders and junk missing. */
function coerceValue(value: Cell | undefined): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'number') return value
  const text = value.trim()
  if (NULL_TOKENS.has(text.toLowerCase())) return null
  return pyFloat(text.replace(/,/g, '')) ?? null
}

/** The year, month and cumulative columns a header row names. */
function parseTimeHeader(header: readonly Cell[]): TimeColumn[] {
  const columns: TimeColumn[] = []
  for (let index = FIRST_TIME_COLUMN; index < header.length; index++) {
    const cell = header[index]
    if (cell === null || cell === undefined) continue
    const text = String(cell).trim()
    if (/^\d{4}$/.test(text)) {
      columns.push({ index, year: Number(text), month: null, monthOrd: 0, colKey: text, isYtd: false })
      continue
    }
    const monthMatch = /^([A-Za-z]{3})-(\d{2})$/.exec(text)
    if (monthMatch) {
      const month = title(monthMatch[1]!)
      const year = expandYear(Number(monthMatch[2]))
      columns.push({ index, year, month, monthOrd: MONTH_ORD[month] ?? 0, colKey: String(year), isYtd: false })
      continue
    }
    // Year to date: "Jan-Aug-25" (ERS used to write "Jan-Aug 25").
    const ytdMatch = /^([A-Za-z]{3}-[A-Za-z]{3})[\s-](\d{2})$/.exec(text)
    if (ytdMatch) {
      const year = expandYear(Number(ytdMatch[2]))
      columns.push({ index, year, month: null, monthOrd: 0, colKey: `${ytdMatch[1]} ${year}`, isYtd: true })
    }
  }
  return columns
}

/** The sheets' rows, the last sheet first. */
function sheetsOf(content: Uint8Array): Cell[][][] {
  return readXlsx(content)
    .map((s) => s.rows)
    .reverse()
}

function headerIndex(rows: readonly Cell[][]): number {
  return rows.findIndex((row) => {
    const cell = row[0]
    return cell !== null && cell !== undefined && String(cell).startsWith(HEADER_MARKER)
  })
}

/** The flow a row's "Trade flow" names. */
const directionOf = (flow: Cell | undefined): string => (String(flow ?? '').toLowerCase().includes('export') ? 'exports' : 'imports')

/** The products a workbook lists for one direction (the commodity descriptions), in order. */
function parseProducts(content: Uint8Array, direction: string): string[] {
  const products: string[] = []
  const seen = new Set<string>()
  for (const rows of sheetsOf(content)) {
    const start = headerIndex(rows)
    if (start < 0) continue
    for (const row of rows.slice(start + 1)) {
      const label = row[0]
      const flow = row[1]
      if (label === null || label === undefined || flow === null || flow === undefined) continue
      const product = normalizeLabel(label)
      if (directionOf(flow) !== direction || seen.has(product)) continue
      seen.add(product)
      products.push(product)
    }
  }
  return products
}

/** One direction and product of the workbook, as one observation per country and time column. */
function parseWorkbook(content: Uint8Array, wantDirection: string, wantProduct: string): Observation[] {
  const records: Observation[] = []
  const ranks = new Map<string, number>()
  for (const rows of sheetsOf(content)) {
    const start = headerIndex(rows)
    if (start < 0) continue
    const columns = parseTimeHeader(rows[start]!)
    for (const row of rows.slice(start + 1)) {
      const label = row[0]
      const flow = row[1]
      const name = row[4]
      if (label === null || label === undefined || label === '' || flow === null || flow === undefined) continue
      const country = name !== null && name !== undefined ? String(name).trim() : ''
      if (!country) continue
      if (directionOf(flow) !== wantDirection || normalizeLabel(label) !== wantProduct) continue
      if (country.toLowerCase() === 'total' || country.startsWith('Total')) continue
      const code = row[3]
      const unit = row[2]
      const geographyCode = typeof code === 'number' ? Math.trunc(code) : null
      if (!ranks.has(country)) ranks.set(country, ranks.size)
      for (const column of columns) {
        const value = coerceValue(row[column.index])
        if (value === null) continue
        records.push({ geographyCode, unit: unit === null || unit === undefined ? null : String(unit).trim(), country, year: column.year, month: column.month, monthOrd: column.monthOrd, colKey: column.colKey, isYtd: column.isYtd, rank: ranks.get(country)!, value })
      }
    }
  }
  return records
}

/** A single-valued, validated text param: a list's first entry, trimmed. */
function pickParam(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  const first = Array.isArray(v) ? v[0] : v
  if (first === undefined || first === null || first === '') return undefined
  return String(first).trim()
}

export async function livestockAndMeatInternationalTradeData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = pickParam(params, 'table') ?? DEFAULT_TABLE
  const entry = Object.prototype.hasOwnProperty.call(SPECIES, table) ? SPECIES[table] : undefined
  if (!entry) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(SPECIES).join(', ')}`)
  const direction = (pickParam(params, 'direction') ?? DEFAULT_DIRECTION).toLowerCase()
  if (!DIRECTIONS.includes(direction)) throw new Error(`Invalid direction: ${direction}. Valid directions are: ${DIRECTIONS.join(', ')}`)
  const frequency = (pickParam(params, 'frequency') ?? DEFAULT_FREQUENCY).toLowerCase()
  if (!FREQUENCIES.includes(frequency)) throw new Error(`Invalid frequency: ${frequency}. Valid frequencies are: ${FREQUENCIES.join(', ')}`)
  const product = optString(params, 'product')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // afetch_records: a product the workbook does not list falls back to its first.
  const annual = await fetchErsFile(ctx, entry.annual)
  const products = parseProducts(annual, direction)
  const resolved = product !== undefined && products.includes(product) ? product : products[0]
  const data = resolved === undefined ? [] : parseWorkbook(frequency === 'monthly' ? await fetchErsFile(ctx, entry.monthly) : annual, direction, resolved)

  // transform_data: one row per country (and month), a column per year.
  const monthly = data.some((r) => r.month)
  type Wide = { rank: number; monthOrd: number; country: string; geographyCode: number | null; month: string | null; unit: string | null; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const colMeta = new Map<string, [number, number]>()
  for (const r of data) {
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) continue
    colMeta.set(r.colKey, [r.isYtd ? 1 : 0, r.year])
    const key = JSON.stringify([r.country, r.month])
    let row = pivoted.get(key)
    if (!row) {
      row = { rank: r.rank, monthOrd: r.monthOrd, country: monthly && r.month ? `${r.country} — ${r.month}` : r.country, geographyCode: r.geographyCode, month: r.month, unit: r.unit, values: new Map() }
      pivoted.set(key, row)
    }
    row.values.set(r.colKey, r.value)
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  const columnOrder = sortedNested([...colMeta.keys()], (c) => colMeta.get(c)!)
  return sortedNested([...pivoted.values()], (w) => [w.rank, w.monthOrd, w.country]).map((w) => {
    const out: Row = { country: w.country, geography_code: w.geographyCode, month: w.month, unit: w.unit }
    for (const col of columnOrder) out[col] = w.values.get(col) ?? null
    return nullTokensToNone(out)
  })
}
