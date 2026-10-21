// The native path (PLAN.md section 19): ported (route, provider) pairs answer in process, so the connector works
// with no OpenBB API; the API still answers everything else, and a native failure falls back to it when it may run.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameToObjects } from '@openterminal/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import openbb from '../src/index.js'
import { callRoute } from '../src/call.js'
import { resetDescriptors } from '../src/descriptors.js'
import { BASE, connectionRefused, fakeCtx, fixture, status } from './helpers.js'

// These tests pin a world where only cboe's equity/price/quote and one stub command (oecd/list_topics, a route that
// takes no provider) are ported, so they test the connector's routing and not whichever providers and commands
// @openterminal/openbb-native has ported by now.
vi.mock('@openterminal/openbb-native', async (importOriginal) => {
  const real = await importOriginal<typeof import('@openterminal/openbb-native')>()
  const ported = new Set(['cboe:equity/price/quote'])
  const isNative = (route: string, provider: string): boolean => ported.has(`${provider}:${route}`)
  const commands: Record<string, import('@openterminal/openbb-native').NativeHandler> = {
    'oecd/list_topics': async (params) => [{ topic_id: 'ECO', topic: 'Economy', subtopic_id: 'OUT', subtopic: 'Outlook', dataflows: params.query === 'eco' ? 1 : 2 }],
  }
  const nativeDescriptors = () =>
    real.snapshotDescriptors().flatMap((d) => {
      if (d.providers.length === 0) return d.route in commands ? [d] : []
      const providers = d.providers.filter((p) => isNative(d.route, p))
      return providers.length ? [real.narrowDescriptor(d, providers)] : []
    })
  return {
    ...real,
    isNative,
    nativeCommand: (route: string) => commands[route],
    nativeHandler: (route: string, provider: string) => (isNative(route, provider) ? real.nativeHandler(route, provider) : undefined),
    nativePairs: () => [...ported].map((k) => ({ provider: k.split(':')[0]!, route: k.slice(k.indexOf(':') + 1) })),
    nativeDescriptors,
    nativeDescriptorFor: (route: string) => nativeDescriptors().find((d) => d.route === route),
    mergeNativeDescriptors: (live: Parameters<typeof real.mergeNativeDescriptors>[0]) => real.mergeNativeDescriptors(live, nativeDescriptors()),
  }
})

const OPENAPI_URL = 'http://127.0.0.1:6900/openapi.json'

