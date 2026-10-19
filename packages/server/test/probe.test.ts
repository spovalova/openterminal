import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConnectorRegistry, defineConnector, descriptorsFromOpenApi, inferFrame, type Descriptor } from '@terminal/core'
import { MemoryLivenessStore } from '../src/liveness.js'
import { KEYLESS_PROVIDERS, classifyError, createProbeFn, keylessAlternatives, probeCatalog, probeRoute, renderSummary, sampleParams, sampleValue } from '../src/probe.js'

/** Monday 2026-10-19 12:00 ET. Last week is Oct 12 to Oct 16. */
const NOW = Date.UTC(2026, 9, 19, 16)
const fixture = descriptorsFromOpenApi(JSON.parse(readFileSync(new URL('../../core/test/fixtures/openbb-openapi.json', import.meta.url), 'utf8')), 'openbb')
const by = (route: string) => fixture.find((d) => d.route === route)!

describe('sampleParams', () => {
  it('fills required params and the symbol from the sample set, dates from last week, and applies the descriptor defaults', () => {
    const historical = sampleParams(by('equity/price/historical'), NOW)
    expect(historical).toMatchObject({ params: { symbol: ['NVDA'] } })
    expect('params' in historical && historical.params.start_date).toBeUndefined() // optional dates are left to the route's default window
    const holdings = sampleParams(by('etf/holdings'), NOW)
    expect('params' in holdings && [holdings.params.symbol].flat()[0]).toBe('SPY') // a plain string on this route
    expect(sampleParams(by('index/price/historical'), NOW)).toMatchObject({ params: { symbol: ['^GSPC'] } })
    expect(sampleParams(by('currency/price/historical'), NOW)).toMatchObject({ params: { symbol: ['EURUSD'] } })
    expect(sampleParams(by('equity/search'), NOW)).toMatchObject({ params: { query: 'nvidia' } })
    expect(sampleParams(by('economy/calendar'), NOW)).toMatchObject({ params: {} })
    const spot = sampleParams(by('commodity/price/spot'), NOW)
    expect('params' in spot).toBe(true)
  })
  it('gives sensible values per type and name, and skips a route whose required param has no sample', () => {
    const base: Descriptor = { connector: 'x', route: 'eia/thing', summary: '', params: [], providers: [], fields: [] }
    expect(sampleValue({ name: 'start_date', type: 'date', required: true }, base, NOW)).toBe('2026-10-12')
    expect(sampleValue({ name: 'end_date', type: 'date', required: true }, base, NOW)).toBe('2026-10-16')
    expect(sampleValue({ name: 'date', type: 'date', required: true }, base, NOW)).toBe('2026-10-16')
    expect(sampleValue({ name: 'country', type: 'string', required: true, enum: ['germany', 'united_states'] }, base, NOW)).toBe('united_states')
    expect(sampleValue({ name: 'country', type: 'string[]', required: true, enum: ['germany', 'france'] }, base, NOW)).toEqual(['germany'])
    expect(sampleValue({ name: 'frequency', type: 'string', required: true, enum: ['monthly', 'annual'], default: 'annual' }, base, NOW)).toBe('annual')
    expect(sampleValue({ name: 'limit', type: 'integer', required: true }, base, NOW)).toBe(10)
    expect(sampleValue({ name: 'period', type: 'integer', required: true }, base, NOW)).toBe(1)
    expect(sampleValue({ name: 'use_cache', type: 'boolean', required: true }, base, NOW)).toBe(false)
    expect(sampleValue({ name: 'modules', type: 'string[]', required: true }, base, NOW)).toEqual(['price'])
    expect(sampleValue({ name: 'dataflow_id', type: 'string', required: true }, base, NOW)).toBeUndefined()
    expect(sampleParams({ ...base, params: [{ name: 'dataflow_id', type: 'string', required: true }] }, NOW)).toEqual({ skip: 'no sample for required param "dataflow_id"' })
    expect(sampleParams({ ...base, params: [{ name: 'symbol', type: 'string', required: true, enum: ['AAPL'] }] }, NOW)).toMatchObject({ skip: expect.stringMatching(/rejected/) })
  })
})

