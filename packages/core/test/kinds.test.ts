import { describe, expect, it } from 'vitest'
import { KINDS, KIND_NAMES, parseQuery, ttlFor, querySymbols, groupColumn, SERIES_KINDS, MACRO_SERIES, MS } from '../src/index.js'

describe('kind catalog', () => {
  it('keeps the five v1 kinds first and lists the v1.2 kinds after them', () => {
    expect(KIND_NAMES.slice(0, 5)).toEqual(['search', 'quote', 'ohlcv', 'news', 'earnings'])
    expect(KIND_NAMES).toHaveLength(22)
    expect(Object.keys(KINDS)).toEqual([...KIND_NAMES])
  })

  it('has the section 7.1 columns', () => {
    expect(KINDS.search.columns.map((c) => c.name)).toEqual(['query', 'symbol', 'name', 'exchange'])
    expect(KINDS.quote.columns.map((c) => c.name)).toEqual(['symbol', 'price', 'change_pct', 'volume', 'market_state', 'extended_price', 'extended_change_pct'])
    expect(KINDS.ohlcv.columns.map((c) => c.name)).toEqual(['symbol', 'time', 'open', 'high', 'low', 'close', 'volume'])
    expect(KINDS.news.columns.map((c) => c.name)).toEqual(['time', 'headline', 'source', 'url', 'symbol'])
    expect(KINDS.earnings.columns.map((c) => c.name)).toEqual(['symbol', 'date', 'session', 'eps_estimate'])
    expect(KINDS.options.columns.map((c) => c.name)).toEqual(['symbol', 'expiration', 'type', 'strike', 'bid', 'ask', 'last', 'volume', 'open_interest', 'iv', 'delta', 'gamma', 'theta', 'vega', 'underlying_price', 'dte'])
    expect(KINDS.macro.columns.map((c) => c.name)).toEqual(['series', 'time', 'value'])
  })

  it('every kind has unique column names and a time column typed time', () => {
    for (const kind of KIND_NAMES) {
      const names = KINDS[kind].columns.map((c) => c.name)
      expect(new Set(names).size, kind).toBe(names.length)
      for (const c of KINDS[kind].columns) if (c.name === 'time') expect(c.type, kind).toBe('time')
    }
  })

  it('validates params and applies defaults', () => {
    const q = parseQuery({ kind: 'news', params: { symbols: ['NVDA'] } })
    expect(q.kind === 'news' && q.params.limit).toBe(20)
    expect(() => parseQuery({ kind: 'quote', params: { symbols: [] } })).toThrow()
    expect(() => parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '2m', range: '3mo' } })).toThrow()
    expect(() => parseQuery({ kind: 'earnings', params: { symbols: ['MU'], from: '2026-10-16', to: 'tomorrow' } })).toThrow()
    expect(() => parseQuery({ kind: 'peers', params: {} })).toThrow()
    expect(parseQuery({ kind: 'search', params: { q: ['micron', 'sandisk'] } })).toEqual({ kind: 'search', params: { q: ['micron', 'sandisk'] } })
    expect(parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '1w', range: '2y' } }).params).toMatchObject({ range: '2y' })
  })

  it('applies the v1.2 defaults', () => {
    expect(parseQuery({ kind: 'options', params: { symbol: 'NVDA' } }).params).toEqual({ symbol: 'NVDA', strikes: 10, type: 'both' })
    expect(parseQuery({ kind: 'financials', params: { symbols: ['MU'] } }).params).toEqual({ symbols: ['MU'], period: 'quarter', limit: 4 })
    expect(parseQuery({ kind: 'macro', params: { series: ['treasury_10y'] } }).params).toEqual({ series: ['treasury_10y'], range: '1y' })
    expect(parseQuery({ kind: 'movers', params: {} }).params).toEqual({ list: 'gainers', limit: 20, min_price: 5 })
    expect(parseQuery({ kind: 'calendar', params: { from: '2026-10-19', to: '2026-10-23' } }).params).toEqual({ from: '2026-10-19', to: '2026-10-23', country: 'United States' })
    expect(parseQuery({ kind: 'yield_curve', params: {} }).params).toEqual({})
    expect(() => parseQuery({ kind: 'macro', params: { series: ['gdp'] } })).toThrow()
    expect(() => parseQuery({ kind: 'macro', params: { series: ['m2', 'fed_funds'] } })).toThrow(/m2/)
    const m2 = parseQuery({ kind: 'macro', params: { series: ['m2'] } })
    expect(m2.kind === 'macro' && m2.params.series).toEqual(['m2'])
    expect(() => parseQuery({ kind: 'options', params: { symbol: 'NVDA', strikes: 0 } })).toThrow()
    expect(MACRO_SERIES).toContain('fed_funds')
  })

  it('ttl depends on interval for ohlcv', () => {
    expect(ttlFor(parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '5m', range: '1d' } }))).toBe(MS.minute)
    expect(ttlFor(parseQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } }))).toBe(10 * MS.minute)
    expect(ttlFor(parseQuery({ kind: 'quote', params: { symbols: ['MU'] } }))).toBe(10 * MS.second)
    expect(ttlFor(parseQuery({ kind: 'search', params: { q: ['x'] } }))).toBe(MS.day)
    expect(ttlFor(parseQuery({ kind: 'options', params: { symbol: 'MU' } }))).toBe(MS.minute)
  })

  it('lists query symbols for symbols[], symbol, and none', () => {
    expect(querySymbols(parseQuery({ kind: 'quote', params: { symbols: ['MU', 'WDC'] } }))).toEqual(['MU', 'WDC'])
    expect(querySymbols(parseQuery({ kind: 'search', params: { q: ['x'] } }))).toEqual([])
    expect(querySymbols(parseQuery({ kind: 'options', params: { symbol: 'NVDA' } }))).toEqual(['NVDA'])
    expect(querySymbols(parseQuery({ kind: 'holdings', params: { symbol: 'SMH' } }))).toEqual(['SMH'])
    expect(querySymbols(parseQuery({ kind: 'macro', params: { series: ['sofr'] } }))).toEqual([])
    expect(querySymbols(parseQuery({ kind: 'movers', params: {} }))).toEqual([])
  })

  it('knows which kinds chart and what groups their rows', () => {
    expect([...SERIES_KINDS]).toEqual(['ohlcv', 'macro'])
    expect(groupColumn('ohlcv')).toBe('symbol')
    expect(groupColumn('macro')).toBe('series')
  })
})
