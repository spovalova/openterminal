// v2 (PLAN.md section 17): descriptors from a recorded openapi.json, the on-disk cache and its fallbacks, and
// `call` over the recorded envelopes. No network: the core fixture stands in for the live document.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameToObjects, parseParams, type Descriptor, type OpenApiDoc } from '@terminal/core'
import openbb from '../src/index.js'
import { applicableParams, callRoute, defaultProvider, fillSymbol, singleSymbol, toQuery, withProvider } from '../src/call.js'
import { defaultCatalogPath, descriptorsFor, fingerprintOpenApi, loadDescriptors, readCatalogCache, resetDescriptors } from '../src/descriptors.js'
import { BREAKER_MS, buildUrl, isDown, resetBreaker } from '../src/openbb-api.js'
import { BASE, NOW, connectionRefused, fakeCtx, fixture, status } from './helpers.js'

const OPENAPI_URL = 'http://127.0.0.1:6900/openapi.json'
const openapi = (): unknown => JSON.parse(readFileSync(new URL('../../../packages/core/test/fixtures/openbb-openapi.json', import.meta.url), 'utf8'))

let home: string
let catalogPath: string
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  home = mkdtempSync(join(tmpdir(), 'openbb-catalog-'))
  catalogPath = join(home, 'catalog', 'openbb.json')
  resetDescriptors()
  resetBreaker()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
  delete process.env.TERMINAL_HOME
})

const url = (path: string, params: Record<string, string | number | undefined>) => buildUrl('http://127.0.0.1:6900', path, params)

