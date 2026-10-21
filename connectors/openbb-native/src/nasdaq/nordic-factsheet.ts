// nasdaq/nordic/{dividends,fundamentals,info}, provider nasdaq. Ported from openbb_nasdaq/models/nordic_{dividends,
// fundamentals,info}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, and the
// fact sheet PDF is read by src/nasdaq/factsheet.ts on src/lib/pdf-words.ts instead of pdfplumber.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, getNasdaqData, NA_VALUES, toNumber, type Dict } from './helpers.js'
import { getInstrumentFactsheet, pyStrip } from './factsheet.js'
import { resolveNordicInstrument } from './nordic.js'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A "DD/MM/YYYY" fact sheet date as "YYYY-MM-DD" (`datetime.strptime(v, "%d/%m/%Y").date()`); null when it does not fit. */
function dmyToIso(value: unknown): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value))
  if (!m) return null
  const [day, month, year] = [+m[1]!, +m[2]!, +m[3]!]
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
}

// --- dividends -------------------------------------------------------------------------------------------------

export async function nordicDividends(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? '').toUpperCase()
  if (!symbol) throw new Error('symbol is required')
  const start = params.start_date as string | undefined
  const end = params.end_date as string | undefined
  const sheet = await getInstrumentFactsheet(ctx, symbol)
  const results: { date: string; row: Row }[] = []
  for (const row of sheet.dividends) {
    const exDate = dmyToIso(row.ex_date)
    if (exDate === null) continue
    if (start && exDate < start) continue
    if (end && exDate > end) continue
    const amount = toNumber(row.amount)
    if (amount === null) throw new Error(`amount: Input should be a valid number, got '${row.amount}'`)
    results.push({ date: exDate, row: compact({ ex_dividend_date: exDate, amount, payment_date: dmyToIso(row.payment_date), dividend_type: row.type, currency: row.currency }) })
  }
  if (!results.length) return [] // EmptyDataError
  // Newest first; Array#sort is stable, as Python's reverse sort keeps equal dates in sheet order.
  return results.sort((a, b) => cmp(b.date, a.date)).map((r) => r.row)
}

// --- fundamentals ----------------------------------------------------------------------------------------------

export async function nordicFundamentals(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? '')
  if (!symbol) throw new Error('symbol is required')
  const sheet = await getInstrumentFactsheet(ctx, symbol)
  const results: Row[] = []
  for (const row of sheet.series) {
    const value = toNumber(row.value)
    if (value === null) continue
    results.push(compact({ section: row.section, label: row.label, period: row.period, value }))
  }
  return results // no rows: EmptyDataError
}

// --- info ------------------------------------------------------------------------------------------------------

const HEADER_FIELDS: [string, string][] = [
  ['Symbol', 'symbol'],
  ['Name', 'companyName'],
  ['ISIN', 'isin'],
  ['Exchange', 'exchange'],
  ['Segment', 'segment'],
  ['Currency', 'currency'],
  ['Market Status', 'marketStatus'],
]

/** Python's `str(value)` for a JSON value. */
function pyStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

/** Trim a Nasdaq Nordic metadata value without altering its formatting; null when it carries none. */
function normalize(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const trimmed = pyStrip(pyStr(value))
  return NA_VALUES.has(trimmed) ? null : trimmed
}

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function nordicInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? '')
  if (!symbol) throw new Error('symbol is required')
  const instrument = await resolveNordicInstrument(ctx, symbol)
  const base = `nordic/instruments/${instrument.orderbook_id}`
  const suffix = `?assetClass=${instrument.asset_class}&lang=en`
  /** One instrument section, tolerating an absent one. */
  const section = async (name: string): Promise<Dict> => {
    try {
      return (await getNasdaqData(ctx, `${base}/${name}${suffix}`)) || {}
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      return {}
    }
  }
  const [info, summary, tradeInfo, priceInfo] = await Promise.all([section('info'), section('summary'), section('trade-info'), section('price-info')])
  const profile = (await getInstrumentFactsheet(ctx, symbol)).profile

  const results: Row[] = []
  const header: Dict = info.qdHeader || {}
  for (const [label, key] of HEADER_FIELDS) {
    const value = normalize(header[key])
    if (value !== null) results.push({ category: 'Instrument', label, value })
  }
  const blocks: [string, unknown][] = [
    ['Quote', header.keyStats],
    ['Summary', summary.summaryData],
    ['Trading', tradeInfo.summary],
  ]
  for (const [category, block] of blocks) {
    if (!isDict(block)) continue
    for (const item of Object.values(block)) {
      if (!isDict(item)) continue
      const value = normalize(item.value)
      if (value === null) continue
      results.push({ category, label: String(item.label || '').replace(/:+$/, ''), value })
    }
  }
  for (const row of profile) results.push({ category: 'Profile', label: row.label, value: row.value })
  const trades: Dict = priceInfo.trades || {}
  for (const row of (Array.isArray(trades.rows) ? trades.rows : []) as Dict[]) {
    const value = normalize(row.value)
    if (value === null) continue
    if (typeof row.attribute !== 'string') throw new Error('label: Input should be a valid string')
    results.push(compact({ category: 'Price', label: row.attribute, value, as_of: normalize(row.date) }))
  }
  return results // no rows: EmptyDataError
}
