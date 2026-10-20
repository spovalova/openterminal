// deribit/market/{book_summary,order_book,ticker,trades,trade_volumes,block_rfq_trades,settlements}, provider
// deribit. Ported from openbb_deribit/models/{book_summary,order_book,ticker,trades,trade_volumes,block_rfq_trades,
// settlements}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fromTimestamp, gather, isRecord, request, toTimestamp } from './client.js'
import {
  BLOCK_RFQ_MAX_COUNT,
  BLOCK_RFQ_MIN_COUNT,
  flattenTicker,
  MAX_SETTLEMENT_COUNT,
  MAX_TRADE_COUNT,
  normalizeCurrency,
  ORDER_BOOK_DEPTHS,
  rejectOptionsBySettlement,
  resolveSymbols,
  ROUTED_SPOT_ERROR,
} from './helpers.js'
import { asPercent, by, items, pyStr, shape } from './model.js'

const optional = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))
const timestamp = (v: unknown): unknown => (v ? fromTimestamp(v) : null)
const records = (results: unknown[]): Row[] => results.filter((r): r is Row => isRecord(r) && Object.keys(r).length > 0)

/** Checks a number against the range the model gives it (`Field(ge=, le=)`). */
function bounded(name: string, value: unknown, fallback: number, ge: number, le = Number.POSITIVE_INFINITY): number {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(n) || n < ge || n > le) throw new Error(`Input should be ${le === Number.POSITIVE_INFINITY ? `greater than or equal to ${ge}` : `between ${ge} and ${le}`}: ${name}=${String(value)}`)
  return n
}

// ---------------------------------------------------------------------------------------------------------------

const BOOK_SUMMARY_ALIASES = { symbol: 'instrument_name', last_price: 'last', bid: 'bid_price', ask: 'ask_price', mid: 'mid_price', change_percent: 'price_change', implied_volatility: 'mark_iv', timestamp: 'creation_timestamp' }
const RATES = { current_funding: asPercent, funding_8h: asPercent, interest_rate: asPercent }

/** deribit/market/book_summary. */
export async function bookSummary(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currency = String(params.currency ?? 'BTC')
  const kind = optional(params.kind)
  const wanted = items(params.symbol)
  if (wanted.length === 0) rejectOptionsBySettlement(currency, kind)

  let data: Row[]
  if (wanted.length > 0) {
    const { resolved } = await resolveSymbols(ctx, params.symbol)
    const results = await gather(ctx, resolved.map((s) => ['get_book_summary_by_instrument', { instrument_name: s }]))
    data = results.filter(Array.isArray).flat()
  } else data = await request<Row[]>(ctx, 'get_book_summary_by_currency', { currency: currency.toUpperCase(), kind })
  if (!data || data.length === 0) throw new Error('Deribit published no summary for the query.')

  return [...data].sort(by((d) => pyStr(d.instrument_name))).map((r) => shape(r, BOOK_SUMMARY_ALIASES, { timestamp, ...RATES }))
}

/** deribit/market/order_book. */
export async function orderBook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const depth = params.depth === undefined ? 10 : Number(params.depth)
  if (!ORDER_BOOK_DEPTHS.includes(depth)) throw new Error(`Deribit returns a book ${ORDER_BOOK_DEPTHS.join(', ')} levels deep, not ${depth}.`)
  const symbol = items(params.symbol)
  const instrumentId = params.instrument_id === undefined || params.instrument_id === '' ? undefined : Number(params.instrument_id)
  if (symbol.length === 0 && instrumentId === undefined) throw new Error('Give either a symbol or an instrument ID.')

  let calls: [string, Record<string, string | number>][]
  if (symbol.length > 0) {
    const { resolved } = await resolveSymbols(ctx, params.symbol)
    calls = resolved.map((s) => ['get_order_book', { instrument_name: s, depth }])
  } else calls = [['get_order_book_by_instrument_id', { instrument_id: instrumentId!, depth }]]
  const data = records(await gather(ctx, calls))
  if (data.length === 0) throw new Error('Deribit published no book for the query.')

  const rows: Row[] = []
  for (const book of data) {
    const context = { symbol: book.instrument_name, timestamp: book.timestamp, mark_price: book.mark_price, index_price: book.index_price, change_id: book.change_id }
    for (const side of ['bids', 'asks'] as const) {
      ;((book[side] as number[][] | undefined) ?? []).forEach((entry, i) => rows.push({ ...context, side: side.slice(0, -1), level: i + 1, price: entry[0], size: entry[1] }))
    }
  }
  if (rows.length === 0) throw new Error('Deribit published no resting orders for the query.')
  return rows.map((r) => shape(r, {}, { timestamp }))
}

const TICKER_ALIASES = {
  symbol: 'instrument_name',
  change_percent: 'price_change',
  implied_volatility: 'mark_iv',
  bid: 'best_bid_price',
  ask: 'best_ask_price',
  bid_size: 'best_bid_amount',
  ask_size: 'best_ask_amount',
  last_price: 'last_price',
}

/** The model of a quote, shared with derivatives/futures/info. */
export const tickerRow = (ticker: Row): Row => shape(flattenTicker(ticker), TICKER_ALIASES, { timestamp, ...RATES })

/** deribit/market/ticker. */
export async function ticker(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { resolved } = await resolveSymbols(ctx, params.symbol)
  const data = records(await gather(ctx, resolved.map((s) => ['ticker', { instrument_name: s }])))
  if (data.length === 0) throw new Error(`Deribit published no quote for ${resolved.join(', ')}.`)
  return data.map(tickerRow)
}

