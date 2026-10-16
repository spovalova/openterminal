import { describe, expect, it } from 'vitest'
import { KINDS, KIND_NAMES, parseQuery, ttlFor, querySymbols, MS } from '../src/index.js'

describe('kind catalog', () => {
  it('has exactly the five v1 kinds', () => {
    expect(KIND_NAMES).toEqual(['search', 'quote', 'ohlcv', 'news', 'earnings'])
    expect(Object.keys(KINDS)).toEqual([...KIND_NAMES])
  })

  it('has the section 7.1 columns', () => {
    expect(KINDS.search.columns.map((c) => c.name)).toEqual(['query', 'symbol', 'name', 'exchange'])
    expect(KINDS.quote.columns.map((c) => c.name)).toEqual(['symbol', 'price', 'change_pct', 'volume', 'market_state', 'extended_price', 'extended_change_pct'])
    expect(KINDS.ohlcv.columns.map((c) => c.name)).toEqual(['symbol', 'time', 'open', 'high', 'low', 'close', 'volume'])
    expect(KINDS.news.columns.map((c) => c.name)).toEqual(['time', 'headline', 'source', 'url', 'symbol'])
    expect(KINDS.earnings.columns.map((c) => c.name)).toEqual(['symbol', 'date', 'session', 'eps_estimate'])
  })

  it('validates params and applies defaults', () => {
    const q = parseQuery({ kind: 'news', params: { symbols: ['NVDA'] } })
    expect(q.kind === 'news' && q.params.limit).toBe(20)
    expect(() => parseQuery({ kind: 'quote', params: { symbols: [] } })).toThrow()
    expect(() => parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '2m', range: '3mo' } })).toThrow()
    expect(() => parseQuery({ kind: 'earnings', params: { symbols: ['MU'], from: '2026-10-16', to: 'tomorrow' } })).toThrow()
    expect(() => parseQuery({ kind: 'peers', params: {} })).toThrow()
    expect(parseQuery({ kind: 'search', params: { q: ['micron', 'sandisk'] } })).toEqual({ kind: 'search', params: { q: ['micron', 'sandisk'] } })
  })

  it('ttl depends on interval for ohlcv', () => {
    expect(ttlFor(parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '5m', range: '1d' } }))).toBe(MS.minute)
    expect(ttlFor(parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } }))).toBe(10 * MS.minute)
    expect(ttlFor(parseQuery({ kind: 'quote', params: { symbols: ['MU'] } }))).toBe(10 * MS.second)
    expect(ttlFor(parseQuery({ kind: 'search', params: { q: ['x'] } }))).toBe(MS.day)
  })

  it('lists query symbols', () => {
    expect(querySymbols(parseQuery({ kind: 'quote', params: { symbols: ['MU', 'WDC'] } }))).toEqual(['MU', 'WDC'])
    expect(querySymbols(parseQuery({ kind: 'search', params: { q: ['x'] } }))).toEqual([])
  })
})