describe('descriptors()', () => {
  it('generates from openapi.json, writes the cache keyed by version and fingerprint, and serves the cache on the next load', async () => {
    const doc = openapi()
    const { ctx, calls, logs } = fakeCtx({ [OPENAPI_URL]: doc })
    const first = await loadDescriptors(ctx, { catalogPath })
    expect(first.source).toBe('generated')
    expect(first.descriptors).toHaveLength(38)
    expect(first.descriptors.every((d) => d.connector === 'openbb')).toBe(true)
    expect(first.version).toBe(String((doc as { info: { version: string } }).info.version))
    expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(logs.some((l) => /generated 38 descriptors/.test(l))).toBe(true)

    const cache = readCatalogCache(catalogPath)!
    expect(cache).toMatchObject({ connector: 'openbb', version: first.version, fingerprint: first.fingerprint, baseUrl: 'http://127.0.0.1:6900', generatedAt: NOW })
    expect(cache.descriptors).toHaveLength(38)

    const second = await loadDescriptors(ctx, { catalogPath })
    expect(second.source).toBe('cached')
    expect(second.descriptors.map((d) => d.route)).toEqual(first.descriptors.map((d) => d.route))
    expect(calls.filter((c) => c === OPENAPI_URL)).toHaveLength(2) // the document is fetched each time; only the generation is skipped
  })
  it('regenerates when the document changes (a new route, an upgrade)', async () => {
    const doc = openapi() as { paths: Record<string, unknown>; info: { version: string } }
    const { ctx } = fakeCtx({ [OPENAPI_URL]: doc })
    const first = await loadDescriptors(ctx, { catalogPath })
    const grown = { ...doc, paths: { ...doc.paths, '/api/v1/equity/price/nbbo': doc.paths['/api/v1/equity/price/quote'] } }
    const next = await loadDescriptors(fakeCtx({ [OPENAPI_URL]: grown }).ctx, { catalogPath })
    expect(next.source).toBe('generated')
    expect(next.fingerprint).not.toBe(first.fingerprint)
    expect(next.descriptors).toHaveLength(39)
    expect(fingerprintOpenApi({ ...(doc as OpenApiDoc), info: { version: '2' } }).fingerprint).not.toBe(first.fingerprint)
  })
  it('falls back to the cached file when the API is down, trips the breaker, and gives [] with no cache', async () => {
    const good = fakeCtx({ [OPENAPI_URL]: openapi() })
    await loadDescriptors(good.ctx, { catalogPath })
    const down = fakeCtx({ [OPENAPI_URL]: connectionRefused() })
    const r = await loadDescriptors(down.ctx, { catalogPath })
    expect(r.source).toBe('cached')
    expect(r.descriptors).toHaveLength(38)
    expect(r.error).toMatch(/not running/)
    expect(isDown(NOW + 1)).toBe(true)
    expect(down.logs.some((l) => /serving 38 cached descriptors/.test(l))).toBe(true)
    // While the breaker is open nothing is fetched.
    const again = await loadDescriptors(down.ctx, { catalogPath })
    expect(again.source).toBe('cached')
    expect(down.calls).toHaveLength(1)

    vi.setSystemTime(NOW + BREAKER_MS + 1)
    const none = await loadDescriptors(fakeCtx({ [OPENAPI_URL]: connectionRefused() }).ctx, { catalogPath: join(home, 'elsewhere', 'openbb.json') })
    expect(none).toMatchObject({ source: 'none', descriptors: [] })
  })
  it('ignores a corrupt or foreign cache file and a non-OpenAPI body', async () => {
    const { ctx } = fakeCtx({ [OPENAPI_URL]: openapi() })
    await loadDescriptors(ctx, { catalogPath })
    writeFileSync(catalogPath, '{not json', 'utf8')
    expect(readCatalogCache(catalogPath)).toBeUndefined()
    const r = await loadDescriptors(ctx, { catalogPath })
    expect(r.source).toBe('generated')
    writeFileSync(catalogPath, JSON.stringify({ connector: 'other', fingerprint: 'x', descriptors: [] }), 'utf8')
    expect(readCatalogCache(catalogPath)).toBeUndefined()
    const html = await loadDescriptors(fakeCtx({ [OPENAPI_URL]: '<html>' }).ctx, { catalogPath: join(home, 'none.json') })
    expect(html).toMatchObject({ source: 'none', error: expect.stringMatching(/not an OpenAPI document/) })
    const http = await loadDescriptors(fakeCtx({ [OPENAPI_URL]: status(500, 'boom', OPENAPI_URL) }).ctx, { catalogPath: join(home, 'none.json') })
    expect(http).toMatchObject({ source: 'none', error: expect.stringMatching(/openapi.json failed/) })
  })
  it('memoises per process and base URL, retries after an empty load, and the connector exposes it beside the 22 kind descriptors', async () => {
    const down = fakeCtx({ [OPENAPI_URL]: connectionRefused() })
    expect(await descriptorsFor(down.ctx, { catalogPath })).toEqual([])
    resetBreaker()
    const up = fakeCtx({ [OPENAPI_URL]: openapi() })
    const a = await descriptorsFor(up.ctx, { catalogPath })
    expect(a).toHaveLength(38)
    const b = await descriptorsFor(fakeCtx({}).ctx, { catalogPath }) // same base URL: no fetch
    expect(b).toBe(a)

    process.env.TERMINAL_HOME = home
    expect(defaultCatalogPath()).toBe(catalogPath)
    resetDescriptors()
    const all = await openbb.descriptors(fakeCtx({ [OPENAPI_URL]: openapi() }).ctx)
    expect(all).toHaveLength(38 + 22)
    expect(all.filter((d) => d.route === 'quote')).toHaveLength(1)
    expect(all.find((d) => d.route === 'equity/price/quote')!.providers).toEqual(['cboe', 'nasdaq', 'tmx', 'yfinance'])
    expect(openbb.mode).toBe('both')
  })
})