/** deribit/market/trades. */
export async function trades(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currency = String(params.currency ?? 'BTC')
  const kind = String(params.kind ?? 'future')
  const sorting = String(params.sorting ?? 'desc')
  const limit = bounded('limit', params.limit, 100, 1, MAX_TRADE_COUNT)
  const wanted = items(params.symbol)
  if (wanted.length === 0) rejectOptionsBySettlement(currency, kind)

  const start = params.start_date ? toTimestamp(params.start_date) : undefined
  const end = params.end_date ? toTimestamp(params.end_date) : undefined
  const timed = Boolean(start && end)
  const shared = { count: limit, sorting }

  let data: Row[]
  if (wanted.length > 0) {
    const { symbols, resolved } = await resolveSymbols(ctx, params.symbol)
    const method = timed ? 'get_last_trades_by_instrument_and_time' : 'get_last_trades_by_instrument'
    const results = await gather(ctx, resolved.map((s) => [method, { instrument_name: s, start_timestamp: start, end_timestamp: end, ...shared }]))
    data = results.filter(isRecord).flatMap((r) => (r.trades as Row[] | undefined) ?? [])
    if (data.length === 0 && results.some((r) => r instanceof Error && String(r).includes(ROUTED_SPOT_ERROR))) {
      throw new Error(`Deribit publishes no trade history for ${symbols.join(', ')}. Spot pairs it routes to Coinbase carry none.`)
    }
  } else {
    const method = timed ? 'get_last_trades_by_currency_and_time' : 'get_last_trades_by_currency'
    let result: { trades?: Row[] } | undefined
    try {
      result = await request(ctx, method, { currency: currency.toUpperCase(), kind, start_timestamp: start, end_timestamp: end, ...shared })
    } catch (error) {
      if (!String(error).includes(ROUTED_SPOT_ERROR)) throw error
      throw new Error('Deribit publishes no trade history for the spot pairs it routes to Coinbase. Read the other kinds by currency, or a specific spot pair by symbol.', { cause: error })
    }
    data = result?.trades ?? []
  }
  if (data.length === 0) throw new Error('Deribit printed no trades matching the query.')

  const sign = sorting === 'asc' ? 1 : -1
  return [...data].sort((a, b) => sign * (Number(a.timestamp || 0) - Number(b.timestamp || 0))).map((r) => shape(r, { symbol: 'instrument_name' }, { timestamp: fromTimestamp }))
}

const DAY_VOLUMES = ['futures_volume', 'calls_volume', 'puts_volume', 'spot_volume']

/** deribit/market/trade_volumes. */
export async function tradeVolumes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await request<Row[]>(ctx, 'get_trade_volumes', { extended: params.extended !== false })
  if (!data || data.length === 0) throw new Error('Deribit published no trade volumes.')
  // The busiest currencies come first: everything that traded in one currency over the last day, then its name.
  const traded = (r: Row): number => DAY_VOLUMES.reduce((sum, f) => sum + Number(r[f] || 0), 0)
  return [...data].sort(by((d) => -traded(d), (d) => pyStr(d.currency))).map((r) => shape(r))
}

/** deribit/market/block_rfq_trades. */
export async function blockRfqTrades(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = bounded('limit', params.limit, BLOCK_RFQ_MAX_COUNT, BLOCK_RFQ_MIN_COUNT, BLOCK_RFQ_MAX_COUNT)
  const result = await request<{ block_rfqs?: Row[] }>(ctx, 'get_block_rfq_trades', { currency: normalizeCurrency(String(params.currency ?? 'any')), count: limit })
  const data = result?.block_rfqs ?? []
  if (data.length === 0) throw new Error('Deribit reports no block requests traded.')

  const rows: Row[] = []
  for (const rfq of data) {
    const context = { timestamp: rfq.timestamp, rfq_id: rfq.id, combo_id: rfq.combo_id, direction: rfq.direction, amount: rfq.amount, mark_price: rfq.mark_price, index_prices: rfq.index_prices }
    const legs = (rfq.legs as Row[] | undefined)?.length ? (rfq.legs as Row[]) : [{}]
    for (const leg of legs) rows.push({ ...context, leg: leg.instrument_name, leg_direction: leg.direction, leg_price: leg.price, leg_ratio: leg.ratio })
  }
  // Newest first, ties by request id (the tuple sort, reversed).
  return rows
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0) || Number(b.rfq_id || 0) - Number(a.rfq_id || 0))
    .map((r) => shape(r, {}, { timestamp: fromTimestamp }))
}

/** deribit/market/settlements. */
export async function settlements(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = bounded('limit', params.limit, 100, 1, MAX_SETTLEMENT_COUNT)
  const shared = { type: optional(params.settlement_type), count: limit, search_start_timestamp: params.start_date ? toTimestamp(params.start_date) : undefined }

  let data: Row[]
  if (items(params.symbol).length > 0) {
    const { resolved } = await resolveSymbols(ctx, params.symbol)
    const results = await gather(ctx, resolved.map((s) => ['get_last_settlements_by_instrument', { instrument_name: s, ...shared }]))
    data = results.filter(isRecord).flatMap((r) => (r.settlements as Row[] | undefined) ?? [])
  } else {
    const result = await request<{ settlements?: Row[] }>(ctx, 'get_last_settlements_by_currency', { currency: String(params.currency ?? 'BTC').toUpperCase(), ...shared })
    data = result?.settlements ?? []
  }
  if (data.length === 0) throw new Error('Deribit reports nothing settled over the span.')

  return [...data].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).map((r) => shape(r, { symbol: 'instrument_name', settlement_type: 'type' }, { timestamp: fromTimestamp }))
}
