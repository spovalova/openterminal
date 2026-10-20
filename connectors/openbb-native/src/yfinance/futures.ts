// derivatives/futures/curve, provider yfinance. Independent implementation of OpenBB's output for this route (not
// derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { priceHistory } from './chart.js'
import { pyRound, symbolsOf } from './helpers.js'
import { quoteSummary, v7Quote } from './quote.js'

const BATCH = 50
const PARALLEL = 4
const MONTH_CODES = 'FGHJKMNQUVXZ'

/** Month ("YYYY-MM") of a contract ticker such as `CLZ26.NYM`. */
export function contractMonth(symbol: string): string | undefined {
  const m = /^[A-Z0-9]+?([FGHJKMNQUVXZ])(\d{2})\.[A-Z]+$/.exec(symbol)
  return m ? `20${m[2]}-${String(MONTH_CODES.indexOf(m[1]!) + 1).padStart(2, '0')}` : undefined
}

/**
 * The futures curve of a root symbol: each contract in Yahoo's futures chain for `ROOT=F` with its last price, or
 * with its close on `date`. A contract Yahoo has no price for is left out.
 */
export async function futuresCurve(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const root = symbolsOf(params)[0]
  if (!root) return []
  const date = typeof params.date === 'string' && params.date ? params.date : undefined
  const chain = (await quoteSummary(ctx, `${root}=F`, ['futuresChain']))?.futuresChain as { futures?: string[] } | undefined
  const contracts = (chain?.futures ?? []).filter((c) => contractMonth(c) !== undefined)

  if (!date) {
    // The price is the middle of the bid and the ask, to the cent; a contract without both quotes shows its previous close.
    const prices = new Map<string, number>()
    for (let i = 0; i < contracts.length; i += BATCH) {
      for (const [symbol, quote] of await v7Quote(ctx, contracts.slice(i, i + BATCH))) {
        const { bid, ask, regularMarketPreviousClose } = quote
        const price = typeof bid === 'number' && typeof ask === 'number' ? pyRound((bid + ask) / 2, 2) : regularMarketPreviousClose
        if (typeof price === 'number') prices.set(symbol, price)
      }
    }
    return contracts.flatMap((c): Row[] => (prices.has(c) ? [{ expiration: contractMonth(c), price: prices.get(c) }] : []))
  }

  // A date asks for each contract's close that day, one chart a contract.
  const rows: (Row | undefined)[] = new Array(contracts.length)
  let next = 0
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < contracts.length) {
        const i = next++
        const bars = await priceHistory(ctx, contracts[i]!, { interval: '1d', start: date, end: date })
        const close = bars.find((b) => b.date === date)?.close
        if (typeof close === 'number') rows[i] = { date, expiration: contractMonth(contracts[i]!), price: close }
      }
    }),
  )
  return rows.filter((r): r is Row => r !== undefined)
}
