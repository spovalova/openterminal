import { describe, expect, it } from 'vitest'
import { KIND_NAMES, RECIPE_PARAMS_INPUT, applyAnnotations, controlFor, datasetFieldsFrom, expandRecipe, parseRecipes, recipeDatasets, recipeDescriptor, recipeParams, recipeParamsFrame, recipeParamsSchema, recipeRouteAlternatives, recipeSummaryLines, renameColumns, renderValue, titleFor, validateRecipe, type Frame, type Recipe } from '../src/index.js'
import { builtinAnnotations, builtinRecipes } from '../src/node.js'

const recipes = builtinRecipes()
const by = (name: string) => recipes.find((r) => r.name === name)!

describe('recipes.yml', () => {
  it('parses, has unique names, and carries every one of the 22 kinds', () => {
    const names = recipes.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    for (const kind of KIND_NAMES) expect(names, kind).toContain(kind)
    expect(names.length).toBeGreaterThanOrEqual(22)
    for (const r of recipes) expect(validateRecipe(r), r.name).toEqual([])
  })
  it('uses the exact OpenBB routes and providers the v1 handlers called', () => {
    const first = (name: string) => recipeRouteAlternatives(by(name))[0]
    // quote is the exception since phase 2: yahoo's quote comes first (it carries the day change and the market
    // state; OpenBB's yfinance quote has neither), with the OpenBB route as the fallback.
    expect(first('quote')).toMatchObject({ connector: 'yahoo', route: 'quote' })
    expect(recipeDatasets(by('quote')).main!).toMatchObject({ routes: [{ connector: 'yahoo' }, { connector: 'openbb', route: 'equity/price/quote', provider: 'yfinance' }, { connector: 'finnhub' }] })
    const expected: Record<string, [string, string]> = {
      search: ['equity/search', 'nasdaq'],
      ohlcv: ['equity/price/historical', 'yfinance'],
      news: ['news/company', 'nasdaq'],
      earnings: ['equity/calendar/earnings', 'nasdaq'],
      profile: ['equity/profile', 'yfinance'],
      metrics: ['equity/fundamental/metrics', 'yfinance'],
      estimates: ['equity/estimates/consensus', 'yfinance'],
      eps_history: ['equity/fundamental/historical_eps', 'yfinance'],
      dividends: ['equity/fundamental/dividends', 'yfinance'],
      insiders: ['equity/ownership/insider_trading', 'sec'],
      institutions: ['equity/ownership/institutional', 'nasdaq'],
      short_interest: ['equity/shorts/short_interest', 'finra'],
      options: ['derivatives/options/chains', 'cboe'],
      volatility: ['equity/price/quote', 'cboe'],
      calendar: ['economy/calendar', 'nasdaq'],
      ipos: ['equity/calendar/ipo', 'nasdaq'],
      movers: ['equity/screener', 'yfinance'],
      holdings: ['etf/holdings', 'nasdaq'],
      yield_curve: ['fixedincome/government/yield_curve', 'federal_reserve'],
    }
    for (const [name, [route, provider]] of Object.entries(expected)) {
      expect(first(name), name).toMatchObject({ connector: 'openbb', route, provider })
    }
    // financials joins the three statements the handler fetched; macro picks its route by series.
    expect(Object.keys(recipeDatasets(by('financials')))).toEqual(['income', 'cash', 'balance', 'main'])
    const macroRoutes = recipeRouteAlternatives(by('macro')).map((r) => r.route)
    expect(macroRoutes).toEqual(['fixedincome/government/treasury_rates', 'fixedincome/rate/effr', 'fixedincome/rate/sofr', 'economy/money_measures', 'economy/cpi', 'economy/unemployment'])
  })
  it('names the yahoo and finnhub endpoints the fallbacks wrap', () => {
    const routesOf = (name: string, connector: string) => recipeRouteAlternatives(by(name)).filter((r) => r.connector === connector).map((r) => r.route)
    expect(routesOf('quote', 'yahoo')).toEqual(['quote'])
    expect(routesOf('ohlcv', 'yahoo')).toEqual(['chart'])
    expect(routesOf('options', 'yahoo')).toEqual(['options'])
    expect(routesOf('search', 'yahoo')).toEqual(['search'])
    expect(routesOf('metrics', 'yahoo')).toEqual(['quoteSummary'])
    expect(routesOf('quote', 'finnhub')).toEqual(['quote'])
    expect(routesOf('news', 'finnhub')).toEqual(['company-news'])
    expect(routesOf('earnings', 'finnhub')).toEqual(['calendar/earnings'])
    const yahooRoutes = new Set(recipes.flatMap((r) => Object.values(recipeDatasets(r)).flatMap((ds) => ('routes' in ds ? ds.routes.filter((x) => x.connector === 'yahoo').map((x) => x.route) : []))))
    expect([...yahooRoutes].sort()).toEqual(['chart', 'options', 'quote', 'quoteSummary', 'search'])
  })
  it('gives every recipe a preset the shape of its frame supports and a size', () => {
    expect(by('ohlcv').view.preset).toBe('price')
    expect(by('options').view.preset).toBe('chain')
    expect(by('quote').view).toMatchObject({ preset: 'stat' }) // the key field and the annotated day change pick the columns on every route
    expect(by('volatility').view).toMatchObject({ preset: 'stat', column: 'iv30' })
    expect(by('profile').view.preset).toBe('facts')
    expect(by('yield_curve').view).toMatchObject({ preset: 'curve', x: 'maturity_years' })
    expect(recipes.every((r) => r.size)).toBe(true)
    expect(by('ohlcv').events).toBe('earnings')
  })
})

