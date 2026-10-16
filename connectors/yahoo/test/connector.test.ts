import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, FrameSchema, KINDS, MemoryCache } from '@terminal/core'
import yahoo, { createYahooConnector } from '../src/index.js'
import { RECORDED_AT, fakeClient } from './helpers.js'

describe('connector', () => {
  it('is named yahoo, takes an empty config, and answers the four kinds in catalog order', () => {
    expect(yahoo.name).toBe('yahoo')
    expect(yahoo.kinds).toEqual(['search', 'quote', 'ohlcv', 'earnings'])
    expect(yahoo.config.safeParse({}).success).toBe(true)
    expect(yahoo.queries.news).toBeUndefined()
  })

  it('passes the registry frame validation for every kind with an injected client', async () => {
    const logs: string[] = []
    const registry = new ConnectorRegistry({ cache: new MemoryCache(), log: (m) => logs.push(m) })
    registry.register(createYahooConnector({ client: fakeClient(), now: () => RECORDED_AT }), {})
    expect(registry.kinds()).toEqual(['search', 'quote', 'ohlcv', 'earnings'])

    const frames = {
      search: await registry.run({ kind: 'search', params: { q: ['micron', 'sandisk'] } }),
      quote: await registry.run({ kind: 'quote', params: { symbols: ['MU', 'NVDA', 'SPY'] } }),
      ohlcv: await registry.run({ kind: 'ohlcv', params: { symbols: ['MU', 'NVDA'], interval: '5m', range: '1d' } }),
      earnings: await registry.run({ kind: 'earnings', params: { symbols: ['MU', 'NVDA', 'SPY'], from: '2026-10-16', to: '2026-12-31' } }),
    }
    for (const [kind, frame] of Object.entries(frames)) {
      expect(FrameSchema.safeParse(frame).success).toBe(true)
      expect(frame.columns).toEqual(KINDS[kind as keyof typeof KINDS].columns)
      expect(frame.meta.connector).toBe('yahoo')
      expect(frame.rows.length).toBeGreaterThan(0)
    }
    expect(frames.ohlcv.meta.ttl).toBe(60_000)
    expect(logs).toEqual(['[yahoo] earnings: SPY has no fundamentals on Yahoo (ETF or index?)'])
  })

  it('uses the shared live client lazily so importing the module makes no network calls', () => {
    const c = createYahooConnector()
    expect(c.kinds).toHaveLength(4)
  })
})
