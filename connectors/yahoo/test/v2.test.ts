// The five yahoo-finance2 endpoints as routes (PLAN.md section 17), answered from the recorded fixtures through
// inferFrame. No network: the fake client replays the fixtures.
import { describe, expect, it } from 'vitest'
import { DescriptorSchema, parseParams, type Descriptor } from '@openterminal/core'
import { createYahooConnector } from '../src/index.js'
import { chartRowsV2, daysBetween, flattenDeep, makeCall, pickExpiration, summaryRows, yahooDescriptors, YAHOO_ROUTES } from '../src/call.js'
import { fakeClient, objects, testCtx, V12_NOW } from './helpers.js'

const descriptors = yahooDescriptors()
const by = (route: string): Descriptor => descriptors.find((d) => d.route === route)!

function build(overrides: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient(overrides)
  const connector = createYahooConnector({ client, now: () => V12_NOW })
  const call = makeCall(() => client, () => V12_NOW)
  return { client, connector, call }
}

/** Validate against the descriptor the way the registry does, then call. */
async function run(route: string, params: Record<string, unknown>, overrides: Parameters<typeof fakeClient>[0] = {}) {
  const { call, client } = build(overrides)
  const ctx = testCtx()
  const frame = await call(route, parseParams(by(route), params), ctx)
  return { frame, rows: objects(frame), client, ctx }
}

describe('descriptors.json', () => {
  it('holds exactly the five yahoo-finance2 endpoints the recipes name, all valid, and the connector exposes them', async () => {
    expect(descriptors.map((d) => d.route)).toEqual([...YAHOO_ROUTES])
    expect(descriptors.every((d) => DescriptorSchema.safeParse(d).success && d.connector === 'yahoo' && d.providers.length === 0)).toBe(true)
    expect(by('chart').params.map((p) => `${p.name}:${p.type}${p.required ? '!' : ''}`)).toEqual(['symbol:string[]!', 'period1:date!', 'period2:date', 'interval:string', 'includePrePost:boolean', 'events:string'])
    expect(by('quoteSummary').params.find((p) => p.name === 'modules')).toMatchObject({ type: 'string[]', required: true, enum: expect.arrayContaining(['financialData', 'calendarEvents', 'topHoldings']) })
    expect(by('quoteSummary').fields.map((f) => f.name)).toEqual(['symbol']) // inference fills the rest
    const { connector } = build()
    expect(connector.name).toBe('yahoo')
    expect(connector.config.safeParse({}).success).toBe(true)
    expect((await connector.descriptors()).map((d) => d.route)).toEqual([...YAHOO_ROUTES])
  })
  it('pickExpiration and daysBetween implement the expiration rule the options recipe shares', () => {
    const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
    const listed = [d('2026-10-23'), d('2026-10-30'), d('2026-11-20'), d('2026-10-19')]
    expect(daysBetween('2026-10-18', '2026-10-25')).toBe(7)
    expect(pickExpiration(listed, '2026-10-18')).toEqual(d('2026-10-30')) // the nearest at least 7 days out
    expect(pickExpiration(listed, '2026-10-18', '2026-10-24')).toEqual(d('2026-10-30')) // snaps forward
    expect(pickExpiration(listed, '2026-10-18', '2026-10-23')).toEqual(d('2026-10-23'))
    expect(pickExpiration(listed, '2026-10-18', '2026-12-01')).toBeUndefined()
    expect(pickExpiration([d('2026-10-19')], '2026-10-18')).toEqual(d('2026-10-19')) // none 7 days out: the nearest tomorrow or later
    expect(pickExpiration([d('2026-10-18')], '2026-10-18')).toBeUndefined()
  })
  it('validates the recipe params the way recipes.yml writes them', () => {
    expect(parseParams(by('chart'), { symbol: ['MU'], period1: '2026-07-18', interval: '1d', includePrePost: false })).toEqual({ symbol: ['MU'], period1: '2026-07-18', interval: '1d', includePrePost: false })
    expect(parseParams(by('quoteSummary'), { symbol: 'MU,NVDA', modules: ['financialData', 'price'] })).toEqual({ symbol: ['MU', 'NVDA'], modules: ['financialData', 'price'] })
    expect(() => parseParams(by('quoteSummary'), { symbol: 'MU', modules: ['nope'] })).toThrow(/not in/)
    expect(() => parseParams(by('chart'), { symbol: 'MU' })).toThrow(/"period1" is required/)
  })
})

