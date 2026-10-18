import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { OptionsResult, YahooClient } from './client.js'
import { nyDate, utcDate } from './time.js'
import { num, pct } from './values.js'

type Chain = OptionsResult['options'][number]
type Contract = Chain['calls'][number]

/** Whole days from one YYYY-MM-DD to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * The catalog's expiration rule over Yahoo's listed dates (00:00Z stamps, ascending): a requested date snaps
 * to the first listed expiration on or after it; omitted means the nearest at least 7 days out, else the
 * nearest at least 1 day out. Undefined when nothing qualifies.
 */
export function pickExpiration(listed: Date[], today: string, requested?: string): Date | undefined {
  const dates = [...listed].sort((a, b) => a.getTime() - b.getTime())
  if (requested !== undefined) return dates.find((d) => utcDate(d) >= requested)
  return dates.find((d) => daysBetween(today, utcDate(d)) >= 7) ?? dates.find((d) => daysBetween(today, utcDate(d)) >= 1)
}

/** The `n` listed strikes below the price and the `n` at or above it, from the union of call and put strikes. */
export function strikeWindow(chain: Chain, price: number, n: number): Set<number> {
  const strikes = [...new Set([...chain.calls, ...chain.puts].map((c) => c.strike))].sort((a, b) => a - b)
  return new Set([...strikes.filter((s) => s < price).slice(-n), ...strikes.filter((s) => s >= price).slice(0, n)])
}

/** Rows for one chain: the strike window, filtered by type, sorted by strike then call before put. Yahoo has no greeks; iv is percent. */
export function chainRows(symbol: string, chain: Chain, price: number, params: Pick<KindParams<'options'>, 'strikes' | 'type'>, today: string): Record<string, unknown>[] {
  const expiration = utcDate(chain.expirationDate)
  const dte = daysBetween(today, expiration)
  const keep = strikeWindow(chain, price, params.strikes)
  const row = (type: 'call' | 'put', c: Contract) => ({
    symbol,
    expiration,
    type,
    strike: c.strike,
    bid: num(c.bid),
    ask: num(c.ask),
    last: num(c.lastPrice),
    volume: num(c.volume),
    open_interest: num(c.openInterest),
    iv: pct(c.impliedVolatility),
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    underlying_price: price,
    dte,
  })
  const rows: ReturnType<typeof row>[] = []
  if (params.type !== 'put') for (const c of chain.calls) if (keep.has(c.strike)) rows.push(row('call', c))
  if (params.type !== 'call') for (const c of chain.puts) if (keep.has(c.strike)) rows.push(row('put', c))
  return rows.sort((a, b) => a.strike - b.strike || (a.type === b.type ? 0 : a.type === 'call' ? -1 : 1))
}

export function makeOptions(client: () => YahooClient, now: () => Date) {
  return async (params: KindParams<'options'>, _ctx: Ctx<unknown>): Promise<Frame> => {
    const symbol = params.symbol.trim().toUpperCase()
    const today = nyDate(now())
    // The first call lists every expiration and carries the nearest chain; a second call is needed only for another date.
    const first = await client().options(symbol, {})
    if (first.expirationDates.length === 0) throw new Error(`options: ${symbol} has no listed options on Yahoo`)
    const expiration = pickExpiration(first.expirationDates, today, params.expiration)
    if (!expiration) {
      throw new Error(params.expiration ? `options: ${symbol} has no expiration on or after ${params.expiration}` : `options: ${symbol} has no upcoming expiration`)
    }
    const wanted = utcDate(expiration)
    let result = first
    let chain = first.options.find((o) => utcDate(o.expirationDate) === wanted)
    if (!chain) {
      result = await client().options(symbol, { date: expiration })
      chain = result.options.find((o) => utcDate(o.expirationDate) === wanted)
      if (!chain) throw new Error(`options: Yahoo returned no chain for ${symbol} ${wanted}`)
    }
    if (chain.calls.length === 0 && chain.puts.length === 0) throw new Error(`options: Yahoo returned no contracts for ${symbol} ${wanted}`)
    const price = num(result.quote?.regularMarketPrice) ?? num(first.quote?.regularMarketPrice)
    if (price === null) throw new Error(`options: no underlying price for ${symbol} in Yahoo's response`)
    return toFrame('options', chainRows(symbol, chain, price, params, today), { connector: 'yahoo' })
  }
}