describe('call()', () => {
  const byRoute = async (route: string) => (await descriptorsFor(fakeCtx({ [OPENAPI_URL]: openapi() }).ctx, { catalogPath })).find((d) => d.route === route)!

  it('turns validated params into a query string: arrays joined by commas, provider through, nulls dropped', () => {
    expect(toQuery({ symbol: ['MU', 'SNDK'], provider: 'yfinance', limit: 5, extended_hours: false, start_date: '2026-10-01' })).toEqual({ symbol: 'MU,SNDK', provider: 'yfinance', limit: '5', extended_hours: 'false', start_date: '2026-10-01' })
    expect(toQuery({ symbol: [' ', ''] })).toEqual({})
    expect(singleSymbol({ symbol: ['NVDA'] })).toBe('NVDA')
    expect(singleSymbol({ symbol: 'NVDA' })).toBe('NVDA')
    expect(singleSymbol({ symbol: ['MU', 'SNDK'] })).toBeUndefined()
    expect(singleSymbol({ symbol: 'MU,SNDK' })).toBeUndefined()
    expect(singleSymbol({})).toBeUndefined()
  })
  it('answers a quote through inferFrame with the descriptor: provider values untouched, empty union columns dropped', async () => {
    const d = await byRoute('equity/price/quote')
    const params = parseParams(d, { symbol: 'MU,SNDK', provider: 'yfinance' })
    expect(params).toMatchObject({ provider: 'yfinance', symbol: ['MU', 'SNDK'], use_cache: true }) // validation applies the descriptor's defaults
    const { ctx, calls } = fakeCtx({ [url('/equity/price/quote', { provider: 'yfinance', symbol: 'MU,SNDK' })]: fixture('quote-MU-SNDK') }) // use_cache is cboe's, not sent
    const f = await callRoute('equity/price/quote', params, ctx, { catalogPath })
    expect(calls).toHaveLength(1)
    expect(f.meta.connector).toBe('openbb')
    const names = f.columns.map((c) => c.name)
    expect(names.slice(0, 4)).toEqual(['symbol', 'asset_type', 'name', 'exchange']) // descriptor order
    expect(names).toContain('last_price')
    expect(names).not.toContain('iv30') // a cboe-only field no yfinance row fills
    const rows = frameToObjects(f)
    expect(rows.map((r) => r.symbol)).toEqual(['SNDK', 'MU'])
    expect(rows[1]).toMatchObject({ last_price: 878.84, prev_close: 931.24, volume: 30145042 })
    expect(f.columns.find((c) => c.name === 'last_price')!.type).toBe('number')
  })
  it('fills the symbol on single-symbol historical rows and parses OpenBB dates as New York time', async () => {
    const d = await byRoute('equity/price/historical')
    const params = parseParams(d, { symbol: ['NVDA'], interval: '5m', start_date: '2026-10-13', provider: 'yfinance' })
    const { ctx, calls } = fakeCtx({ [url('/equity/price/historical', toQuery(applicableParams(d, params)))]: fixture('historical-NVDA-5m') })
    const f = await callRoute('equity/price/historical', params, ctx, { catalogPath })
    // Descriptor order (symbol sits after volume in OpenBB's merged model); vwap and the other empty union fields are dropped.
    expect(f.columns.map((c) => c.name).sort()).toEqual(['close', 'date', 'high', 'low', 'open', 'symbol', 'volume'])
    expect(f.columns.find((c) => c.name === 'date')!.type).toBe('time')
    const rows = frameToObjects(f)
    expect(rows[0]!.symbol).toBe('NVDA')
    expect(rows[0]!.date).toBe(Date.UTC(2026, 9, 13, 13, 30)) // 09:30 ET
    expect(rows).toHaveLength(3)
    expect(calls[0]).toMatch(/adjustment=splits_only&extended_hours=false/) // yfinance takes both
  })
  it('sends only the params the chosen provider takes', async () => {
    const d = await byRoute('equity/price/historical')
    const params = parseParams(d, { symbol: ['NVDA'], provider: 'cboe' })
    expect(Object.keys(params)).toEqual(expect.arrayContaining(['extended_hours', 'adjustment']))
    const sent = applicableParams(d, params)
    expect(Object.keys(sent)).not.toContain('extended_hours') // yfinance only
    expect(Object.keys(sent)).not.toContain('adjustment') // tmx and yfinance
    expect(Object.keys(sent)).toEqual(expect.arrayContaining(['provider', 'symbol', 'interval']))
    expect(applicableParams(undefined, params)).toBe(params)
    expect(applicableParams(d, { symbol: ['NVDA'], extended_hours: true })).toEqual({ symbol: ['NVDA'], extended_hours: true }) // no provider chosen: nothing dropped
  })
  it('picks a keyless default provider when the query names none, and keeps the caller’s when it does', async () => {
    const quote = await byRoute('equity/price/quote')
    expect(defaultProvider(quote)).toBe('yfinance') // first of the preference list among cboe, nasdaq, tmx, yfinance
    expect(defaultProvider(await byRoute('fixedincome/government/treasury_rates'))).toBe('federal_reserve')
    expect(defaultProvider({ providers: ['zzz', 'fmp'] })).toBe('zzz') // nothing keyless listed: the route's first
    expect(defaultProvider({ providers: [] })).toBeUndefined()
    expect(withProvider(quote, { symbol: ['MU'], provider: 'cboe' })).toEqual({ symbol: ['MU'], provider: 'cboe' })
    expect(withProvider(quote, { symbol: ['MU'] })).toEqual({ provider: 'yfinance', symbol: ['MU'] })
    const { ctx, calls } = fakeCtx({ [url('/equity/price/quote', { provider: 'yfinance', symbol: 'MU,SNDK' })]: fixture('quote-MU-SNDK') })
    const f = await callRoute('equity/price/quote', parseParams(quote, { symbol: 'MU,SNDK' }), ctx, { catalogPath })
    expect(calls).toHaveLength(1)
    expect(f.rows).toHaveLength(2)
  })
  it('keeps the provider’s symbol on multi-symbol rows and leaves rows alone when the descriptor has no symbol field', () => {
    const rows = [{ date: '2026-10-01', close: 1 }]
    const withSymbol: Descriptor = { connector: 'openbb', route: 'x', summary: '', params: [], providers: [], fields: [{ name: 'symbol', type: 'string' }] }
    expect(fillSymbol(rows, withSymbol, { symbol: ['MU'] })[0]).toEqual({ symbol: 'MU', date: '2026-10-01', close: 1 })
    expect(fillSymbol(rows, withSymbol, { symbol: ['MU', 'SNDK'] })).toBe(rows)
    expect(fillSymbol(rows, { ...withSymbol, fields: [] }, { symbol: ['MU'] })).toBe(rows)
    expect(fillSymbol([{ symbol: 'SNDK', close: 1 }, { symbol: null, close: 2 }], withSymbol, { symbol: ['MU'] })).toEqual([{ symbol: 'SNDK', close: 1 }, { symbol: null, close: 2 }])
  })
  it('fills the symbol on dividends (no symbol in the rows), typing the ex date as time', async () => {
    const d = await byRoute('equity/fundamental/dividends')
    const params = parseParams(d, { symbol: 'AAPL', provider: 'yfinance' })
    expect(d.params.find((p) => p.name === 'symbol')!.providers).toBeUndefined()
    const { ctx } = fakeCtx({ [url('/equity/fundamental/dividends', { provider: 'yfinance', symbol: 'AAPL' })]: fixture('dividends-AAPL') })
    const f = await callRoute('equity/fundamental/dividends', params, ctx, { catalogPath })
    const rows = frameToObjects(f)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ symbol: 'AAPL', amount: 0.26 })
    expect(f.columns.find((c) => c.name === 'ex_dividend_date')!.type).toBe('time')
    expect(rows[0]!.ex_dividend_date).toBe(Date.UTC(2025, 7, 11, 4))
  })
  it('does not scale fractions: the yield curve rate stays a provider fraction for the annotations', async () => {
    const d = await byRoute('fixedincome/government/yield_curve')
    const params = parseParams(d, { provider: 'federal_reserve' })
    const { ctx } = fakeCtx({ [url('/fixedincome/government/yield_curve', toQuery(applicableParams(d, params)))]: fixture('yield-curve') })
    const f = await callRoute('fixedincome/government/yield_curve', params, ctx, { catalogPath })
    const rows = frameToObjects(f)
    expect(rows[0]).toMatchObject({ maturity: 'month_1', rate: 0.0417 })
    expect(f.columns.map((c) => c.name).sort()).toEqual(['date', 'maturity', 'maturity_years', 'rate'])
    expect(f.columns.find((c) => c.name === 'date')!.type).toBe('time')
  })
  it('infers columns alone for a route the catalog does not describe, wraps a single-object result, and keeps descriptor columns on an empty result', async () => {
    const { ctx } = fakeCtx({
      [OPENAPI_URL]: openapi(),
      [url('/equity/profile', { provider: 'yfinance', symbol: 'MU' })]: { results: { symbol: 'MU', name: 'Micron', employees: 48000 } },
      [url('/equity/calendar/ipo', { provider: 'yfinance', start_date: '2026-10-01' })]: { results: [] }, // yfinance precedes nasdaq in the preference list
      [url('/nothing/here', {})]: { results: [{ a: 1, when: '2026-10-01' }] },
    })
    const one = await callRoute('equity/profile', { symbol: 'MU' }, ctx, { catalogPath })
    expect(frameToObjects(one)).toMatchObject([{ symbol: 'MU', name: 'Micron', employees: 48000 }])
    const empty = await callRoute('equity/calendar/ipo', { start_date: '2026-10-01' }, ctx, { catalogPath })
    expect(empty.rows).toEqual([])
    expect(empty.columns.map((c) => c.name)).toContain('ipo_date')
    const unknown = await callRoute('nothing/here', {}, ctx, { catalogPath })
    expect(unknown.columns).toEqual([{ name: 'a', type: 'number' }, { name: 'when', type: 'time' }])
  })
  it('reports HTTP errors in one readable line and the breaker when the API is down', async () => {
    const bad = fakeCtx({ [url('/equity/price/quote', { symbol: 'MU' })]: status(422, '{"detail":[{"msg":"symbol required"}]}', `${BASE}/equity/price/quote`) }) // no catalog loaded: no default provider
    await expect(callRoute('equity/price/quote', { symbol: ['MU'] }, bad.ctx, { catalogPath })).rejects.toThrow('OpenBB 422 on /equity/price/quote: symbol required')
    const down = fakeCtx({ [url('/equity/price/quote', { symbol: 'MU' })]: connectionRefused() })
    await expect(callRoute('equity/price/quote', { symbol: ['MU'] }, down.ctx, { catalogPath })).rejects.toThrow(/not running/)
    await expect(callRoute('equity/price/quote', { symbol: ['MU'] }, down.ctx, { catalogPath })).rejects.toThrow(/not running/)
    expect(down.calls.filter((c) => c.includes('/equity/price/quote'))).toHaveLength(1)
  })
  it('the connector routes a v2 route to call() and a kind name to the v1 handler', async () => {
    process.env.TERMINAL_HOME = home
    const { ctx } = fakeCtx({
      [OPENAPI_URL]: openapi(),
      [url('/equity/price/quote', { symbol: 'MU,SNDK', provider: 'yfinance' })]: fixture('quote-MU-SNDK'),
    })
    const v2 = await openbb.call('equity/price/quote', { symbol: ['MU', 'SNDK'], provider: 'yfinance' }, ctx)
    expect(v2.columns.map((c) => c.name)).toContain('last_price')
    const v1 = await openbb.call('quote', { symbols: ['MU', 'SNDK'] }, ctx)
    expect(v1.columns.map((c) => c.name)).toEqual(['symbol', 'price', 'change_pct', 'volume', 'market_state', 'extended_price', 'extended_change_pct'])
    expect(frameToObjects(v1).find((r) => r.symbol === 'MU')).toMatchObject({ price: 878.84, change_pct: -5.6269 })
  })
})