describe('expandRecipe', () => {
  const now = Date.UTC(2026, 9, 20, 15)
  it('validates params with defaults and renders titles', () => {
    const e = expandRecipe(by('ohlcv'), { symbols: ['MU', 'WDC'] }, { now })
    expect(e.params).toEqual({ symbols: ['MU', 'WDC'], interval: '1d', range: '3mo' })
    expect(e.title).toBe('MU, WDC 1d 3mo')
    expect(titleFor(by('yield_curve'), {})).toBe('Yield curve')
    expect(titleFor(by('calendar'), { from: '2026-10-19', to: '2026-10-23' })).toBe('Economic calendar 2026-10-19 to 2026-10-23')
  })
  it('accepts comma-separated symbols and coerces numbers', () => {
    const e = expandRecipe(by('news'), { symbols: 'MU, WDC', limit: '5' })
    expect(e.params).toEqual({ symbols: ['MU', 'WDC'], limit: 5 })
    expect(e.routes[0]!.params).toEqual({ symbol: ['MU', 'WDC'], limit: 5, provider: 'nasdaq' })
  })
  it('expands a multi-dataset recipe with a transform main', () => {
    const e = expandRecipe(by('financials'), { symbols: ['NVDA'], period: 'annual' })
    expect(e.routes).toEqual((e.data.income as { routes: unknown[] }).routes) // main is a transform: the first route dataset's alternatives stand in
    expect(e.data.income).toMatchObject({ routes: [{ route: 'equity/fundamental/income', params: { symbol: 'NVDA', period: 'annual', limit: 4, provider: 'yfinance' } }] })
    expect(e.data.main).toMatchObject({ transform: { inputs: ['income', 'cash', 'balance'] } })
    expect((e.data.main as { transform: { code: string } }).transform.code).toContain('result =')
  })
  it('drops routes whose `when` does not match and omits params rendered empty', () => {
    const m2 = expandRecipe(by('macro'), { series: 'm2' }, { now })
    expect(m2.routes.map((r) => r.route)).toEqual(['economy/money_measures'])
    const curve = expandRecipe(by('yield_curve'), {})
    expect(curve.routes[0]!.params).toEqual({ provider: 'federal_reserve' })
    const dated = expandRecipe(by('yield_curve'), { date: '2026-10-16' })
    expect(dated.routes[0]!.params).toEqual({ date: '2026-10-16', provider: 'federal_reserve' })
  })
  it('rejects unknown enum values and missing required params', () => {
    expect(() => expandRecipe(by('macro'), { series: 'gdp' })).toThrow()
    expect(() => expandRecipe(by('holdings'), {})).toThrow()
  })
})