describe('classifyError', () => {
  it('labels the failure families the probe reports', () => {
    expect(classifyError('OpenBB API not running at http://127.0.0.1:6900. Install and start it:')).toBe('down')
    expect(classifyError('OpenBB 401 on /eia/x: Missing credential api_key')).toBe('needs key')
    expect(classifyError('OpenBB 500 on /x: Error: fred requires an API key.')).toBe('needs key')
    expect(classifyError('timed out after 20000 ms')).toBe('timeout')
    expect(classifyError('OpenBB 404 on /x: Not Found')).toBe('not found')
    expect(classifyError('OpenBB 422 on /x: field required')).toBe('bad params')
    expect(classifyError('openbb:x: "symbol" is required')).toBe('bad params')
    expect(classifyError('OpenBB 500 on /x: Internal Server Error')).toBe('provider error')
    expect(classifyError('OpenBB 503 on /x: Service Unavailable')).toBe('http 5xx')
    expect(classifyError('OpenBB 418 on /x: teapot')).toBe('http 4xx')
    expect(classifyError('HTTP 429 for https://finnhub.io')).toBe('rate limited')
    expect(classifyError('OpenBB response for /x has no results field')).toBe('no envelope')
    expect(classifyError('yfinance returned no data for X')).toBe('empty')
    expect(classifyError('something else entirely')).toBe('other')
  })
})

/** A v2 connector with one route per outcome the probe must handle. */
const routes: Record<string, Descriptor> = {
  ok: { connector: 'fake', route: 'equity/price/quote', summary: 'ok', params: [{ name: 'symbol', type: 'string[]', required: true }], providers: [], fields: [{ name: 'symbol', type: 'string' }, { name: 'last_price', type: 'number' }] },
  keyed: { connector: 'fake', route: 'economy/cpi', summary: 'needs a key on its default provider', params: [{ name: 'country', type: 'string', required: false, default: 'united_states' }], providers: ['fred', 'oecd'], fields: [{ name: 'date', type: 'time' }, { name: 'value', type: 'number' }] },
  skip: { connector: 'fake', route: 'imf/dataflow', summary: 'no sample', params: [{ name: 'dataflow_id', type: 'string', required: true }], providers: [], fields: [] },
  empty: { connector: 'fake', route: 'equity/calendar/ipo', summary: 'answers nothing', params: [], providers: [], fields: [{ name: 'symbol', type: 'string' }] },
  dead: { connector: 'fake', route: 'eia/petroleum', summary: 'breaks', params: [], providers: ['eia'], fields: [] },
  slow: { connector: 'fake', route: 'news/world', summary: 'never answers', params: [], providers: [], fields: [] },
  retry: { connector: 'fake', route: 'news/slow', summary: 'times out once, then answers', params: [], providers: [], fields: [] },
}
const calls: { route: string; params: Record<string, unknown> }[] = []
let slowCalls = 0
const fake = defineConnector({
  name: 'fake',
  config: z.object({}),
  descriptors: () => Object.values(routes),
  call: async (route, params, ctx) => {
    calls.push({ route, params })
    switch (route) {
      case 'equity/price/quote':
        return inferFrame((params.symbol as string[]).map((s) => ({ symbol: s, last_price: 1 })), { connector: 'fake' }, { descriptor: routes.ok })
      case 'economy/cpi':
        if (params.provider !== 'oecd') throw new Error('OpenBB 500 on /economy/cpi: fred requires an API key (credential fred_api_key)')
        return inferFrame([{ date: '2026-09-01', value: 0.03 }], { connector: 'fake' }, { descriptor: routes.keyed })
      case 'equity/calendar/ipo':
        return inferFrame([], { connector: 'fake' }, { descriptor: routes.empty })
      case 'eia/petroleum':
        throw new Error('OpenBB 500 on /eia/petroleum: Internal Server Error')
      case 'news/world':
        return new Promise((_resolve, reject) => ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason)))
      case 'news/slow':
        if (slowCalls++ === 0) return new Promise((_resolve, reject) => ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason)))
        return inferFrame([{ a: 1 }], { connector: 'fake' })
    }
    throw new Error(`unexpected ${route}`)
  },
})