/** Cboe's endpoints for one TSLA quote, as the native cboe port reads them. */
function cboe(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const bodies: Record<string, string> = {
    'https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv': 'Company Name, Stock Symbol, DPM Name, Post/Station, Global Trading Hours DPM\n"TESLA INC COM","TSLA","Citadel","1/1","-"\n',
    'https://cdn.cboe.com/api/global/us_indices/definitions/all_indices.json': JSON.stringify([{ index_symbol: 'SPX', name: "Standard & Poor's 500", source: 'index_definition' }]),
    'https://cdn.cboe.com/api/global/delayed_quotes/quotes/TSLA.json': JSON.stringify({ data: { symbol: 'TSLA', security_type: 'stock', current_price: 374.53, price_change_percent: 1.7579, bid_size: 0, iv30: 46.239, seqno: 1, exchange_id: 2, last_trade_time: '2026-10-20T14:06:42' } }),
    'https://cdn.cboe.com/api/global/delayed_quotes/historical_data/TSLA.json': JSON.stringify({ data: { symbol: 'TSLA', annual_high: 498.83, iv30_annual_high: 60.73 } }),
  }
  const f: typeof fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    const body = bodies[url]
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'text/csv' } })
  }
  return { fetch: f, urls }
}

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openbb-native-'))
  resetDescriptors()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('native path', () => {
  it('answers a ported route with no OpenBB API, in OpenBB’s shape', async () => {
    const { ctx, calls } = fakeCtx({ [OPENAPI_URL]: connectionRefused() }, { native: 'prefer' })
    const up = cboe()
    const frame = await callRoute('equity/price/quote', { symbol: ['TSLA'] }, ctx, { catalogPath: join(home, 'openbb.json'), fetch: up.fetch, env: {} })
    const [row] = frameToObjects(frame)
    expect(row).toMatchObject({ symbol: 'TSLA', name: 'TESLA INC COM', asset_type: 'stock', last_price: 374.53, year_high: 498.83 })
    expect(row?.change_percent).toBeCloseTo(0.017579, 9)
    expect(row?.iv30).toBeCloseTo(0.46239, 9)
    // Cboe's zero bid size is missing data, as in OpenBB
    expect(row?.bid_size ?? null).toBeNull()
    expect(calls.filter((c) => c.includes('/api/v1/'))).toEqual([])
    expect(up.urls).toHaveLength(4)
  })

  it('lists the native routes, narrowed to their native providers, when no API runs', async () => {
    const { ctx } = fakeCtx({ [OPENAPI_URL]: connectionRefused() }, { native: 'prefer' })
    process.env.OPENTERMINAL_HOME = home
    const ds = await openbb.descriptors(ctx)
    const quote = ds.find((d) => d.route === 'equity/price/quote')
    expect(quote?.providers).toEqual(['cboe'])
    expect(quote?.params.map((p) => p.name)).toContain('symbol')
    expect(quote?.params.find((p) => p.name === 'extended_hours')).toBeUndefined()
  })

  it('sends a provider that is not ported to the API, and prefers a ported one when none is named', async () => {
    const { ctx, calls } = fakeCtx({ [OPENAPI_URL]: status(404, 'no docs'), [`${BASE}/equity/price/quote?symbol=MU&provider=nasdaq`]: fixture('quote-MU-SNDK') }, { native: 'prefer' })
    const up = cboe()
    await callRoute('equity/price/quote', { symbol: ['MU'], provider: 'nasdaq' }, ctx, { catalogPath: join(home, 'openbb.json'), fetch: up.fetch, env: {} })
    expect(calls.some((c) => c.includes('provider=nasdaq'))).toBe(true)
    expect(up.urls).toEqual([])
    await callRoute('equity/price/quote', { symbol: ['TSLA'] }, ctx, { catalogPath: join(home, 'openbb.json'), fetch: up.fetch, env: {} })
    expect(up.urls.length).toBeGreaterThan(0)
  })

  it('falls back to the API when the native call fails, unless set to native only', async () => {
    const failing: typeof fetch = async () => new Response('down', { status: 503 })
    const viaApi = fakeCtx({ [OPENAPI_URL]: status(404, 'no docs'), [`${BASE}/equity/price/quote?provider=cboe&symbol=MU`]: fixture('quote-MU-SNDK') }, { native: 'prefer' })
    const frame = await callRoute('equity/price/quote', { symbol: ['MU'] }, viaApi.ctx, { catalogPath: join(home, 'openbb.json'), fetch: failing, env: {} })
    expect(frame.rows.length).toBeGreaterThan(0)
    expect(viaApi.logs.some((l) => l.includes('native cboe equity/price/quote failed'))).toBe(true)
    const only = fakeCtx({}, { native: 'only' })
    await expect(callRoute('equity/price/quote', { symbol: ['MU'] }, only.ctx, { fetch: failing, env: {} })).rejects.toThrow(/HTTP 503|Cboe has no quote for MU/)
    await expect(callRoute('equity/profile', { symbol: ['MU'] }, only.ctx, { fetch: failing, env: {} })).rejects.toThrow(/no native port/)
  })

  it('answers a ported command (a route with no provider) with no OpenBB API, and lists it', async () => {
    const { ctx, calls } = fakeCtx({ [OPENAPI_URL]: connectionRefused() }, { native: 'prefer' })
    const frame = await callRoute('oecd/list_topics', { query: 'eco' }, ctx, { catalogPath: join(home, 'openbb.json'), env: {} })
    expect(frameToObjects(frame)).toEqual([{ topic_id: 'ECO', topic: 'Economy', subtopic_id: 'OUT', subtopic: 'Outlook', dataflows: 1 }])
    expect(calls.filter((c) => c.includes('/api/v1/'))).toEqual([])
    process.env.OPENTERMINAL_HOME = home
    const ds = await openbb.descriptors(ctx)
    expect(ds.find((d) => d.route === 'oecd/list_topics')?.providers).toEqual([])
    expect(ds.find((d) => d.route === 'oecd/list_tables')).toBeUndefined()
  })

  it('sends a command that is not ported, or any command when native is off, to the API', async () => {
    const tables = { results: [{ table_id: 'DF_PRICES_ALL', name: 'Prices' }] }
    const prefer = fakeCtx({ [OPENAPI_URL]: status(404, 'no docs'), [`${BASE}/oecd/list_tables?topic=ECO`]: tables }, { native: 'prefer' })
    await callRoute('oecd/list_tables', { topic: 'ECO' }, prefer.ctx, { catalogPath: join(home, 'openbb.json'), env: {} })
    expect(prefer.calls).toContain(`${BASE}/oecd/list_tables?topic=ECO`)
    const off = fakeCtx({ [OPENAPI_URL]: status(404, 'no docs'), [`${BASE}/oecd/list_topics`]: { results: [{ topic_id: 'HEA' }] } }, { native: 'off' })
    const frame = await callRoute('oecd/list_topics', {}, off.ctx, { catalogPath: join(home, 'openbb.json'), env: {} })
    expect(frameToObjects(frame)).toEqual([{ topic_id: 'HEA' }])
  })

  it('health is fine without the API when routes are native, and says the API is optional', async () => {
    const down = fakeCtx({ [`${BASE}/coverage/providers`]: connectionRefused() }, { native: 'prefer' })
    expect(await openbb.health!(down.ctx)).toMatch(/^2 routes native · OpenBB API not running at http:\/\/127\.0\.0\.1:6900 \(optional/)
    const up = fakeCtx({ [`${BASE}/coverage/providers`]: fixture('providers') }, { native: 'prefer' })
    expect(await openbb.health!(up.ctx)).toMatch(/^\d+ routes native · OpenBB API at http:\/\/127\.0\.0\.1:6900 · 3 providers/)
  })
})
