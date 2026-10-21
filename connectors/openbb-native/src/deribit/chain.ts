// The option chain the Deribit analysis commands read. Ported from openbb_deribit/utils/options/chain.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: no process-wide memo of the last read (OpenBB holds a chain for two minutes),
// rows are plain objects instead of a DataFrame, and the modelled greeks, which no strategy command reads, are left
// out. A column OpenBB's frame fills with None (float NaN once any value is a number) is NaN here.
import { NativeUnsupported, type NativeCtx, type Row } from '../types.js'
import { isRecord, request } from './client.js'
import { getInstruments } from './helpers.js'

const SECONDS_PER_YEAR = 365 * 86400
const DAY_MS = 86_400_000

/** One quoted contract, in the quote currency of the underlying (an inverse contract's coin prices carried at the index level). */
export type Contract = {
  contract_symbol: string
  /** ISO date of the expiration (UTC). */
  expiration: string
  dte: number
  strike: number
  option_type: string
  contract_size: number
  tick_size: number
  is_inverse: boolean
  mark: number
  bid: number
  ask: number
  /** The exchange's mark volatility in percent; null when no contract has one. */
  implied_volatility: number | null
  underlying_spot_price: number
}

/** A contract as `quotes_at` leaves it: with the price it is entered and left at. */
export type Quote = Contract & { entry: number; exit: number }

/** A listed combo book: its legs as (instrument, amount) pairs and its bid and ask. */
export type ComboBook = { name: string; legs: [string, number][]; bid: number | null; ask: number | null }

/** The currency a root's options are collateralised in (`settlement_of`). */
export const settlementOf = (root: string): string => (root === 'BTC' || root === 'ETH' ? root : 'USDC')

/** `float(x or default)`: Python's truthiness, where 0, None and '' fall back. */
const floatOr = (v: unknown, fallback: number): number => (v ? Number(v) : fallback)

/** `_rows`: one contract per quoted instrument. */
function rowsOf(quotes: Row[], specs: Map<string, Row>, spot: number, nowMs: number): Contract[] {
  const now = nowMs / 1000
  const volatilities = quotes.map((q) => (q.mark_iv === null || q.mark_iv === undefined ? NaN : Number(q.mark_iv)))
  // pandas: a column of nothing but None stays None; one with any number holds NaN where the others are None.
  const noVolatility = volatilities.every((v) => Number.isNaN(v))
  return quotes.map((quote, i) => {
    const name = String(quote.instrument_name)
    const spec = specs.get(name)!
    const inverse = String(spec.instrument_type) === 'reversed'
    const carry = inverse ? spot : 1.0
    const years = (Number(spec.expiration_timestamp) / 1000 - now) / SECONDS_PER_YEAR
    const carried = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v) * carry)
    return {
      contract_symbol: name,
      expiration: new Date(Number(spec.expiration_timestamp)).toISOString().slice(0, 10),
      dte: Math.max(Math.trunc(years * 365), 0),
      strike: Number(spec.strike),
      option_type: String(spec.option_type),
      contract_size: floatOr(spec.contract_size, 1),
      tick_size: carried(spec.tick_size),
      is_inverse: inverse,
      mark: carried(quote.mark_price),
      bid: carried(quote.bid_price),
      ask: carried(quote.ask_price),
      implied_volatility: noVolatility ? null : volatilities[i]!,
      underlying_spot_price: spot,
    }
  })
}

/** The chain of one underlying (`load_chain`); throws where OpenBB raises EmptyDataError or the request fails. */
export async function loadChain(ctx: NativeCtx, symbol: string): Promise<Contract[]> {
  const root = symbol.toUpperCase()
  const currency = settlementOf(root)
  const [summary, instruments] = await Promise.all([request<Row[]>(ctx, 'get_book_summary_by_currency', { currency, kind: 'option' }), getInstruments(ctx, currency, 'option')])
  const specs = new Map(instruments.filter((s) => String(s.instrument_name).split('-')[0] === root).map((s) => [String(s.instrument_name), s]))
  const quotes = (summary ?? []).filter((q) => specs.has(String(q.instrument_name)))
  const index = specs.size ? specs.values().next().value!.price_index : undefined
  const level = index ? await request<Row>(ctx, 'get_index_price', { index_name: String(index) }) : {}
  const spot = Number((isRecord(level) ? level.index_price : undefined) || 0)
  const frame = rowsOf(quotes, specs, spot, ctx.now().getTime())
  if (frame.length === 0) throw new Error(`Deribit published no option quotes for ${root}.`)
  return frame
}

