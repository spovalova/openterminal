// The Deribit options strategy commands that price one structure per expiration (deribit/options/straddle, strangle
// and spreads) and the chain loading they and the optimizer share. Ported from openbb_deribit/routers/options.py
// (_chain_or_404, straddle, strangle, spreads) and openbb_deribit/utils/options/strategies.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: the chain comes from ./chain.ts, rows are plain objects, and a value pandas would leave
// missing (NaN) is left out of the row.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { expirations, loadChain, quotesAt, underlyingPrice, type Contract, type Quote } from './chain.js'

/** `_chain_or_404`: the chain and its spot, or the 404 the router answers when the exchange lists no options. */
export async function chainOr404(ctx: NativeCtx, symbol: string): Promise<{ frame: Contract[]; spot: number }> {
  try {
    const frame = await loadChain(ctx, symbol)
    return { frame, spot: underlyingPrice(frame) }
  } catch (error) {
    throw new Error(`Deribit lists no options on ${symbol}.`, { cause: error })
  }
}

/** A result row without the cells pandas holds as NaN or None. */
function row(cells: Row): Row {
  return Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))))
}

/** `_closest`: the contract whose strike is nearest a price (the first, so the lower strike, on a tie). */
function closest(side: Quote[], target: number): Quote | undefined {
  let best: Quote | undefined
  for (const q of side) if (best === undefined || Math.abs(q.strike - target) < Math.abs(best.strike - target)) best = q
  return best
}

const sides = (quotes: Quote[]): { calls: Quote[]; puts: Quote[] } => ({ calls: quotes.filter((q) => q.option_type === 'call'), puts: quotes.filter((q) => q.option_type === 'put') })

const symbolOf = (params: NativeParams): string => String(params.symbol ?? 'BTC')

const moneynessOf = (params: NativeParams): number => {
  const v = params.moneyness
  return Math.abs(v === undefined || v === null || v === '' ? 5.0 : Number(v)) / 100
}

/** `straddles`: a long straddle at the money, at every expiration. */
export function straddles(frame: Contract[], spot: number): Row[] {
  const priced: Row[] = []
  for (const expiration of expirations(frame)) {
    const { calls, puts } = sides(quotesAt(frame, expiration))
    const call = closest(calls, spot)
    const put = closest(puts, spot)
    if (!call || !put) continue
    if (call.strike !== put.strike) continue
    const strike = call.strike
    const cost = call.entry + put.entry
    priced.push(
      row({
        expiration,
        dte: Math.trunc(call.dte || 0),
        underlying_price: spot,
        strike,
        call_premium: call.entry,
        put_premium: put.entry,
        cost,
        cost_percent: spot ? cost / spot : null,
        breakeven_lower: strike - cost,
        breakeven_upper: strike + cost,
        max_loss: -cost,
      }),
    )
  }
  return priced
}

/** `strangles`: a long strangle the given fraction out of the money. */
export function strangles(frame: Contract[], spot: number, moneyness: number): Row[] {
  const priced: Row[] = []
  for (const expiration of expirations(frame)) {
    const { calls, puts } = sides(quotesAt(frame, expiration))
    const call = closest(calls, spot * (1 + moneyness))
    const put = closest(puts, spot * (1 - moneyness))
    if (!call || !put) continue
    const upper = call.strike
    const lower = put.strike
    if (upper <= lower) continue
    const cost = call.entry + put.entry
    priced.push(
      row({
        expiration,
        dte: Math.trunc(call.dte || 0),
        underlying_price: spot,
        call_strike: upper,
        put_strike: lower,
        call_premium: call.entry,
        put_premium: put.entry,
        cost,
        cost_percent: spot ? cost / spot : null,
        breakeven_lower: lower - cost,
        breakeven_upper: upper + cost,
        max_loss: -cost,
      }),
    )
  }
  return priced
}

/** `verticals`: a bull call and a bear put spread of the given width. */
export function verticals(frame: Contract[], spot: number, moneyness: number): Row[] {
  const priced: Row[] = []
  for (const expiration of expirations(frame)) {
    const { calls, puts } = sides(quotesAt(frame, expiration))
    const specs: [string, Quote[], number, number][] = [
      ['Bull Call Spread', calls, spot, spot * (1 + moneyness)],
      ['Bear Put Spread', puts, spot, spot * (1 - moneyness)],
    ]
    for (const [name, side, longTarget, shortTarget] of specs) {
      const bought = closest(side, longTarget)
      const sold = closest(side, shortTarget)
      if (!bought || !sold) continue
      const width = Math.abs(sold.strike - bought.strike)
      const cost = bought.entry - sold.exit
      if (width <= 0 || cost <= 0) continue
      const breakeven = name.startsWith('Bull') ? bought.strike + cost : bought.strike - cost
      priced.push(
        row({
          strategy: name,
          expiration,
          dte: Math.trunc(bought.dte || 0),
          underlying_price: spot,
          bought_strike: bought.strike,
          sold_strike: sold.strike,
          bought_premium: bought.entry,
          sold_premium: sold.exit,
          cost,
          cost_percent: spot ? cost / spot : null,
          breakeven,
          max_profit: width - cost,
          max_loss: -cost,
        }),
      )
    }
  }
  return priced
}

// deribit/options/straddle (command, no provider). Ported from openbb_deribit/routers/options.py (straddle) and
// utils/options/strategies.py (straddles); modified: see the top of the file.
export async function optionsStraddle(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { frame, spot } = await chainOr404(ctx, symbolOf(params))
  return straddles(frame, spot)
}

// deribit/options/strangle (command, no provider). Ported from openbb_deribit/routers/options.py (strangle) and
// utils/options/strategies.py (strangles); modified: see the top of the file.
export async function optionsStrangle(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { frame, spot } = await chainOr404(ctx, symbolOf(params))
  return strangles(frame, spot, moneynessOf(params))
}

// deribit/options/spreads (command, no provider). Ported from openbb_deribit/routers/options.py (spreads) and
// utils/options/strategies.py (verticals); modified: see the top of the file.
export async function optionsSpreads(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { frame, spot } = await chainOr404(ctx, symbolOf(params))
  return verticals(frame, spot, moneynessOf(params))
}