describe('call: quote and search', () => {
  it('quote answers one row per requested symbol with the descriptor’s columns only, times in ms, in requested order', async () => {
    const { frame, rows, client, ctx } = await run('quote', { symbols: ['NVDA', 'MU', 'NOPE'] })
    expect(client.calls.quote).toEqual([[['NVDA', 'MU', 'NOPE']]])
    expect(rows.map((r) => r.symbol)).toEqual(['NVDA', 'MU'])
    expect(ctx.logs[0]).toMatch(/skipped NOPE/)
    const names = frame.columns.map((c) => c.name)
    expect(names.slice(0, 2)).toEqual(['symbol', 'shortName'])
    expect(names).toContain('regularMarketPrice')
    expect(names).not.toContain('language') // not in the descriptor
    expect(names.length).toBeLessThanOrEqual(by('quote').fields.length)
    expect(frame.columns.find((c) => c.name === 'regularMarketTime')!.type).toBe('time')
    expect(typeof rows[1]!.regularMarketTime).toBe('number')
    expect(rows[1]!.regularMarketPrice).toBe(878.84)
    expect(frame.meta.connector).toBe('yahoo')
  })
  it('quote throws when Yahoo knows none of the symbols so the registry can fall back', async () => {
    await expect(run('quote', { symbols: 'NOPE' })).rejects.toThrow(/no quotes for NOPE/)
  })
  it('search returns up to ten hits with the query first', async () => {
    const { rows, client } = await run('search', { q: 'micron' })
    expect(client.calls.search).toEqual([['micron', { quotesCount: 10, newsCount: 0 }]])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ query: 'micron', symbol: 'MU', exchange: 'NMS', quoteType: 'EQUITY' })
  })
})

describe('call: chart', () => {
  it('fetches one chart per symbol with the period, interval and session flags, and returns bars with a symbol column', async () => {
    const { frame, rows, client } = await run('chart', { symbol: ['MU', 'NVDA'], period1: '2026-10-16', interval: '5m', includePrePost: false }, { chartKeys: { MU: 'MU-5m', NVDA: 'NVDA-5m' } })
    expect(client.calls.chart.map(([s, o]) => [s, o])).toEqual([
      ['MU', { period1: '2026-10-16', interval: '5m', includePrePost: false }],
      ['NVDA', { period1: '2026-10-16', interval: '5m', includePrePost: false }],
    ])
    expect(frame.columns.slice(0, 2)).toEqual([{ name: 'symbol', type: 'string' }, { name: 'date', type: 'time' }])
    expect(frame.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['open', 'high', 'low', 'close', 'volume']))
    expect(new Set(rows.map((r) => r.symbol))).toEqual(new Set(['MU', 'NVDA']))
    expect(rows[0]).toMatchObject({ symbol: 'MU', date: Date.UTC(2026, 9, 16, 13, 30), close: 901.1500244140625 })
  })
  it('passes period2 and events through, and returns the events as rows with dividends.amount', async () => {
    const { frame, rows, client } = await run('chart', { symbol: 'MU', period1: '1996-10-18', period2: '2026-10-18', interval: '1mo', events: 'div' })
    expect(client.calls.chart[0]![1]).toEqual({ period1: '1996-10-18', period2: '2026-10-18', interval: '1mo', includePrePost: false, events: 'div' })
    expect(frame.columns.map((c) => c.name)).toEqual(['symbol', 'date', 'dividends.amount'])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.symbol === 'MU' && typeof r.date === 'number' && typeof r['dividends.amount'] === 'number')).toBe(true)
    expect(rows.map((r) => r.date as number)).toEqual([...rows.map((r) => r.date as number)].sort((a, b) => a - b))
  })
  it('drops bars without a close and keeps a failing symbol out while the others answer', async () => {
    const result = { meta: {} as never, quotes: [{ date: new Date('2026-10-16T13:30:00Z'), close: null, open: 1 }, { date: new Date('2026-10-16T13:35:00Z'), close: 2, open: 1 }] } as never
    expect(chartRowsV2('X', result, undefined)).toEqual([{ symbol: 'X', date: new Date('2026-10-16T13:35:00Z'), close: 2, open: 1 }])
    const { rows, ctx } = await run('chart', { symbol: ['MU', 'BAD'], period1: '2026-07-18' }, { chartKeys: { MU: 'MU-1d' } })
    expect(new Set(rows.map((r) => r.symbol))).toEqual(new Set(['MU']))
    expect(ctx.logs.some((l) => /chart: skipped BAD/.test(l))).toBe(true)
  })
})

describe('call: options', () => {
  it('returns every contract of the nearest chain with type, strike and the underlying price, calls before puts per strike', async () => {
    const { frame, rows, client } = await run('options', { symbol: 'mu' })
    expect(client.calls.options).toEqual([['MU', {}]])
    expect(frame.columns.map((c) => c.name).slice(0, 4)).toEqual(['symbol', 'expiration', 'type', 'strike'])
    expect(frame.columns.find((c) => c.name === 'expiration')!.type).toBe('time')
    expect(frame.columns.find((c) => c.name === 'inTheMoney')!.type).toBe('boolean')
    expect(rows.every((r) => r.symbol === 'MU' && (r.type === 'call' || r.type === 'put'))).toBe(true)
    expect(rows.filter((r) => r.type === 'call').length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.type === 'put').length).toBeGreaterThan(0)
    const strikes = rows.map((r) => r.strike as number)
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b))
    const first = rows[0]!
    expect(first.impliedVolatility).toBeLessThan(5) // a fraction, not scaled here
    expect(typeof first.underlyingPrice).toBe('number')
  })
  it('snaps a requested date forward to a listed expiration and fetches that chain', async () => {
    const { rows, client } = await run('options', { symbol: 'MU', date: '2026-12-01' })
    expect(client.calls.options).toHaveLength(2)
    expect(client.calls.options[1]).toEqual(['MU', { date: new Date('2026-12-18T00:00:00.000Z') }])
    expect(new Set(rows.map((r) => r.expiration))).toEqual(new Set([Date.UTC(2026, 11, 18)]))
    await expect(run('options', { symbol: 'MU', date: '2030-01-01' })).rejects.toThrow(/no expiration on or after 2030-01-01/)
  })
})

