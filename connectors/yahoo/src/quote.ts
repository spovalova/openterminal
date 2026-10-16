import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { Quote, YahooClient } from './client.js'
import { normalizeSymbols } from './fanout.js'

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** One quote row. Pre-market fields win when both sessions are present (Yahoo only sends the live one). */
export function quoteRow(q: Quote): Record<string, unknown> {
  return {
    symbol: q.symbol,
    price: num(q.regularMarketPrice),
    change_pct: num(q.regularMarketChangePercent),
    volume: num(q.regularMarketVolume),
    market_state: q.marketState ?? null,
    extended_price: num(q.preMarketPrice) ?? num(q.postMarketPrice),
    extended_change_pct: num(q.preMarketChangePercent) ?? num(q.postMarketChangePercent),
  }
}

export function makeQuote(client: () => YahooClient) {
  return async (params: KindParams<'quote'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const quotes = await client().quote(symbols)
    const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]))
    const rows: Record<string, unknown>[] = []
    for (const s of symbols) {
      const q = bySymbol.get(s)
      if (q) rows.push(quoteRow(q))
      else ctx.log(`quote: skipped ${s}: not in Yahoo response (unknown or delisted symbol)`)
    }
    if (rows.length === 0) throw new Error(`quote: Yahoo returned no quotes for ${symbols.join(', ')}`)
    return toFrame('quote', rows, { connector: 'yahoo' })
  }
}
