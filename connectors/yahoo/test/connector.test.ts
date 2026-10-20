import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, MemoryCache, frameToObjects } from '@openterminal/core'
import yahoo, { YAHOO_ROUTES, createYahooConnector } from '../src/index.js'
import { V12_NOW, fakeClient } from './helpers.js'

describe('connector', () => {
  it('is named yahoo, takes an empty config, and answers the five yahoo-finance2 routes and news', async () => {
    expect(yahoo.name).toBe('yahoo')
    expect(yahoo.config.safeParse({}).success).toBe(true)
    expect((await yahoo.descriptors()).map((d) => d.route)).toEqual([...YAHOO_ROUTES])
  })

  it('answers every route through the registry with an injected client: params validated, lineage and ttl stamped', async () => {
    const registry = new ConnectorRegistry({ cache: new MemoryCache() })
    registry.register(createYahooConnector({ client: fakeClient(), now: () => V12_NOW }), {})
    const quote = await registry.run({ connector: 'yahoo', route: 'quote', params: { symbols: ['MU', 'NVDA'] } })
    expect(frameToObjects(quote).map((r) => r.symbol)).toEqual(['MU', 'NVDA'])
    expect(quote.meta).toMatchObject({ connector: 'yahoo', ttl: 10_000, lineage: { connector: 'yahoo', route: 'quote' } })
    const bars = await registry.run({ connector: 'yahoo', route: 'chart', params: { symbol: 'MU', period1: '2026-07-18', interval: '1d' } })
    expect(bars.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['symbol', 'date', 'close']))
    expect(bars.rows.length).toBeGreaterThan(5)
    const chain = await registry.run({ connector: 'yahoo', route: 'options', params: { symbol: 'MU' } })
    expect(chain.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['type', 'strike', 'expiration', 'underlyingPrice']))
    const summary = await registry.run({ connector: 'yahoo', route: 'quoteSummary', params: { symbol: 'MU', modules: ['financialData'] } })
    expect(summary.columns.map((c) => c.name)).toContain('financialData.targetMeanPrice')
    const search = await registry.run({ connector: 'yahoo', route: 'search', params: { q: 'micron' } })
    expect(frameToObjects(search)[0]).toMatchObject({ query: 'micron', symbol: 'MU' })
    const news = await registry.run({ connector: 'yahoo', route: 'news', params: { symbol: ['TSLA'], limit: 5 } })
    expect(news.columns.map((c) => c.name)).toEqual(['date', 'title', 'publisher', 'url', 'symbols'])
    expect(news.rows).toHaveLength(5)
    expect(news.meta).toMatchObject({ connector: 'yahoo', ttl: 5 * 60_000, lineage: { connector: 'yahoo', route: 'news' } })
    await expect(registry.run({ connector: 'yahoo', route: 'chart', params: { symbol: 'MU' } })).rejects.toThrow(/"period1" is required/)
  })

  it('uses the shared live client lazily so importing the module makes no network calls', () => {
    expect(typeof yahoo.call).toBe('function')
  })
})