describe('call: quoteSummary', () => {
  it('flattens scalar modules to module.field columns, one row per symbol, fractions untouched', async () => {
    const { frame, rows, client } = await run('quoteSummary', { symbol: ['MU', 'NVDA'], modules: ['financialData', 'price'] })
    expect(client.calls.quoteSummary).toEqual([
      ['MU', { modules: ['financialData', 'price'] }],
      ['NVDA', { modules: ['financialData', 'price'] }],
    ])
    expect(rows.map((r) => r.symbol)).toEqual(['MU', 'NVDA'])
    expect(frame.columns[0]).toEqual({ name: 'symbol', type: 'string' })
    expect(frame.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['financialData.grossMargins', 'financialData.targetMeanPrice', 'price.regularMarketPrice']))
    expect(frame.columns.map((c) => c.name)).not.toContain('financialData.maxAge')
    expect(rows[0]!['financialData.grossMargins']).toBe(0.80716)
    expect(rows[0]!['financialData.currentPrice']).toBe(878.84)
  })
  it('explodes list modules into one row per item with the base columns, and flattens two levels deep', async () => {
    const { frame, rows } = await run('quoteSummary', { symbol: 'MU', modules: ['insiderTransactions', 'price'] })
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((r) => r.symbol === 'MU' && typeof r['price.regularMarketPrice'] === 'number')).toBe(true)
    expect(frame.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['insiderTransactions.shares', 'insiderTransactions.filerName', 'insiderTransactions.startDate']))
    expect(frame.columns.find((c) => c.name === 'insiderTransactions.startDate')!.type).toBe('time')

    const trend = await run('quoteSummary', { symbol: 'MU', modules: ['earningsTrend'] })
    expect(trend.frame.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['earningsTrend.period', 'earningsTrend.earningsEstimate.avg', 'earningsTrend.growth']))
    expect(trend.rows.length).toBeGreaterThan(1)

    const cal = await run('quoteSummary', { symbol: 'MU', modules: ['calendarEvents'] })
    expect(cal.rows).toHaveLength(1)
    expect(cal.frame.columns.find((c) => c.name === 'calendarEvents.earnings.earningsDate')!.type).toBe('time')
    expect(cal.rows[0]!['calendarEvents.earnings.earningsDate']).toBe(Date.parse('2026-12-23T20:00:00.000Z')) // the first of the range
    expect(cal.rows[0]!['calendarEvents.earnings.earningsAverage']).toBe(38.21235)
  })
  it('summaryRows and flattenDeep handle empty, scalar-array and nested cases', () => {
    expect(flattenDeep({ a: { b: { c: 1 } }, d: [1, 2], e: [], f: [new Date(0), new Date(1)], maxAge: 1, g: [{ x: 1 }] })).toEqual({ 'a.b.c': 1, d: '1, 2', e: null, f: new Date(0), g: '[{"x":1}]' })
    expect(summaryRows('X', {} as never)).toEqual([{ symbol: 'X' }])
    expect(summaryRows('X', { price: { maxAge: 1, regularMarketPrice: 2 }, earningsHistory: { maxAge: 1, history: [{ epsActual: 1 }, { epsActual: 2 }] } } as never)).toEqual([
      { symbol: 'X', price: { regularMarketPrice: 2 }, earningsHistory: { epsActual: 1 } },
      { symbol: 'X', price: { regularMarketPrice: 2 }, earningsHistory: { epsActual: 2 } },
    ])
  })
  it('keeps the other symbols when one has no modules and fails when none do', async () => {
    const { rows, ctx } = await run('quoteSummary', { symbol: ['MU', 'ZZZZ'], modules: ['price'] })
    expect(rows.map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs.some((l) => /quoteSummary: skipped ZZZZ/.test(l))).toBe(true)
    await expect(run('quoteSummary', { symbol: 'ZZZZ', modules: ['price'] })).rejects.toThrow(/failed for every input/)
  })
  it('refuses an unknown route', async () => {
    const { call } = build()
    await expect(call('nope', {}, testCtx())).rejects.toThrow(/does not answer route "nope"/)
  })
})
