import { describe, expect, it } from 'vitest'
import { AnyQuerySchema, QueryV2Schema, anyQuerySymbols, cacheKey, canonicalKey, describeQuery, isRecipeQuery, isRouteQuery, isTransformQuery, parseAnyQuery, resolveRecipe, type Recipe } from '../src/index.js'
import { builtinRecipes } from '../src/node.js'

const route = { connector: 'openbb', route: 'equity/price/quote', params: { symbol: ['NVDA'] } }
const recipe = { recipe: 'quote', params: { symbols: ['NVDA'] } }
const transform = { inputs: { price: route, eps: recipe }, code: 'result = price', columns: { pe: { unit: 'ratio', label: 'P/E' } } }

describe('query schemas', () => {
  it('parses the three shapes and tells them apart', () => {
    expect(isRouteQuery(QueryV2Schema.parse(route))).toBe(true)
    expect(isRecipeQuery(QueryV2Schema.parse(recipe))).toBe(true)
    const t = QueryV2Schema.parse(transform)
    expect(isTransformQuery(t)).toBe(true)
    expect(isRouteQuery(t)).toBe(false)
    expect(isRecipeQuery(t)).toBe(false)
  })
  it('defaults params to {} and rejects bad input names and empty code', () => {
    expect(QueryV2Schema.parse({ connector: 'openbb', route: 'x' })).toEqual({ connector: 'openbb', route: 'x', params: {} })
    expect(QueryV2Schema.parse({ recipe: 'quote' })).toEqual({ recipe: 'quote', params: {} })
    expect(() => QueryV2Schema.parse({ inputs: { 'bad name': route }, code: 'x' })).toThrow()
    expect(() => QueryV2Schema.parse({ inputs: { a: route }, code: '' })).toThrow()
    expect(() => QueryV2Schema.parse({ inputs: { a: route }, code: 'x', columns: { pe: { unit: 'lightyears' } } })).toThrow()
  })
  it('refuses the v1 kind query shape: a kind is the recipe of the same name now', () => {
    expect(() => parseAnyQuery({ kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } })).toThrow()
    expect(AnyQuerySchema.safeParse({ kind: 'news', params: { symbols: ['MU'] } }).success).toBe(false)
    expect(parseAnyQuery({ recipe: 'news', params: { symbols: ['MU'] } })).toEqual({ recipe: 'news', params: { symbols: ['MU'] } })
  })
  it('nests queries inside transform inputs', () => {
    const t = QueryV2Schema.parse({ inputs: { a: { inputs: { b: route }, code: 'result = b' } }, code: 'result = a' })
    expect(isTransformQuery((t as { inputs: Record<string, unknown> }).inputs.a)).toBe(true)
    expect(() => AnyQuerySchema.parse({ inputs: { p: { kind: 'quote', params: { symbols: ['MU'] } } }, code: 'result = p' })).toThrow()
  })
})

describe('canonicalKey', () => {
  it('is stable across param order; cacheKey is canonicalKey', () => {
    const a = canonicalKey({ connector: 'openbb', route: 'equity/price/historical', params: { symbol: 'NVDA', interval: '1d' } })
    const b = canonicalKey({ connector: 'openbb', route: 'equity/price/historical', params: { interval: '1d', symbol: 'NVDA' } })
    expect(a).toBe(b)
    expect(a).toBe('route:openbb/equity/price/historical:{"interval":"1d","symbol":"NVDA"}')
    expect(cacheKey(recipe)).toBe(canonicalKey(recipe))
  })
  it('drops null and empty params but keeps array order', () => {
    expect(canonicalKey({ connector: 'o', route: 'r', params: { b: null, a: '', c: ['Z', 'A'] } })).toBe('route:o/r:{"c":["Z","A"]}')
    expect(canonicalKey({ connector: 'o', route: 'r', params: { c: ['A', 'Z'] } })).not.toBe(canonicalKey({ connector: 'o', route: 'r', params: { c: ['Z', 'A'] } }))
  })
  it('keys recipes by name and transforms by their inputs and code', () => {
    expect(canonicalKey({ recipe: 'quote', params: { symbols: ['NVDA'] } })).toBe('recipe:quote:{"symbols":["NVDA"]}')
    const t1 = canonicalKey(QueryV2Schema.parse(transform))
    const t2 = canonicalKey(QueryV2Schema.parse({ ...transform, code: 'result = eps' }))
    expect(t1).toMatch(/^transform:/)
    expect(t1).not.toBe(t2)
    expect(t1).toContain('route:openbb/equity/price/quote')
  })
})

