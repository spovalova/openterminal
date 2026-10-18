import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryResult, YahooClient } from './client.js'
import { pct, str } from './values.js'

/** The fund's top holdings as Yahoo lists them (ten, largest first). Undefined when the symbol is not a fund. */
export function holdingRows(etf: string, r: QuoteSummaryResult): Record<string, unknown>[] | undefined {
  const list = r.topHoldings?.holdings
  if (!list) return undefined
  return list.map((h) => ({ etf, symbol: str(h.symbol), name: str(h.holdingName), weight: pct(h.holdingPercent) }))
}

export function makeHoldings(client: () => YahooClient) {
  return async (params: KindParams<'holdings'>, _ctx: Ctx<unknown>): Promise<Frame> => {
    const etf = params.symbol.trim().toUpperCase()
    const rows = holdingRows(etf, await client().quoteSummary(etf, { modules: ['topHoldings'] }))
    if (!rows) throw new Error(`holdings: ${etf} has no holdings on Yahoo (not a fund?)`)
    // Yahoo's topHoldings is only ever the top ten, so the frame is at most ten rows.
    return toFrame('holdings', rows, { connector: 'yahoo' })
  }
}