describe('probeCatalog', () => {
  it('calls every route once with sample params, retries a keyless provider on a key error, records liveness on the catalog and in the store', async () => {
    calls.length = 0
    slowCalls = 0
    const registry = new ConnectorRegistry({ now: () => NOW })
    registry.register(fake, {})
    const catalog = await registry.catalog()
    const store = new MemoryLivenessStore()
    const seen: string[] = []
    const summary = await probeCatalog(registry, catalog, { store, now: () => NOW, concurrency: 3, timeoutMs: 50, onResult: (r) => seen.push(r.route) })

    expect(summary).toMatchObject({ total: 7, called: 6, ok: 4, failed: 2, skipped: 1, empty: 1, keylessRetries: 1, timeoutRetries: 1 })
    expect(summary.byConnector.fake).toEqual({ routes: 7, ok: 4, failed: 2, skipped: 1 })
    expect(summary.results.find((r) => r.route === 'news/slow')).toMatchObject({ ok: true, rows: 1, retried: 'timeout' })
    expect(catalog.get('fake', 'news/slow')!.liveness).toMatchObject({ ok: true, rows: 1 })
    expect(summary.byNamespace.equity).toEqual({ routes: 2, ok: 2 })
    expect(summary.errorClasses.map((e) => [e.errorClass, e.count])).toEqual([
      ['provider error', 1],
      ['timeout', 1], // news/world never answers, on the retry either
    ])
    expect(calls.filter((c) => c.route === 'news/world')).toHaveLength(2)
    expect(summary.errorClasses[0]!.examples[0]).toMatch(/fake:eia\/petroleum: OpenBB 500/)
    expect(seen.sort()).toEqual(Object.values(routes).map((d) => d.route).sort())

    const quote = calls.find((c) => c.route === 'equity/price/quote')!
    expect(quote.params).toEqual({ symbol: ['NVDA'] })
    const cpi = calls.filter((c) => c.route === 'economy/cpi')
    expect(cpi.map((c) => c.params.provider)).toEqual([undefined, 'oecd']) // default provider first, then the keyless one

    expect(catalog.get('fake', 'equity/price/quote')!.liveness).toMatchObject({ checkedAt: NOW, ok: true, rows: 1, sampleColumns: ['symbol', 'last_price'] })
    expect(catalog.get('fake', 'economy/cpi')!.liveness).toMatchObject({ ok: true, rows: 1 })
    expect(catalog.get('fake', 'equity/calendar/ipo')!.liveness).toMatchObject({ ok: true, rows: 0 })
    expect(catalog.get('fake', 'eia/petroleum')!.liveness).toMatchObject({ ok: false, error: expect.stringMatching(/OpenBB 500/) })
    expect(catalog.get('fake', 'news/world')!.liveness).toMatchObject({ ok: false, error: expect.stringMatching(/timed out after 50 ms/) })
    expect(catalog.get('fake', 'imf/dataflow')!.liveness).toBeUndefined() // skipped routes stay unknown
    expect(catalog.stats().fake).toMatchObject({ routes: 7, alive: 4, dead: 2, unknown: 1 })

    const rows = await store.all()
    expect(rows).toHaveLength(6)
    expect(rows.find((r) => r.route === 'economy/cpi')).toEqual({ connector: 'fake', route: 'economy/cpi', checkedAt: NOW, ok: true, rows: 1, ms: expect.any(Number), sampleColumns: ['date', 'value'] })
    expect(rows.every((r) => !('params' in r) && !('provider' in r) && !('errorClass' in r))).toBe(true)

    const text = renderSummary(summary)
    expect(text).toMatch(/7 routes: 4 answered \(1 with no rows\), 2 failed, 1 skipped/)
    expect(text).toMatch(/1 only on the quiet retry/)
    expect(text).toMatch(/provider error: 1/)
  })
  it('pauses on a down connector, retries the route once it is back, and never records down as liveness', async () => {
    let downCalls = 0
    let healthy = false
    const flaky = defineConnector({
      name: 'flaky',
      config: z.object({}),
      // Fresh copies without the liveness the earlier tests stamped on the shared `routes` objects.
      descriptors: () => [{ ...routes.ok!, connector: 'flaky', liveness: undefined }, { ...routes.empty!, connector: 'flaky', liveness: undefined }],
      health: async () => {
        if (!healthy) throw new Error('OpenBB API not running at http://127.0.0.1:6900')
      },
      call: async (route) => {
        if (!healthy) {
          downCalls++
          throw new Error('OpenBB API not running at http://127.0.0.1:6900. Install and start it:')
        }
        return inferFrame(route === 'equity/price/quote' ? [{ symbol: 'NVDA', last_price: 1 }] : [], { connector: 'flaky' })
      },
    })
    const registry = new ConnectorRegistry({ now: () => NOW })
    registry.register(flaky, {})
    const catalog = await registry.catalog()
    const logs: string[] = []
    setTimeout(() => (healthy = true), 30)
    const s = await probeCatalog(registry, catalog, { now: () => NOW, concurrency: 2, downPollMs: 10, downWaitMs: 1_000, log: (m) => logs.push(m) })
    expect(s).toMatchObject({ total: 2, ok: 2, failed: 0, skipped: 0 })
    expect(downCalls).toBeGreaterThanOrEqual(1)
    expect(logs.some((l) => /flaky is down; waiting/.test(l)) && logs.some((l) => /flaky is back/.test(l))).toBe(true)
    expect(catalog.get('flaky', 'equity/price/quote')!.liveness).toMatchObject({ ok: true, rows: 1 })

    // Never comes back: the rest is skipped, nothing is recorded, the catalog keeps the routes unknown.
    healthy = false
    const store = new MemoryLivenessStore()
    const catalog2 = await new ConnectorRegistry({ now: () => NOW }).catalog()
    const r2 = new ConnectorRegistry({ now: () => NOW })
    r2.register(flaky, {})
    const cat = await r2.catalog()
    const s2 = await probeCatalog(r2, cat, { now: () => NOW, concurrency: 1, downPollMs: 5, downWaitMs: 20, store })
    expect(s2).toMatchObject({ total: 2, ok: 0, failed: 0, skipped: 2 })
    expect(s2.results.every((r) => r.skipped === 'connector down')).toBe(true)
    expect(cat.get('flaky', 'equity/price/quote')!.liveness).toBeUndefined()
    expect(await store.all()).toEqual([])
    expect(catalog2.size).toBe(0)
  })
  it('createProbeFn runs over the registry’s catalog into the store and answers the four numbers the data route expects', async () => {
    slowCalls = 0
    const registry = new ConnectorRegistry({ now: () => NOW })
    registry.register(fake, {})
    const store = new MemoryLivenessStore()
    const logs: string[] = []
    const probe = createProbeFn({ registry, store, log: (m) => logs.push(m), defaults: { now: () => NOW, timeoutMs: 50 } })
    const first = probe({ concurrency: 3 })
    expect(probe({})).toBe(first) // one run at a time
    const r = await first
    expect(r).toEqual({ probed: 6, alive: 4, dead: 2, ms: expect.any(Number) })
    expect((await store.all()).length).toBe(6)
    expect(logs.some((l) => /7 routes: 4 answered/.test(l))).toBe(true)
    const one = await probe({ connector: 'nobody' })
    expect(one).toEqual({ probed: 0, alive: 0, dead: 0, ms: expect.any(Number) })
  })
  it('honours connectors, match and limit, and probeRoute reports the provider that answered', async () => {
    const registry = new ConnectorRegistry({ now: () => NOW })
    registry.register(fake, {})
    const catalog = await registry.catalog()
    const only = await probeCatalog(registry, catalog, { now: () => NOW, match: (d) => d.route.startsWith('equity/'), timeoutMs: 50 })
    expect(only.total).toBe(2)
    slowCalls = 0
    const noRetry = await probeCatalog(registry, catalog, { now: () => NOW, match: (d) => d.route === 'news/slow', timeoutMs: 50, retryTimeouts: false })
    expect(noRetry).toMatchObject({ ok: 0, failed: 1, timeoutRetries: 0 })
    expect((await probeCatalog(registry, catalog, { now: () => NOW, connectors: ['other'] })).total).toBe(0)
    expect((await probeCatalog(registry, catalog, { now: () => NOW, limit: 1, timeoutMs: 50 })).total).toBe(1)
    const r = await probeRoute(registry, routes.keyed!, { now: () => NOW })
    expect(r).toMatchObject({ ok: true, provider: 'oecd', errorClass: 'needs key', params: { country: 'united_states', provider: 'oecd' } })
    const noKeyRetry = await probeRoute(registry, routes.keyed!, { now: () => NOW, keylessRetry: false })
    expect(noKeyRetry).toMatchObject({ ok: false, errorClass: 'needs key' })
    expect(keylessAlternatives(routes.keyed!, undefined)).toEqual(['oecd'])
    expect(keylessAlternatives(routes.dead!, undefined)).toEqual([])
    expect(KEYLESS_PROVIDERS).toContain('yfinance')
  })
})
