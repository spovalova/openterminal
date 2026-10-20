import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ConnectorRegistry,
  DEFAULT_ROUTE_TTL,
  MS,
  MemoryCache,
  ParamError,
  RegistryError,
  TransformFailed,
  canonicalKey,
  defineConnector,
  inferFrame,
  parseAnnotations,
  parseRecipes,
  ttlForRoute,
  type Descriptor,
  type Frame,
  type Recipe,
  type TransformEngine,
} from '../src/index.js'
import { builtinRecipes } from '../src/node.js'

const quoteDescriptor: Descriptor = {
  connector: 'acme',
  route: 'equity/price/quote',
  summary: 'Quote',
  params: [{ name: 'symbol', type: 'string[]', required: true }],
  providers: ['fast', 'slow'],
  fields: [{ name: 'symbol', type: 'string' }, { name: 'last_price', type: 'number' }, { name: 'change_percent', type: 'number' }],
}
const barsDescriptor: Descriptor = {
  connector: 'acme',
  route: 'equity/price/historical',
  summary: 'Bars',
  params: [{ name: 'symbol', type: 'string[]', required: true }, { name: 'interval', type: 'string', required: false, default: '1d' }, { name: 'start_date', type: 'date', required: false }],
  providers: [],
  fields: [{ name: 'symbol', type: 'string' }, { name: 'date', type: 'time' }, { name: 'close', type: 'number' }],
}

/** A v2 connector: routes only. */
const acme = defineConnector({
  name: 'acme',
  config: z.object({}),
  descriptors: () => [quoteDescriptor, barsDescriptor],
  call: async (route, params) => {
    if (route === 'equity/price/quote') {
      const rows = (params.symbol as string[]).map((s) => ({ symbol: s, last_price: s === 'NVDA' ? 180 : 150, change_percent: -0.0563 }))
      return inferFrame(rows, { connector: 'acme' }, { descriptor: quoteDescriptor })
    }
    const rows = (params.symbol as string[]).flatMap((s) => [{ symbol: s, date: '2026-10-19', close: 1 }, { symbol: s, date: '2026-10-20', close: 2 }])
    return inferFrame(rows, { connector: 'acme' }, { descriptor: barsDescriptor })
  },
})

const annotations = parseAnnotations({ '*:*:change_percent': { unit: 'fraction', label: 'Chg %' }, 'acme:equity/price/quote:last_price': { unit: 'usd', key: true } })

describe('defineConnector v2', () => {
  it('accepts descriptors + call', async () => {
    expect((await acme.descriptors()).map((d) => d.route)).toEqual(['equity/price/quote', 'equity/price/historical'])
  })
  it('refuses half a definition and an empty one', () => {
    expect(() => defineConnector({ name: 'x', config: z.object({}), descriptors: () => [] } as never)).toThrow(/no call/)
    expect(() => defineConnector({ name: 'x', config: z.object({}), call: async () => ({ columns: [], rows: [], meta: { connector: 'x', fetchedAt: 0, ttl: 0 } }) } as never)).toThrow(/no descriptors/)
    expect(() => defineConnector({ name: 'x', config: z.object({}) } as never)).toThrow(/no descriptors/)
  })
})

describe('ttlForRoute', () => {
  it('follows the section 17 table', () => {
    expect(ttlForRoute('equity/price/quote')).toBe(10 * MS.second)
    expect(ttlForRoute('quote')).toBe(10 * MS.second)
    expect(ttlForRoute('equity/price/historical', { interval: '5m' })).toBe(MS.minute)
    expect(ttlForRoute('equity/price/historical', { interval: '1d' })).toBe(10 * MS.minute)
    expect(ttlForRoute('index/price/historical')).toBe(10 * MS.minute)
    expect(ttlForRoute('chart', { interval: '1h' })).toBe(MS.minute)
    expect(ttlForRoute('news/company')).toBe(5 * MS.minute)
    expect(ttlForRoute('company-news')).toBe(5 * MS.minute)
    expect(ttlForRoute('equity/calendar/earnings')).toBe(MS.hour)
    expect(ttlForRoute('economy/calendar')).toBe(MS.hour)
    expect(ttlForRoute('calendar/earnings')).toBe(MS.hour)
    expect(ttlForRoute('equity/fundamental/metrics')).toBe(MS.day)
    expect(ttlForRoute('equity/ownership/insider_trading')).toBe(MS.day)
    expect(ttlForRoute('derivatives/options/chains')).toBe(MS.minute)
    expect(ttlForRoute('fixedincome/government/treasury_rates')).toBe(DEFAULT_ROUTE_TTL)
  })
})

