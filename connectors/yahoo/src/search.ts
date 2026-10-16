import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { YahooClient, SearchResult } from './client.js'
import { fanOut } from './fanout.js'

/** Yahoo exchange codes for US listings: Nasdaq (GS, GM, CM), NYSE, NYSE Arca, NYSE American, Cboe BZX. */
export const US_EXCHANGES: ReadonlySet<string> = new Set(['NMS', 'NGM', 'NCM', 'NYQ', 'PCX', 'ASE', 'BTS'])

type Hit = SearchResult['quotes'][number]

/** First Yahoo Finance equity or ETF on a US exchange, or undefined. */
export function pickHit(quotes: SearchResult['quotes']): Extract<Hit, { isYahooFinance: true }> | undefined {
  for (const q of quotes) {
    if (!q.isYahooFinance) continue
    if (q.quoteType !== 'EQUITY' && q.quoteType !== 'ETF') continue
    if (!US_EXCHANGES.has(q.exchange)) continue
    return q
  }
  return undefined
}

export function searchRow(term: string, result: SearchResult): Record<string, unknown> {
  const hit = pickHit(result.quotes)
  if (!hit) return { query: term, symbol: null, name: null, exchange: null }
  return {
    query: term,
    symbol: hit.symbol,
    name: hit.longname ?? hit.shortname ?? null,
    exchange: hit.exchDisp ?? hit.exchange,
  }
}

export function makeSearch(client: () => YahooClient) {
  return async (params: KindParams<'search'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const terms = params.q.map((t) => t.trim()).filter(Boolean)
    const rows = await fanOut(
      terms,
      async (term) => searchRow(term, await client().search(term, { quotesCount: 10, newsCount: 0 })),
      { ctx, kind: 'search', label: (t) => JSON.stringify(t) },
    )
    return toFrame('search', rows, { connector: 'yahoo' })
  }
}
