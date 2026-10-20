// equity/price/historical, etf/historical, index/price/historical, crypto/price/historical,
// currency/price/historical, derivatives/futures/historical and yfinance/funds/historical, provider yfinance.
// Independent implementation of OpenBB's output for these routes (not derived from openbb_yfinance, which is AGPL);
// Yahoo endpoints as used by yfinance (Apache-2.0).
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { fetchChart, isIntraday, priceHistory } from './chart.js'
import { addDays, dayStart, symbolsOf, todayNy } from './helpers.js'
import indexTable from './index-available.json' with { type: 'json' }

const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1W', '1M', '1Q'])
/** tmx's interval names, which currency and futures routes also list. */
const ALIASES: Record<string, string> = { day: '1d', week: '1W', month: '1M' }

function intervalOf(params: NativeParams): string {
  const given = typeof params.interval === 'string' && params.interval ? params.interval : '1d'
  const interval = ALIASES[given] ?? given
  if (!INTERVALS.has(interval)) throw new NativeUnsupported(`yfinance has no ${given} interval`)
  return interval
}

/** How far back a window starts when the caller names no start date: a year, or what Yahoo still serves of intraday data. */
export function defaultStart(interval: string, today: string): string {
  if (interval === '1m') return addDays(today, -6)
  if (isIntraday(interval) && interval !== '60m' && interval !== '1h') return addDays(today, -59)
  return addDays(today, -365)
}

/** The inclusive window a call asks for: an end date not after the start means "until today". */
export function windowOf(params: NativeParams, interval: string, ctx: NativeCtx): { start: string; end: string } {
  const today = todayNy(ctx)
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : defaultStart(interval, today)
  const given = typeof params.end_date === 'string' && params.end_date ? params.end_date : undefined
  return { start, end: given && given > start ? given : today }
}

/** Symbols one after the other (Yahoo rate-limits), one with no data left out; sorted by date, then symbol. */
export async function manySymbols(symbols: string[], fetchOne: (symbol: string) => Promise<Row[]>, label: (symbol: string) => string = (s) => s, multi = symbols.length > 1): Promise<Row[]> {
  const out: Row[] = []
  for (const symbol of symbols) {
    const rows = await fetchOne(symbol)
    out.push(...(multi ? rows.map((r) => ({ ...r, symbol: label(symbol) })) : rows))
  }
  if (multi) out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.symbol).localeCompare(String(b.symbol)))
  return out
}

export async function equityHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = intervalOf(params)
  const { start, end } = windowOf(params, interval, ctx)
  const adjustDividends = params.adjustment === 'splits_and_dividends'
  const actions = params.include_actions !== false
  const prepost = params.extended_hours === true
  return manySymbols(symbolsOf(params), (symbol) => priceHistory(ctx, symbol, { interval, start, end, prepost, actions, adjustDividends }))
}

/** ETFs are priced exactly like equities. */
export const etfHistorical = equityHistorical

// Index names (`sp500`, `nasdaq100`, `de_dax40`) and Yahoo's tickers, from the index/available table.
const INDEX_BY_CODE = new Map(indexTable.map(([symbol, , code]) => [code!.toLowerCase(), symbol!]))
const INDEX_SYMBOLS = new Map(indexTable.map(([symbol]) => [symbol!.toUpperCase(), symbol!]))

/** index/available: the table of indices (symbol, name, code) the index routes know by name. */
export async function indexAvailable(): Promise<Row[]> {
  return indexTable.map(([symbol, name, code]) => ({ symbol, name, code }))
}

/** A name from the index table, a Yahoo ticker as it is, any other name as the `^` ticker. */
export function indexSymbol(input: string): string {
  const s = input.trim()
  const byCode = INDEX_BY_CODE.get(s.toLowerCase())
  if (byCode) return byCode
  const known = INDEX_SYMBOLS.get(s.toUpperCase())
  if (known) return known
  const upper = s.toUpperCase()
  return upper.startsWith('^') || upper.includes('.') ? upper : `^${upper}`
}

