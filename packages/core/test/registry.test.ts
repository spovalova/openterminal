import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ConnectorRegistry, MemoryCache, RegistryError, defineConnector, toFrame, cacheKey, parseQuery } from '../src/index.js'

const quoteRows = (symbol: string, price: number) => [{ symbol, price, change_pct: 1, volume: 1, market_state: 'REGULAR', extended_price: null, extended_change_pct: null }]

describe('defineConnector', () => {
  it('derives kinds and validates the name', () => {
    const c = defineConnector({ name: 'demo', config: z.object({}), queries: { quote: async (p) => toFrame('quote', quoteRows(p.symbols[0]!, 1)) } })
    expect(c.kinds).toEqual(['quote'])
    expect(() => defineConnector({ name: 'Bad Name', config: z.object({}), queries: { quote: async () => toFrame('quote', []) } })).toThrow()
    expect(() => defineConnector({ name: 'empty', config: z.object({}), queries: {} })).toThrow(/no kinds/)
  })
})

describe('ConnectorRegistry', () => {
  const good = defineConnector({ name: 'good', config: z.object({}), queries: { quote: async (p) => toFrame('quote', quoteRows(p.symbols[0]!, 42)) } })
  const flaky = defineConnector({
    name: 'flaky',
    config: z.object({}),
    queries: {
      quote: async () => {
        throw new Error('boom')
      },
    },
  })
  const needsKey = defineConnector({ name: 'keyed', config: z.object({ apiKey: z.string().min(1) }), queries: { news: async () => toFrame('news', []) } })
  const badShape = defineConnector({
    name: 'badshape',
    config: z.object({}),
    queries: { quote: async () => ({ columns: [{ name: 'symbol', type: 'string' as const }], rows: [['MU']], meta: { connector: 'x', fetchedAt: 0, ttl: 0 } }) },
  })

  it('routes in registration order and falls back on error', async () => {
    const log = vi.fn()
    const r = new ConnectorRegistry({ log })
    r.register(flaky, {})
    r.register(good, {})
    const f = await r.run({ kind: 'quote', params: { symbols: ['MU'] } })
    expect(f.rows[0]![1]).toBe(42)
    expect(f.meta.connector).toBe('good')
    expect(f.meta.ttl).toBe(10_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('flaky'))
  })

  it('throws a RegistryError listing every cause when all fail', async () => {
    const r = new ConnectorRegistry()
    r.register(flaky, {})
    await expect(r.run({ kind: 'quote', params: { symbols: ['MU'] } })).rejects.toBeInstanceOf(RegistryError)
    await expect(r.run({ kind: 'news', params: { symbols: ['MU'] } })).rejects.toThrow(/no connector answers/)
  })

  it('marks connectors with invalid config and excludes their kinds', () => {
    const r = new ConnectorRegistry()
    expect(r.register(needsKey, {}).status).toBe('missing_config')
    expect(r.kinds()).toEqual([])
    expect(r.register(needsKey, { apiKey: 'k' }).status).toBe('ok')
    expect(r.kinds()).toEqual(['news'])
    expect(r.connectors()).toHaveLength(1)
  })

  it('rejects frames whose columns do not match the catalog', async () => {
    const r = new ConnectorRegistry()
    r.register(badShape, {})
    await expect(r.run({ kind: 'quote', params: { symbols: ['MU'] } })).rejects.toThrow(/do not match catalog/)
  })

  it('rejects invalid queries before touching connectors', async () => {
    const r = new ConnectorRegistry()
    r.register(good, {})
    await expect(r.run({ kind: 'quote', params: { symbols: [] } })).rejects.toThrow()
  })

  it('serves from cache within ttl', async () => {
    let now = 0
    const cache = new MemoryCache(() => now)
    const handler = vi.fn(async () => toFrame('quote', quoteRows('MU', 1)))
    const r = new ConnectorRegistry({ cache })
    r.register(defineConnector({ name: 'c', config: z.object({}), queries: { quote: handler } }), {})
    const q = { kind: 'quote' as const, params: { symbols: ['MU'] } }
    await r.run(q)
    await r.run(q)
    expect(handler).toHaveBeenCalledTimes(1)
    now = 10_001
    await r.run(q)
    expect(handler).toHaveBeenCalledTimes(2)
    await r.run(q, { bypassCache: true })
    expect(handler).toHaveBeenCalledTimes(3)
  })
})

describe('MemoryCache', () => {
  it('keys are stable across param order', () => {
    const a = parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } })
    const b = parseQuery({ kind: 'ohlcv', params: { range: '3mo', interval: '1d', symbols: ['MU'] } })
    expect(cacheKey(a)).toBe(cacheKey(b))
  })
  it('expires entries and ignores zero ttl', () => {
    let now = 0
    const c = new MemoryCache(() => now)
    const q = parseQuery({ kind: 'quote', params: { symbols: ['MU'] } })
    c.set(q, toFrame('quote', [], { ttl: 0 }))
    expect(c.size).toBe(0)
    c.set(q, toFrame('quote', [], { ttl: 100 }))
    expect(c.get(q)).toBeDefined()
    now = 100
    expect(c.get(q)).toBeUndefined()
  })
})