describe('resolveRecipe', () => {
  const recipes: Recipe[] = builtinRecipes()
  it('resolves a recipe to ordered route alternatives with the exact routes the v1 kind handlers called', () => {
    const alts = resolveRecipe(recipes, { recipe: 'quote', params: { symbols: ['NVDA', 'AMD'] } })
    // yahoo first since phase 2 (it carries the day change and market state); the OpenBB route is the fallback.
    expect(alts.map((a) => `${a.connector} ${a.route}`)).toEqual(['yahoo quote', 'openbb equity/price/quote', 'finnhub quote'])
    expect(alts[1]!.params).toEqual({ symbol: ['NVDA', 'AMD'], provider: 'yfinance' })
    expect(alts[2]!.params).toEqual({ symbol: 'NVDA' })
  })
  it('applies defaults and filters, and picks routes by `when`', () => {
    const now = Date.UTC(2026, 9, 20, 15) // Tue 2026-10-20
    const ohlcv = resolveRecipe(recipes, { recipe: 'ohlcv', params: { symbols: ['MU'] } }, { now })
    expect(ohlcv[0]).toEqual({ connector: 'openbb', route: 'equity/price/historical', params: { symbol: ['MU'], start_date: '2026-07-20', interval: '1d', provider: 'yfinance' }, rename: { date: 'time' } })
    expect(ohlcv[1]!.params).toMatchObject({ interval: '1d', period1: '2026-07-20' })
    const weekly = resolveRecipe(recipes, { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1w', range: '1d' } }, { now })
    expect(weekly[0]!.params.interval).toBe('1W')
    expect(weekly[1]!.params.interval).toBe('1wk')
    expect(weekly[0]!.params.start_date).toBe('2026-10-20')
    expect(resolveRecipe(recipes, { recipe: 'macro', params: { series: 'fed_funds' } }).map((r) => r.route)).toEqual(['fixedincome/rate/effr'])
    expect(resolveRecipe(recipes, { recipe: 'macro', params: { series: 'treasury_10y', range: '5y' } })[0]).toMatchObject({ route: 'fixedincome/government/treasury_rates', params: { provider: 'federal_reserve' } })
    expect(resolveRecipe(recipes, { recipe: 'movers', params: { list: 'losers' } })[0]!.params).toEqual({ preset: 'day_losers', limit: 20, price_min: 5, provider: 'yfinance' })
  })
  it('throws on an unknown recipe or invalid params', () => {
    expect(() => resolveRecipe(recipes, { recipe: 'nope', params: {} })).toThrow(/unknown recipe/)
    expect(() => resolveRecipe(recipes, { recipe: 'quote', params: {} })).toThrow()
    expect(() => resolveRecipe(recipes, { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '2h' } })).toThrow()
  })
  it('accepts a Map of recipes too', () => {
    const map = new Map(recipes.map((r) => [r.name, r]))
    expect(resolveRecipe(map, { recipe: 'holdings', params: { symbol: 'SMH' } })[0]!.route).toBe('etf/holdings')
  })
})

describe('query helpers', () => {
  it('lists the symbols a query is about and describes it in one line', () => {
    expect(anyQuerySymbols({ connector: 'o', route: 'r', params: { symbol: 'NVDA,AMD' } })).toEqual(['NVDA', 'AMD'])
    expect(anyQuerySymbols({ recipe: 'quote', params: { symbols: ['MU'] } })).toEqual(['MU'])
    expect(anyQuerySymbols(QueryV2Schema.parse(transform))).toEqual(['NVDA'])
    expect(anyQuerySymbols({ recipe: 'calendar', params: {} })).toEqual([])
    expect(describeQuery({ connector: 'openbb', route: 'equity/price/quote', params: { symbol: ['NVDA', 'AMD'] } })).toBe('openbb equity/price/quote symbol=NVDA,AMD')
    expect(describeQuery({ recipe: 'quote', params: {} })).toBe('recipe quote')
    expect(describeQuery(QueryV2Schema.parse(transform))).toBe('transform(price, eps)')
  })
})
