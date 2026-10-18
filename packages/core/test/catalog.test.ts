import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Catalog, NAMESPACE_BIAS, descriptorsFromOpenApi, tokenize } from '../src/index.js'

const doc = JSON.parse(readFileSync(new URL('./fixtures/openbb-openapi.json', import.meta.url), 'utf8')) as unknown
const descriptors = descriptorsFromOpenApi(doc, 'openbb')

describe('tokenize', () => {
  it('splits paths, snake_case and camelCase, lowercases, strips plurals and stop words', () => {
    expect(tokenize('equity/price/historical')).toEqual(['equity', 'price', 'history']) // 'historical' and 'history' meet
    expect(tokenize('bond_prices for the yieldCurve')).toEqual(['bond', 'price', 'yield', 'curve'])
    expect(tokenize('companies')).toEqual(['company'])
    expect(tokenize('')).toEqual([])
  })
})

describe('Catalog', () => {
  const catalog = new Catalog(descriptors)

  it('indexes every descriptor and answers get()', () => {
    expect(catalog.size).toBe(descriptors.length)
    expect(catalog.get('openbb', 'equity/price/quote')?.summary).toBe('Quote')
    expect(catalog.get('openbb', 'nope')).toBeUndefined()
    expect(catalog.connectors()).toEqual(['openbb'])
  })

  it('finds the historical price route for "price history" and the quote for "latest price"', () => {
    const hits = catalog.find('price history bars', { limit: 3 })
    expect(hits[0]!.route).toBe('equity/price/historical')
    expect(hits[0]!.requiredParams).toEqual(['symbol'])
    expect(hits[0]!.fields.slice(0, 3)).toEqual(['date', 'open', 'high'])
    expect(catalog.find('latest quote price')[0]!.route).toBe('equity/price/quote')
  })

  it('prefers the trading namespaces over commodity and agriculture series', () => {
    expect(NAMESPACE_BIAS.equity).toBeGreaterThan(NAMESPACE_BIAS.commodity!)
    expect(NAMESPACE_BIAS.fixedincome).toBeGreaterThan(NAMESPACE_BIAS.usda!)
    const hits = catalog.find('price', { limit: 10 })
    const equityRank = hits.findIndex((h) => h.route.startsWith('equity/'))
    const commodityRank = hits.findIndex((h) => h.route.startsWith('commodity/'))
    expect(equityRank).toBeGreaterThanOrEqual(0)
    if (commodityRank >= 0) expect(equityRank).toBeLessThan(commodityRank)
    expect(catalog.find('bond yields corporate')[0]!.route).toBe('fixedincome/corporate/bond_prices')
    expect(catalog.find('economic calendar releases')[0]!.route).toBe('economy/calendar')
    expect(catalog.find('option chain strikes')[0]!.route).toBe('derivatives/options/chains')
    expect(catalog.find('insider trading')[0]!.route).toBe('equity/ownership/insider_trading')
  })

  it('matches field names and params, not only the path', () => {
    const iv = catalog.find('iv30 implied volatility', { limit: 5 })
    expect(iv.map((h) => h.route)).toContain('equity/price/quote')
    expect(catalog.find('eps_actual surprise', { limit: 2 }).map((h) => h.route)).toContain('equity/fundamental/historical_eps')
  })

  it('limits, filters by namespace and connector, and returns nothing for an empty query', () => {
    expect(catalog.find('price', { limit: 2 })).toHaveLength(2)
    const fi = catalog.find('rate', { namespaces: ['fixedincome'], limit: 10 })
    expect(fi.length).toBeGreaterThan(0)
    expect(fi.every((h) => h.route.startsWith('fixedincome/'))).toBe(true)
    expect(catalog.find('price', { connectors: ['yahoo'] })).toEqual([])
    expect(catalog.find('   ')).toEqual([])
    expect(catalog.find('zzzzqqq')).toEqual([])
  })

  it('hides dead routes unless includeDead, keeps unknown liveness visible, and reports stats', () => {
    const c = new Catalog(descriptors)
    c.setLiveness({ connector: 'openbb', route: 'equity/price/historical' }, { checkedAt: 1, ok: false, error: 'boom' })
    c.setLiveness({ connector: 'openbb', route: 'equity/price/quote' }, { checkedAt: 2, ok: true, rows: 1, ms: 50 })
    expect(c.find('price history bars').map((h) => h.route)).not.toContain('equity/price/historical')
    expect(c.find('price history bars', { includeDead: true })[0]!).toMatchObject({ route: 'equity/price/historical', liveness: { ok: false } })
    expect(c.find('latest quote price')[0]!.liveness).toMatchObject({ ok: true, rows: 1 })
    expect(c.stats().openbb).toMatchObject({ routes: descriptors.length, alive: 1, dead: 1, unknown: descriptors.length - 2, probedAt: 2 })
  })

  it('replaces one connector’s descriptors and re-indexes', () => {
    const c = new Catalog(descriptors)
    c.replace('yahoo', [{ connector: 'yahoo', route: 'quote', summary: 'Yahoo quote', params: [{ name: 'symbols', type: 'string[]', required: true }], providers: [], fields: [{ name: 'regularMarketPrice', type: 'number' }] }])
    expect(c.connectors()).toEqual(['openbb', 'yahoo'])
    expect(c.find('yahoo quote', { connectors: ['yahoo'] })[0]!.route).toBe('quote')
    c.replace('yahoo', [])
    expect(c.connectors()).toEqual(['openbb'])
  })

  it('scores a route matching every query term above one matching some', () => {
    const hits = catalog.find('treasury rates', { limit: 5 })
    expect(hits[0]!.route).toBe('fixedincome/government/treasury_rates')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })
})