/** `load_combos`: the combo books listed on an underlying's options, with their quotes. */
export async function loadCombos(ctx: NativeCtx, symbol: string): Promise<ComboBook[]> {
  const root = symbol.toUpperCase()
  const currency = settlementOf(root)
  const [listed, quoted] = await Promise.all([request<Row[]>(ctx, 'get_combos', { currency }), request<Row[]>(ctx, 'get_book_summary_by_currency', { currency, kind: 'option_combo' })])
  const quotes = new Map((quoted ?? []).map((row) => [String(row.instrument_name), row]))
  const books: ComboBook[] = []
  for (const combo of listed ?? []) {
    const legs = (combo.legs as Row[]).map((leg): [string, number] => [String(leg.instrument_name), Math.trunc(Number(leg.amount))])
    if (!legs.every(([name]) => name.split('-')[0] === root && name.split('-').length === 4)) continue
    const quote = quotes.get(String(combo.id)) ?? {}
    books.push({ name: String(combo.id), legs, bid: (quote.bid_price as number | null | undefined) ?? null, ask: (quote.ask_price as number | null | undefined) ?? null })
  }
  return books
}

/** `underlying_price`: the spot the chain was quoted against. */
export const underlyingPrice = (frame: Contract[]): number => frame.find((c) => !Number.isNaN(c.underlying_spot_price))?.underlying_spot_price ?? 0

/** `is_inverse`: whether the chain's contracts settle in the underlying. */
export const isInverse = (frame: Contract[]): boolean => frame.some((c) => c.is_inverse)

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `expirations`: every expiration on the chain, nearest first. */
export const expirations = (frame: Contract[]): string[] => [...new Set(frame.map((c) => c.expiration))].sort(compareText)

/** The day number of an ISO date. */
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS

/** `nearest_expiration`: the listed expiration closest to a date (`pandas.to_datetime(target).date()`), the earlier one on a tie. */
export function nearestExpiration(frame: Contract[], target: string): string {
  const wanted = dayNumber(target)
  let best: string | undefined
  for (const day of expirations(frame)) if (best === undefined || Math.abs(dayNumber(day) - wanted) < Math.abs(dayNumber(best) - wanted)) best = day
  return best!
}

/** The date part of an ISO date or datetime (`pandas.to_datetime(text).date()`); any other spelling pandas would read is left to the API. */
export function parseDate(text: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(text.trim())
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) throw new NativeUnsupported(`target_date ${text}: only YYYY-MM-DD is read natively`)
  return m[1]!
}

/** `far_expiration`: the later expiration closest to `gap` days past `near`, or undefined when nothing is later. */
export function farExpiration(frame: Contract[], near: string, gap = 30): string | undefined {
  const later = expirations(frame).filter((day) => day > near)
  let best: string | undefined
  for (const day of later) {
    if (best === undefined || Math.abs(dayNumber(day) - dayNumber(near) - gap) < Math.abs(dayNumber(best) - dayNumber(near) - gap)) best = day
  }
  return best
}

/**
 * `quotes_at`: the tradeable contracts of one expiration (all of them without one), entered at no less than one tick,
 * calls then puts by strike. The entry is the ask, or the mark when there is no ask, floored at the tick; the exit is the
 * bid, or the mark when there is no bid.
 */
export function quotesAt(frame: Contract[], expiration?: string): Quote[] {
  const at = expiration === undefined ? frame : frame.filter((c) => c.expiration === expiration)
  const quotes: Quote[] = []
  for (const c of at) {
    const entry = c.ask > 0 ? c.ask : c.mark
    const tick = Number.isNaN(c.tick_size) ? 0 : c.tick_size
    // Series.combine(…, max) takes Python's builtin max (the first unless the second is greater); where(entry > 0, 0.0)
    const floored = entry > 0 ? (tick > entry ? tick : entry) : 0.0
    const exit = c.bid > 0 ? c.bid : c.mark
    if (floored > 0) quotes.push({ ...c, entry: floored, exit })
  }
  // sort_values(["option_type", "strike"]): lexsort, stable.
  return quotes.sort((a, b) => compareText(a.option_type, b.option_type) || a.strike - b.strike)
}