export async function indexHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = intervalOf(params)
  const { start, end } = windowOf(params, interval, ctx)
  const symbols = [...new Set(symbolsOf(params).map(indexSymbol))]
  // Yahoo's index hours include the closing print at 16:00, which only comes with the extended session.
  return manySymbols(symbols, (symbol) => priceHistory(ctx, symbol, { interval, start, end, prepost: true }))
}

/** `BTCUSD` is Yahoo's `BTC-USD`. */
export function cryptoSymbol(input: string): string {
  const s = input.trim().toUpperCase()
  return s.includes('-') || s.length <= 3 ? s : `${s.slice(0, -3)}-${s.slice(-3)}`
}

export async function cryptoHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = intervalOf(params)
  const { start, end } = windowOf(params, interval, ctx)
  const symbols = [...new Set(symbolsOf(params).map(cryptoSymbol))]
  return manySymbols(symbols, (symbol) => priceHistory(ctx, symbol, { interval, start, end }))
}

/** `EURUSD` is Yahoo's `EURUSD=X`. */
export function currencySymbol(input: string): string {
  const s = input.trim().toUpperCase()
  return s.endsWith('=X') ? s : `${s}=X`
}

export async function currencyHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = intervalOf(params)
  const { start, end } = windowOf(params, interval, ctx)
  const symbols = [...new Set(symbolsOf(params).map(currencySymbol))]
  return manySymbols(symbols, (symbol) => priceHistory(ctx, symbol, { interval, start, end }))
}

const MONTH_CODES = 'FGHJKMNQUVXZ'

/**
 * A futures root and an expiration ("YYYY-MM") as Yahoo's contract ticker, `CLZ26.NYM`: the month's letter, the
 * two-digit year and the exchange that lists the root's continuous contract (`CL=F`).
 */
export async function futuresContract(ctx: NativeCtx, root: string, expiration: string): Promise<string | undefined> {
  const m = /^(\d{4})-(\d{2})$/.exec(expiration)
  if (!m) throw new NativeUnsupported(`futures expiration must be YYYY-MM, got ${expiration}`)
  const month = Number(m[2])
  if (month < 1 || month > 12) throw new NativeUnsupported(`futures expiration must be YYYY-MM, got ${expiration}`)
  const today = dayStart(todayNy(ctx))
  const chart = await fetchChart(ctx, `${root}=F`, { interval: '1d', period1: today - 5 * 86_400, period2: today + 86_400 })
  const exchange = chart?.meta.exchangeName
  if (typeof exchange !== 'string' || !exchange) return undefined
  return `${root}${MONTH_CODES[month - 1]}${m[1]!.slice(2)}.${exchange}`
}

export async function futuresHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = intervalOf(params)
  const { start, end } = windowOf(params, interval, ctx)
  const expiration = typeof params.expiration === 'string' && params.expiration ? params.expiration : undefined
  const symbols = symbolsOf(params)
  const resolved = new Map<string, string>()
  for (const symbol of symbols) {
    if (symbol.includes('=') || symbol.includes('.')) resolved.set(symbol, symbol)
    else if (expiration) {
      const contract = await futuresContract(ctx, symbol, expiration)
      if (contract) resolved.set(symbol, contract)
    } else resolved.set(symbol, `${symbol}=F`)
  }
  return manySymbols(
    symbols.filter((s) => resolved.has(s)),
    (symbol) => priceHistory(ctx, resolved.get(symbol)!, { interval, start, end, datetimes: true }),
    (symbol) => resolved.get(symbol)!,
    symbols.length > 1,
  )
}

/** Funds are priced like equities, without dividend and split columns, and only at daily and coarser intervals. */
export async function fundsHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = intervalOf(params)
  if (isIntraday(interval)) throw new NativeUnsupported(`funds have no ${interval} interval`)
  const { start, end } = windowOf(params, interval, ctx)
  return manySymbols(symbolsOf(params), (symbol) => priceHistory(ctx, symbol, { interval, start, end }))
}