describe('ConnectorRegistry.run', () => {
  const build = (opts: { transform?: TransformEngine; cache?: MemoryCache } = {}) => {
    const r = new ConnectorRegistry({ recipes: builtinRecipes(), annotations, cache: opts.cache ?? new MemoryCache(), transform: opts.transform, now: () => 1_000 })
    r.register(acme, {})
    return r
  }

  it('runs a route: validates params, annotates, stamps ttl, lineage and fields', async () => {
    const r = build()
    const f = await r.run({ connector: 'acme', route: 'equity/price/quote', params: { symbol: 'NVDA,AMD', provider: 'fast' } })
    expect(f.columns.map((c) => c.name)).toEqual(['symbol', 'last_price', 'change_percent'])
    expect(f.rows).toEqual([['NVDA', 180, -5.63], ['AMD', 150, -5.63]])
    expect(f.meta).toMatchObject({ connector: 'acme', ttl: 10_000, lineage: { connector: 'acme', route: 'equity/price/quote', params: { symbol: ['NVDA', 'AMD'], provider: 'fast' }, provider: 'fast' } })
    expect(f.meta.fields).toEqual({ change_percent: { unit: 'percent', label: 'Chg %' }, last_price: { unit: 'usd', key: true } })
  })
  it('rejects bad params with a ParamError and unknown routes and connectors with a RegistryError', async () => {
    const r = build()
    await expect(r.run({ connector: 'acme', route: 'equity/price/quote', params: {} })).rejects.toBeInstanceOf(ParamError)
    await expect(r.run({ connector: 'acme', route: 'equity/price/quote', params: { symbol: 'X', provider: 'nope' } })).rejects.toThrow(/provider "nope"/)
    await expect(r.run({ connector: 'acme', route: 'nope', params: {} })).rejects.toThrow(/has no route "nope"/)
    await expect(r.run({ connector: 'ghost', route: 'x', params: {} })).rejects.toBeInstanceOf(RegistryError)
  })
  it('caches by canonical key and bypasses on request', async () => {
    const cache = new MemoryCache(() => 1_000)
    const r = build({ cache })
    const q = { connector: 'acme', route: 'equity/price/historical', params: { symbol: ['NVDA'], interval: '1d' } }
    const a = await r.run(q)
    expect(cache.size).toBe(1)
    expect(cache.getByKey(canonicalKey(q))).toBe(a)
    const b = await r.run({ connector: 'acme', route: 'equity/price/historical', params: { interval: '1d', symbol: ['NVDA'] } })
    expect(b).toBe(a)
    const c = await r.run(q, { bypassCache: true })
    expect(c).not.toBe(a)
  })
  it('runs a recipe through its alternatives in order and falls back on error', async () => {
    const log = vi.fn()
    const r = new ConnectorRegistry({ recipes: builtinRecipes(), annotations, cache: new MemoryCache(), log })
    // The quote recipe asks yahoo first (phase 2); when yahoo fails, OpenBB's route answers.
    const openbb = defineConnector({
      name: 'openbb',
      config: z.object({}),
      descriptors: () => [quoteDescriptor].map((d) => ({ ...d, connector: 'openbb', providers: ['yfinance'] })),
      call: async (_route, params) => inferFrame((params.symbol as string[]).map((s) => ({ symbol: s, last_price: 99, change_percent: 0.01 })), { connector: 'openbb' }),
    })
    const flaky = defineConnector({
      name: 'yahoo',
      config: z.object({}),
      descriptors: () => [{ connector: 'yahoo', route: 'quote', summary: 'Yahoo quote', params: [{ name: 'symbols', type: 'string[]', required: true }], providers: [], fields: [{ name: 'symbol', type: 'string' }, { name: 'regularMarketPrice', type: 'number' }] }],
      call: async () => {
        throw new Error('boom')
      },
    })
    r.register(openbb, {})
    r.register(flaky, {})
    const f = await r.run({ recipe: 'quote', params: { symbols: ['MU'] } })
    expect(f.meta.connector).toBe('openbb')
    expect(f.meta.lineage).toMatchObject({ connector: 'openbb', route: 'equity/price/quote', recipe: 'quote' })
    expect(f.rows).toEqual([['MU', 99, 1]])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[yahoo] quote failed: boom'))
    await expect(r.run({ recipe: 'holdings', params: { symbol: 'SMH' } })).rejects.toThrow(/failed on every route/)
    await expect(r.run({ recipe: 'nope', params: {} })).rejects.toThrow(/unknown recipe "nope"/)
  })
  it('applies a recipe route’s renames to the frame (the price routes’ `date` becomes the kind’s `time`)', async () => {
    const r = new ConnectorRegistry({
      recipes: [{ name: 'bars', title: 'bars', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'price' }, routes: [{ connector: 'acme', route: 'equity/price/historical', params: { symbol: '{symbols}' }, rename: { date: 'time' } }] }],
      annotations: parseAnnotations({ '*:*:date': { label: 'Date', priority: 1 } }),
    })
    r.register(acme, {})
    const f = await r.run({ recipe: 'bars', params: { symbols: ['NVDA'] } })
    expect(f.columns.map((c) => c.name)).toEqual(['symbol', 'time', 'close'])
    expect(f.meta.fields!.time).toMatchObject({ label: 'Date' })
    expect(f.meta.fields!.date).toBeUndefined()
    const real = builtinRecipes().find((x) => x.name === 'ohlcv')!
    expect(real.routes!.every((x) => x.rename?.date === 'time')).toBe(true)
  })
  it('binds the recipe’s validated params as the `params` input of its transforms', async () => {
    const seen: Record<string, Frame>[] = []
    const engine: TransformEngine = {
      run: vi.fn(async (inputs: Record<string, Frame>) => {
        seen.push(inputs)
        return inputs.raw!
      }),
    }
    const r = new ConnectorRegistry({
      recipes: [{ name: 'pick', title: 'pick', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } }, strikes: { type: 'integer', default: 10 } }, required: ['symbols'] }, view: { preset: 'table' }, data: { raw: { routes: [{ connector: 'acme', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] }, main: { inputs: ['raw', 'params'], code: 'result = raw' } } }],
      annotations,
      transform: engine,
    })
    r.register(acme, {})
    const f = await r.run({ recipe: 'pick', params: { symbols: ['NVDA', 'AMD'] } })
    expect(f.rows).toHaveLength(2)
    expect(Object.keys(seen[0]!).sort()).toEqual(['params', 'raw'])
    expect(seen[0]!.params!.columns.map((c) => c.name)).toEqual(['symbols', 'strikes'])
    expect(seen[0]!.params!.rows).toEqual([['NVDA, AMD', 10]])
    expect(f.meta.lineage).toMatchObject({ recipe: 'pick', inputs: { params: { connector: 'recipe' } } })
  })
  it('treats a cached recipe frame from an older recipe definition as a miss (the persistent cache outlives recipes.yml edits)', async () => {
    const cache = new MemoryCache()
    const recipe: Recipe = { name: 'q', title: 'q', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'table' }, routes: [{ connector: 'acme', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] }
    const r = new ConnectorRegistry({ recipes: [recipe], annotations, cache })
    r.register(acme, {})
    const q = { recipe: 'q', params: { symbols: ['NVDA'] } }
    const first = await r.run(q)
    expect(first.meta.lineage?.recipeVersion).toMatch(/^[0-9a-f]{8}$/)
    expect(await r.run(q)).toBe(first) // a hit while the definition is the same
    // The same recipe name with a changed definition (a rename added): the cached frame is stale.
    r.setRecipes([{ ...recipe, routes: [{ ...recipe.routes![0]!, rename: { last_price: 'last' } }] }])
    const second = await r.run(q)
    expect(second).not.toBe(first)
    expect(second.columns.map((c) => c.name)).toContain('last')
    expect(second.meta.lineage?.recipeVersion).not.toBe(first.meta.lineage?.recipeVersion)
    expect(await r.run(q)).toBe(second)
  })
  it('tries the next alternative when a route answers no rows, and returns the empty frame only when every alternative is empty', async () => {
    const log = vi.fn()
    const r = new ConnectorRegistry({
      recipes: [
        { name: 'est', title: 'est', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'facts' }, routes: [{ connector: 'blank', route: 'equity/price/quote', params: { symbol: '{symbols}' } }, { connector: 'acme', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] },
        { name: 'none', title: 'none', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'facts' }, routes: [{ connector: 'blank', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] },
      ],
      annotations,
      log,
    })
    const blank = defineConnector({
      name: 'blank',
      config: z.object({}),
      descriptors: () => [{ ...quoteDescriptor, connector: 'blank' }],
      call: async () => inferFrame([], { connector: 'blank' }, { descriptor: quoteDescriptor }),
    })
    r.register(blank, {})
    r.register(acme, {})
    const f = await r.run({ recipe: 'est', params: { symbols: ['TSLA'] } })
    expect(f.meta.connector).toBe('acme')
    expect(f.rows).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[blank] equity/price/quote answered no rows'))
    const none = await r.run({ recipe: 'none', params: { symbols: ['TSLA'] } })
    expect(none.rows).toHaveLength(0)
    expect(none.meta.connector).toBe('blank')
  })
  it('does not cache an empty frame (a provider hiccup must not stand for the whole TTL)', async () => {
    let calls = 0
    const flaky = defineConnector({
      name: 'acme',
      config: z.object({}),
      descriptors: () => [quoteDescriptor],
      call: async (_route, params) => {
        calls += 1
        return inferFrame(calls === 1 ? [] : (params.symbol as string[]).map((s) => ({ symbol: s, last_price: 1, change_percent: 0 })), { connector: 'acme' }, { descriptor: quoteDescriptor })
      },
    })
    const r = new ConnectorRegistry({ annotations, cache: new MemoryCache() })
    r.register(flaky, {})
    const q = { connector: 'acme', route: 'equity/price/quote', params: { symbol: ['NVDA'] } }
    expect((await r.run(q)).rows).toHaveLength(0)
    expect((await r.run(q)).rows).toHaveLength(1) // asked again, not served from the cache
    expect((await r.run(q)).rows).toHaveLength(1)
    expect(calls).toBe(2)
  })
  it('applies a recipe’s ttl and field overrides', async () => {
    const r = new ConnectorRegistry({
      recipes: [{ name: 'q', title: 'q', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'table' }, ttl: 5, fields: { last_price: { label: 'Last' } }, routes: [{ connector: 'acme', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] }],
      annotations,
    })
    r.register(acme, {})
    const f = await r.run({ recipe: 'q', params: { symbols: ['NVDA'] } })
    expect(f.meta.ttl).toBe(5)
    expect(f.meta.fields!.last_price).toEqual({ unit: 'usd', key: true, label: 'Last' })
  })
  it('runs a transform through the injected engine with its inputs resolved, and carries field config and lineage', async () => {
    const engine: TransformEngine = {
      run: vi.fn(async (inputs: Record<string, Frame>, _code: string) => {
        const q = inputs.q!
        return { columns: [...q.columns, { name: 'pe', type: 'number' as const }], rows: q.rows.map((r) => [...r, 42]), meta: { connector: 'x', fetchedAt: 0, ttl: 0 } }
      }),
    }
    const r = build({ transform: engine })
    const f = await r.run({ inputs: { q: { connector: 'acme', route: 'equity/price/quote', params: { symbol: ['NVDA'] } }, b: { connector: 'acme', route: 'equity/price/historical', params: { symbol: ['NVDA'] } } }, code: 'result = q', columns: { pe: { unit: 'ratio', label: 'P/E' } } })
    expect(f.rows).toEqual([['NVDA', 180, -5.63, 42]])
    expect(f.meta.connector).toBe('transform')
    expect(f.meta.ttl).toBe(10_000) // the shortest input ttl
    expect(f.meta.fields).toEqual({ change_percent: { unit: 'percent', label: 'Chg %' }, last_price: { unit: 'usd', key: true }, pe: { unit: 'ratio', label: 'P/E' } })
    expect(f.meta.lineage).toMatchObject({ code: 'result = q', inputs: { q: { route: 'equity/price/quote' }, b: { route: 'equity/price/historical' } } })
    expect(engine.run).toHaveBeenCalledTimes(1)
  })
  it('surfaces engine errors as TransformFailed with the traceback, and refuses to run without an engine', async () => {
    const engine: TransformEngine = { run: async () => ({ error: 'NameError: x', traceback: 'Traceback (most recent call last) …' }) }
    const r = build({ transform: engine })
    const q = { inputs: { q: { connector: 'acme', route: 'equity/price/quote', params: { symbol: ['NVDA'] } } }, code: 'result = x' }
    const err = await r.run(q).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransformFailed)
    expect((err as TransformFailed).traceback).toMatch(/Traceback/)
    await expect(build().run(q)).rejects.toThrow(/no transform engine/)
  })
  it('builds the catalog from every healthy connector and memoizes it until the next register', async () => {
    const r = build()
    const c1 = await r.catalog()
    expect(c1.connectors()).toEqual(['acme'])
    expect(c1.get('acme', 'equity/price/quote')).toBeDefined()
    expect(c1.find('quote price', { connectors: ['acme'] })[0]!.route).toBe('equity/price/quote')
    expect(await r.catalog()).toBe(c1)
    r.register(defineConnector({ name: 'keyed', config: z.object({ apiKey: z.string().min(1) }), descriptors: () => [{ ...quoteDescriptor, connector: 'keyed' }], call: async () => inferFrame([], { connector: 'keyed' }) }), {})
    const c2 = await r.catalog()
    expect(c2).not.toBe(c1)
    expect(c2.connectors()).not.toContain('keyed') // missing_config connectors are left out
    expect(r.connectors().map((c) => c.status)).toEqual(['ok', 'missing_config'])
    expect(r.recipes().length).toBeGreaterThanOrEqual(22)
  })
})

