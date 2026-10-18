import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, FrameSchema, KINDS, MemoryCache, type Frame } from '@terminal/core'
import yahoo, { createYahooConnector } from '../src/index.js'
import { RECORDED_AT, V12_KINDS, V12_NOW, fakeClient } from './helpers.js'

const ALL_KINDS = ['search', 'quote', 'ohlcv', 'earnings', ...V12_KINDS]

describe('connector', () => {
  it('is named yahoo, takes an empty config, and answers its kinds in catalog order', () => {
    expect(yahoo.name).toBe('yahoo')
    expect(yahoo.kinds).toEqual(ALL_KINDS)
    expect(yahoo.config.safeParse({}).success).toBe(true)
    for (const kind of ['news', 'financials', 'volatility', 'calendar', 'ipos', 'movers', 'macro', 'yield_curve'] as const) expect(yahoo.queries[kind]).toBeUndefined()
  })

  it('passes the registry frame validation for every kind with an injected client', async () => {
    const logs: string[] = []
    const registry = new ConnectorRegistry({ cache: new MemoryCache(), log: (m) => logs.push(m) })
    registry.register(createYahooConnector({ client: fakeClient(), now: () => RECORDED_AT }), {})
    expect(registry.kinds()).toEqual(ALL_KINDS)

    const frames: Record<string, Frame> = {
      search: await registry.run({ kind: 'search', params: { q: ['micron', 'sandisk'] } }),
      quote: await registry.run({ kind: 'quote', params: { symbols: ['MU', 'NVDA', 'SPY'] } }),
      ohlcv: await registry.run({ kind: 'ohlcv', params: { symbols: ['MU', 'NVDA'], interval: '5m', range: '1d' } }),
      earnings: await registry.run({ kind: 'earnings', params: { symbols: ['MU', 'NVDA', 'SPY'], from: '2026-10-16', to: '2026-12-31' } }),
    }
    for (const kind of V12_KINDS) {
      const params = kind === 'options' ? { symbol: 'MU', expiration: '2026-10-26' } : kind === 'holdings' ? { symbol: 'SMH' } : { symbols: ['MU', 'NVDA'] }
      frames[kind] = await registry.run({ kind, params } as any)
    }
    for (const [kind, frame] of Object.entries(frames)) {
      expect(FrameSchema.safeParse(frame).success, kind).toBe(true)
      expect(frame.columns, kind).toEqual(KINDS[kind as keyof typeof KINDS].columns)
      expect(frame.meta.connector).toBe('yahoo')
      expect(frame.rows.length, kind).toBeGreaterThan(0)
    }
    expect(frames.ohlcv!.meta.ttl).toBe(60_000)
    expect(frames.options!.meta.ttl).toBe(60_000)
    expect(logs).toEqual(['[yahoo] earnings: SPY has no fundamentals on Yahoo (ETF or index?)'])
  })

  it('answers options against the v1.2 clock through the registry', async () => {
    const registry = new ConnectorRegistry({ cache: new MemoryCache(), log: () => {} })
    registry.register(createYahooConnector({ client: fakeClient(), now: () => V12_NOW }), {})
    const frame = await registry.run({ kind: 'options', params: { symbol: 'mu', strikes: 2 } })
    expect(frame.rows.map((r) => r[1])).toEqual(Array(frame.rows.length).fill('2026-10-26'))
  })

  it('uses the shared live client lazily so importing the module makes no network calls', () => {
    const c = createYahooConnector()
    expect(c.kinds).toHaveLength(ALL_KINDS.length)
  })
})
