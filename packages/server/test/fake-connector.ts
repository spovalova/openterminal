// A connector that answers every kind from memory. No network.
import { z } from 'zod'
import { defineConnector, toFrame, type Connector } from '@terminal/core'

export function fakeConnector(opts: { name?: string; calls?: { kind: string; params: unknown }[] } = {}): Connector {
  const calls = opts.calls
  return defineConnector({
    name: opts.name ?? 'fake',
    config: z.object({}),
    queries: {
      search: async (p) => {
        calls?.push({ kind: 'search', params: p })
        return toFrame('search', p.q.map((q) => ({ query: q, symbol: q.toUpperCase(), name: `${q} Inc`, exchange: 'NMS' })))
      },
      quote: async (p) => {
        calls?.push({ kind: 'quote', params: p })
        return toFrame('quote', p.symbols.map((symbol, i) => ({ symbol, price: 100 + i, change_pct: 1.5, volume: 1000, market_state: 'REGULAR', extended_price: null, extended_change_pct: null })))
      },
      ohlcv: async (p) => {
        calls?.push({ kind: 'ohlcv', params: p })
        const rows = p.symbols.flatMap((symbol) => [0, 1, 2].map((i) => ({ symbol, time: 1_700_000_000_000 + i * 86_400_000, open: 10, high: 11, low: 9, close: 10 + i, volume: 100 })))
        return toFrame('ohlcv', rows)
      },
      news: async (p) => {
        calls?.push({ kind: 'news', params: p })
        return toFrame('news', [{ time: 1_700_000_000_000, headline: 'HBM demand', source: 'wire', url: 'https://example.com/1', symbol: p.symbols[0] }])
      },
      earnings: async (p) => {
        calls?.push({ kind: 'earnings', params: p })
        return toFrame('earnings', p.symbols.map((symbol) => ({ symbol, date: p.from, session: 'amc', eps_estimate: 1.23 })))
      },
    },
  })
}