describe('ConnectorRegistry.usableRecipes', () => {
  const quote = (connector: string, route = 'equity/price/quote') => ({ connector, route, params: { symbol: '{symbols}' } })
  const recipe = (name: string, dataset: object) => ({ name, title: name, params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'table' }, ...dataset })
  const recipes = parseRecipes([
    recipe('on_acme', { routes: [quote('acme')] }),
    recipe('falls_back', { routes: [quote('openbb'), quote('acme')] }),
    recipe('openbb_only', { routes: [quote('openbb')] }),
    recipe('unlisted_route', { routes: [quote('acme', 'equity/price/nope')] }),
    recipe('needs_a_key', { routes: [quote('keyed')] }),
    recipe('half_dead', { data: { a: { routes: [quote('acme')] }, b: { routes: [quote('openbb')] }, main: { inputs: ['a', 'b'], code: 'result = a' } } }),
    recipe('graph', { data: { raw: { routes: [quote('openbb'), quote('acme')] }, main: { inputs: ['raw'], code: 'result = raw' } } }),
  ])
  const keyed = defineConnector({ name: 'keyed', config: z.object({ apiKey: z.string().min(1) }), descriptors: () => [{ ...quoteDescriptor, connector: 'keyed' }], call: async () => inferFrame([], { connector: 'keyed' }) })
  const names = (rs: readonly Recipe[]) => rs.map((r) => r.name)

  it('keeps a recipe with at least one route on a registered, healthy connector that lists it', async () => {
    const r = new ConnectorRegistry({ recipes })
    r.register(acme, {})
    r.register(keyed, {}) // missing_config: registered but not healthy
    expect(names(await r.usableRecipes())).toEqual(['on_acme', 'falls_back', 'graph'])
    // recipes() still lists everything: running a hidden recipe keeps its "connector is not registered" error.
    expect(names(r.recipes())).toHaveLength(recipes.length)
    await expect(r.run({ recipe: 'openbb_only', params: { symbols: ['NVDA'] } })).rejects.toThrow(/connector "openbb" is not registered/)
  })

  it('needs every route dataset of a recipe to have a usable route, not just one', async () => {
    const r = new ConnectorRegistry({ recipes })
    r.register(acme, {})
    expect(names(await r.usableRecipes())).not.toContain('half_dead')
    r.register(defineConnector({ name: 'openbb', config: z.object({}), descriptors: () => [{ ...quoteDescriptor, connector: 'openbb' }], call: async () => inferFrame([], { connector: 'openbb' }) }), {})
    expect(names(await r.usableRecipes())).toContain('half_dead')
    expect(names(await r.usableRecipes())).toContain('openbb_only')
  })

  it('follows registration: a key saved later brings the recipe back, and a connector whose catalog is empty hides its recipes', async () => {
    const r = new ConnectorRegistry({ recipes })
    r.register(acme, {})
    expect(names(await r.usableRecipes())).not.toContain('needs_a_key')
    r.register(keyed, { apiKey: 'k' })
    expect(names(await r.usableRecipes())).toContain('needs_a_key')
    // OpenBB registered but unreachable: its descriptors fail, the catalog lists nothing, its recipes are dead.
    const down = defineConnector({ name: 'openbb', config: z.object({}), descriptors: async () => { throw new Error('connect ECONNREFUSED') }, call: async () => inferFrame([], { connector: 'openbb' }) })
    r.register(down, {})
    expect(names(await r.usableRecipes())).not.toContain('openbb_only')
    expect(names(await r.usableRecipes())).toContain('falls_back')
  })

  it('hides every built-in recipe from a registry whose connectors serve none of their routes', async () => {
    const r = new ConnectorRegistry({ recipes: builtinRecipes() })
    r.register(acme, {})
    expect(await r.usableRecipes()).toEqual([])
    expect(r.recipes().length).toBeGreaterThanOrEqual(22)
  })
})
