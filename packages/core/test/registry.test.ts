import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ConnectorRegistry, MemoryCache, cacheKey, defineConnector, inferFrame, type Descriptor } from '../src/index.js'

const quoteDescriptor: Descriptor = {
  connector: 'demo',
  route: 'quote',
  summary: 'Quote',
  params: [{ name: 'symbols', type: 'string[]', required: true }],
  providers: [],
  fields: [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }],
}
const quoteRows = (symbols: string[], price: number) => symbols.map((symbol) => ({ symbol, price }))
const quoteConnector = (name: string, price: number, extra: Partial<Parameters<typeof defineConnector>[0]> = {}) =>
  defineConnector({
    name,
    config: z.object({}),
    descriptors: () => [{ ...quoteDescriptor, connector: name }],
    call: async (_route, params) => inferFrame(quoteRows(params.symbols as string[], price), { connector: name }, { descriptor: quoteDescriptor }),
    ...extra,
  })

describe('defineConnector', () => {
  it('needs a kebab-case name, descriptors() and call()', () => {
    const c = quoteConnector('demo', 1)
    expect(c.name).toBe('demo')
    expect(() => defineConnector({ name: 'Bad Name', config: z.object({}), descriptors: () => [], call: async () => ({ columns: [], rows: [], meta: { connector: 'x', fetchedAt: 0, ttl: 0 } }) })).toThrow(/kebab-case/)
    expect(() => defineConnector({ name: 'x', config: z.object({}), descriptors: () => [] } as never)).toThrow(/no call/)
    expect(() => defineConnector({ name: 'x', config: z.object({}), call: async () => ({ columns: [], rows: [], meta: { connector: 'x', fetchedAt: 0, ttl: 0 } }) } as never)).toThrow(/no descriptors/)
  })
})

describe('ConnectorRegistry', () => {
  const needsKey = defineConnector({ name: 'keyed', config: z.object({ apiKey: z.string().min(1) }), descriptors: () => [{ ...quoteDescriptor, connector: 'keyed' }], call: async () => ({ columns: [], rows: [], meta: { connector: 'keyed', fetchedAt: 0, ttl: 0 } }) })

  it('marks connectors with invalid config and leaves them out of the catalog', async () => {
    const r = new ConnectorRegistry()
    expect(r.register(needsKey, {}).status).toBe('missing_config')
    expect((await r.catalog()).connectors()).toEqual([])
    await expect(r.run({ connector: 'keyed', route: 'quote', params: { symbols: ['MU'] } })).rejects.toThrow(/missing_config/)
    expect(r.register(needsKey, { apiKey: 'k' }).status).toBe('ok')
    expect((await r.catalog()).connectors()).toEqual(['keyed'])
    expect(r.connectors()).toHaveLength(1)
  })

  it('keeps routing priority when a connector is re-registered', async () => {
    const r = new ConnectorRegistry()
    r.register(needsKey, {})
    r.register(quoteConnector('good', 42), {})
    r.register(needsKey, { apiKey: 'k' })
    expect(r.connectors().map((c) => c.name)).toEqual(['keyed', 'good'])
  })

  it('rejects invalid params before touching the connector', async () => {
    const call = vi.fn()
    const r = new ConnectorRegistry()
    r.register(quoteConnector('good', 42, { call }), {})
    await expect(r.run({ connector: 'good', route: 'quote', params: {} })).rejects.toThrow(/required/)
    expect(call).not.toHaveBeenCalled()
  })

  it('serves from cache within the route ttl', async () => {
    let now = 0
    const cache = new MemoryCache(() => now)
    const call = vi.fn(async () => inferFrame(quoteRows(['MU'], 1), { connector: 'c' }, { descriptor: quoteDescriptor }))
    const r = new ConnectorRegistry({ cache, now: () => now })
    r.register(quoteConnector('c', 1, { call }), {})
    const q = { connector: 'c', route: 'quote', params: { symbols: ['MU'] } }
    await r.run(q)
    await r.run(q)
    expect(call).toHaveBeenCalledTimes(1)
    now = 10_001 // the `*quote*` route ttl is 10 s
    await r.run(q)
    expect(call).toHaveBeenCalledTimes(2)
    await r.run(q, { bypassCache: true })
    expect(call).toHaveBeenCalledTimes(3)
  })
})

describe('MemoryCache', () => {
  it('keys are stable across param order', () => {
    const a = { connector: 'c', route: 'equity/price/historical', params: { symbol: ['MU'], interval: '1d', start_date: '2026-01-01' } }
    const b = { connector: 'c', route: 'equity/price/historical', params: { start_date: '2026-01-01', interval: '1d', symbol: ['MU'] } }
    expect(cacheKey(a)).toBe(cacheKey(b))
  })
  it('expires entries and ignores zero ttl', () => {
    let now = 0
    const c = new MemoryCache(() => now)
    const q = { connector: 'c', route: 'quote', params: { symbols: ['MU'] } }
    const frame = (ttl: number) => ({ columns: [], rows: [], meta: { connector: 'c', fetchedAt: 0, ttl } })
    c.set(q, frame(0))
    expect(c.size).toBe(0)
    c.set(q, frame(100))
    expect(c.get(q)).toBeDefined()
    now = 100
    expect(c.get(q)).toBeUndefined()
  })
})

describe('ConnectorRegistry.health', () => {
  it('is ok for a connector without a probe and for a probe that resolves', async () => {
    const r = new ConnectorRegistry()
    r.register(quoteConnector('plain', 1), {})
    r.register(quoteConnector('probed', 1, { health: async () => 'service 1.0 at http://x' }), {})
    expect(await r.health('plain')).toEqual({ ok: true })
    expect(await r.health('probed')).toEqual({ ok: true, detail: 'service 1.0 at http://x' })
  })
  it('reports a throwing probe, a timeout, and unknown or unconfigured connectors as not ok', async () => {
    const r = new ConnectorRegistry()
    r.register(
      quoteConnector('down', 1, {
        health: async () => {
          throw new Error('not running at http://x')
        },
      }),
      {},
    )
    r.register(quoteConnector('slow', 1, { health: (ctx) => new Promise((_, reject) => ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason))) }), {})
    r.register(defineConnector({ name: 'nokey', config: z.object({ apiKey: z.string() }), descriptors: () => [], call: async () => ({ columns: [], rows: [], meta: { connector: 'nokey', fetchedAt: 0, ttl: 0 } }) }), {})
    expect(await r.health('down')).toEqual({ ok: false, error: 'not running at http://x' })
    expect(await r.health('slow', { timeoutMs: 20 })).toEqual({ ok: false, error: 'health probe timed out after 20 ms' })
    expect((await r.health('nokey')).ok).toBe(false)
    expect((await r.health('nope')).ok).toBe(false)
  })
})