describe('recipe helpers', () => {
  it('renders templates with filters', () => {
    const ctx = { now: Date.UTC(2026, 9, 20, 15) }
    const params = { range: '1mo', symbols: ['A', 'B'], list: 'gainers', n: 4, interval: '1w' }
    expect(renderValue('{symbols}', params, ctx)).toEqual(['A', 'B'])
    expect(renderValue('{symbols|join}', params, ctx)).toBe('A,B')
    expect(renderValue('{symbols|first}', params, ctx)).toBe('A')
    expect(renderValue('{range|start_date}', params, ctx)).toBe('2026-09-20')
    expect(renderValue('{n|days_ago:7}', params, ctx)).toBe('2026-10-13')
    expect(renderValue('{n|today}', params, ctx)).toBe('2026-10-20')
    expect(renderValue('{n|times:5}', params, ctx)).toBe(20)
    expect(renderValue('{list|map:gainers=day_gainers,losers=day_losers}', params, ctx)).toBe('day_gainers')
    expect(renderValue('{interval|yahoo_interval}', params, ctx)).toBe('1wk')
    expect(renderValue('{interval|openbb_interval}', params, ctx)).toBe('1W')
    expect(renderValue('{range|const:5y}', params, ctx)).toBe('5y')
    expect(renderValue('X-{symbols|first}-{n}', params, ctx)).toBe('X-A-4')
    expect(renderValue(42, params, ctx)).toBe(42)
    expect(renderValue('literal', params, ctx)).toBe('literal')
    expect(renderValue('{missing}', params, ctx)).toBeUndefined()
    expect(() => renderValue('{range|nope}', params, ctx)).toThrow(/unknown template filter/)
  })
  it('builds a Zod schema and descriptor params from the JSON schema', () => {
    const schema = recipeParamsSchema(by('movers'))
    expect(schema.parse({})).toEqual({ list: 'gainers', limit: 20, min_price: 5 })
    expect(() => schema.parse({ list: 'winners' })).toThrow()
    expect(recipeParams(by('ohlcv'))).toEqual([
      { name: 'symbols', type: 'string[]', required: true, description: 'Ticker symbols' },
      { name: 'interval', type: 'string', required: false, enum: ['1m', '5m', '15m', '1h', '1d', '1w'], default: '1d' },
      { name: 'range', type: 'string', required: false, enum: ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'], default: '3mo' },
      { name: 'start', type: 'date', required: false, description: 'Start date (YYYY-MM-DD) for a window the ranges do not cover, e.g. 2020-01-01 for "since 2020"; overrides range' },
    ])
    // `start` overrides the range on both routes through the `prefer` filter.
    const since = expandRecipe(by('ohlcv'), { symbols: ['SPY'], start: '2020-01-01' })
    expect(since.routes[0]!.params.start_date).toBe('2020-01-01')
    expect(since.routes[1]!.params.period1).toBe('2020-01-01')
    expect(expandRecipe(by('ohlcv'), { symbols: ['SPY'], range: '1y' }, { now: Date.UTC(2026, 9, 20, 15) }).routes[0]!.params.start_date).toBe('2025-10-20')
    expect(recipeDescriptor(by('quote'))).toMatchObject({ connector: 'recipe', route: 'quote', providers: [], fields: [] })
  })
  it('validates recipes: unknown params in templates, unknown filters, bad transform inputs, duplicates', () => {
    const base: Recipe = { name: 'x', title: '{nope}', params: { type: 'object', properties: { a: { type: 'string' } } }, view: { preset: 'table' }, routes: [{ connector: 'c', route: 'r', params: { q: '{a|bogus}' }, when: { b: 'x' } }] }
    const issues = validateRecipe(base)
    expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/title references unknown param \{nope\}/), expect.stringMatching(/unknown filter \|bogus/), expect.stringMatching(/when\.b is not a param/)]))
    expect(() => parseRecipes([base])).toThrow(/recipe "x"/)
    expect(() => parseRecipes({ recipes: [by('quote'), by('quote')] })).toThrow(/duplicate recipe "quote"/)
    expect(() => parseRecipes([{ ...base, title: 'ok', routes: undefined, data: { main: { inputs: ['ghost'], code: 'result = ghost' } } }])).toThrow(/transform input "ghost"/)
    expect(() => parseRecipes([{ name: 'Bad Name', title: 't', params: {}, view: { preset: 'table' }, routes: [{ connector: 'c', route: 'r' }] }])).toThrow()
    expect(() => parseRecipes([{ name: 'noroutes', title: 't', params: {}, view: { preset: 'table' } }])).toThrow(/needs `routes`/)
  })
  it('options, earnings and macro are data graphs whose main transform reads the reserved `params` input (one expiration, the requested symbols, one series)', () => {
    for (const name of ['options', 'earnings', 'macro', 'news', 'volatility']) {
      const ds = recipeDatasets(by(name))
      expect(Object.keys(ds), name).toEqual(['raw', 'main'])
      const main = ds.main!
      if (!('inputs' in main)) throw new Error(`${name} main is not a transform`)
      expect(main.inputs).toEqual(['raw', RECIPE_PARAMS_INPUT])
      expect(validateRecipe(by(name))).toEqual([])
    }
    const x = expandRecipe(by('options'), { symbol: 'TSLA', expiration: '2026-10-23', type: 'put' })
    expect(x.routes).toEqual((x.data.raw as { routes: unknown[] }).routes) // main is a transform: raw's alternatives stand in
    expect(x.data.raw).toMatchObject({ routes: [{ connector: 'openbb', route: 'derivatives/options/chains', params: { symbol: 'TSLA', provider: 'cboe' } }, { connector: 'yahoo', route: 'options' }] })
    expect(x.params).toEqual({ symbol: 'TSLA', expiration: '2026-10-23', type: 'put', strikes: 10 })
    const macro = expandRecipe(by('macro'), { series: 'fed_funds' })
    expect('routes' in macro.data.raw! && macro.data.raw.routes.map((r) => r.route)).toEqual(['fixedincome/rate/effr'])
    // The params frame: one row, one column per param, arrays joined.
    const pf = recipeParamsFrame({ symbols: ['NVDA', 'AMD'], from: '2026-10-19', strikes: 10, both: true, nothing: undefined }, 5)
    expect(pf.columns).toEqual([{ name: 'symbols', type: 'string' }, { name: 'from', type: 'string' }, { name: 'strikes', type: 'number' }, { name: 'both', type: 'boolean' }])
    expect(pf.rows).toEqual([['NVDA, AMD', '2026-10-19', 10, true]])
    expect(pf.meta).toEqual({ connector: 'recipe', fetchedAt: 5, ttl: 0 })
    // `params` is not a dataset name a recipe may define, but it is always a valid input.
    const ok: Recipe = { name: 'x', title: 't', params: { type: 'object', properties: { a: { type: 'string' } } }, view: { preset: 'table' }, data: { raw: { routes: [{ connector: 'c', route: 'r', params: {} }] }, main: { inputs: ['raw', 'params'], code: 'result = raw' } } }
    expect(validateRecipe(ok)).toEqual([])
  })
  it('ohlcv and index rename the providers’ `date` to the kind’s `time` on every route, and renameColumns applies it to columns and field config', () => {
    for (const name of ['ohlcv', 'index']) {
      const ds = recipeDatasets(by(name)).main!
      if (!('routes' in ds)) throw new Error()
      for (const r of ds.routes) expect(r.rename, `${name} ${r.connector}`).toEqual({ date: 'time' })
    }
    const x = expandRecipe(by('ohlcv'), { symbols: ['NVDA'] })
    expect(x.routes[0]).toMatchObject({ connector: 'openbb', rename: { date: 'time' } })
    const f: Frame = { columns: [{ name: 'date', type: 'time' }, { name: 'close', type: 'number' }], rows: [[1, 2]], meta: { connector: 'c', fetchedAt: 0, ttl: 0, fields: { date: { label: 'Date' } } } }
    const out = renameColumns(f, { date: 'time' })
    expect(out.columns.map((c) => c.name)).toEqual(['time', 'close'])
    expect(out.meta.fields).toEqual({ time: { label: 'Date' } })
    expect(renameColumns(f, { nope: 'time' })).toBe(f)
    expect(renameColumns({ ...f, columns: [...f.columns, { name: 'time', type: 'time' }] }, { date: 'time' }).columns.map((c) => c.name)).toEqual(['date', 'close', 'time'])
  })
  it('dividends renders a table on both of its routes (OpenBB ex_dividend_date/amount, yahoo date/dividends.amount)', () => {
    const rules = builtinAnnotations()
    const mk = (connector: string, route: string, columns: [string, Frame['columns'][number]['type']][], row: unknown[]): Frame =>
      applyAnnotations({ columns: columns.map(([name, type]) => ({ name, type })), rows: [row, row], meta: { connector, fetchedAt: 0, ttl: 0 } }, { connector, route }, rules)
    const openbb = mk('openbb', 'equity/fundamental/dividends', [['symbol', 'string'], ['ex_dividend_date', 'time'], ['amount', 'number']], ['AAPL', 1, 0.27])
    const yahoo = mk('yahoo', 'chart', [['symbol', 'string'], ['date', 'time'], ['dividends.amount', 'number']], ['AAPL', 1, 0.25])
    for (const f of [openbb, yahoo]) {
      const c = controlFor(by('dividends').view, { main: datasetFieldsFrom(f) })
      expect(c?.kind).toBe('table')
      if (c?.kind !== 'table') throw new Error()
      expect(c.columns.length).toBeGreaterThanOrEqual(2)
      expect(c.columns.some((n) => /amount/.test(n))).toBe(true)
      expect(c.sort).toMatchObject({ dir: 'desc' })
    }
  })
  it('writes the prompt lines', () => {
    const lines = recipeSummaryLines([by('ohlcv'), by('quote')])
    expect(lines[0]).toMatch(/^ohlcv\(symbols\[\], interval\?=1m\|5m\|15m\|1h\|1d\|1w, range\?=1d\|5d\|1mo\|3mo\|6mo\|1y\|…, start\?[^)]*\) · Price bars per symbol over a range at an interval, long format with a symbol column\. · view price$/)
    expect(lines[1]).toMatch(/^quote\(symbols\[\]\)/)
  })
})
