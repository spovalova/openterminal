import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA'], from = '2026-10-16', to = '2026-12-31') => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.earnings!({ symbols, from, to }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('earnings', () => {
  it('emits the catalog columns with the NY calendar date, null session, and the EPS estimate', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.earnings.columns)
    expect(objects(frame)).toEqual([
      { symbol: 'MU', date: '2026-12-23', session: null, eps_estimate: 38.21235 },
      { symbol: 'NVDA', date: '2026-11-17', session: null, eps_estimate: 2.47325 },
    ])
  })

  it('requests only the calendarEvents module, one call per symbol', async () => {
    const { client } = await run()
    expect(client.calls.quoteSummary).toEqual([
      ['MU', { modules: ['calendarEvents'] }],
      ['NVDA', { modules: ['calendarEvents'] }],
    ])
  })

  it('filters to the [from, to] window inclusively', async () => {
    expect(objects((await run(fakeClient(), ['MU', 'NVDA'], '2026-11-17', '2026-12-23')).frame).map((r) => r.symbol)).toEqual(['MU', 'NVDA'])
    expect(objects((await run(fakeClient(), ['MU', 'NVDA'], '2026-11-18', '2026-12-22')).frame)).toEqual([])
    expect(objects((await run(fakeClient(), ['MU', 'NVDA'], '2026-11-01', '2026-11-30')).frame).map((r) => r.symbol)).toEqual(['NVDA'])
    expect(objects((await run(fakeClient(), ['MU', 'NVDA'], '2026-12-01', '2027-01-31')).frame).map((r) => r.symbol)).toEqual(['MU'])
  })

  it('formats the date in New York even when the UTC stamp is on the next day', async () => {
    const mu = fixtures.quoteSummary().bySymbol['MU'] as any
    const client = fakeClient({
      quoteSummary: async () => ({ ...mu, calendarEvents: { ...mu.calendarEvents, earnings: { ...mu.calendarEvents.earnings, earningsDate: [new Date('2026-12-24T02:00:00.000Z')] } } }),
    })
    expect(objects((await run(client, ['MU'])).frame)[0]!.date).toBe('2026-12-23')
  })

  it('treats a symbol without fundamentals (SPY) as having no earnings, not as a failure', async () => {
    const { frame, ctx } = await run(fakeClient(), ['SPY', 'MU'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['earnings: SPY has no fundamentals on Yahoo (ETF or index?)'])
    // An all-ETF basket yields an empty frame rather than an error.
    expect((await run(fakeClient(), ['SPY'])).frame.rows).toEqual([])
  })

  it('skips a symbol with an empty earningsDate and a missing estimate becomes null', async () => {
    const mu = fixtures.quoteSummary().bySymbol['MU'] as any
    const client = fakeClient({
      quoteSummary: async (symbol) =>
        symbol === 'EMPTY'
          ? { ...mu, calendarEvents: { ...mu.calendarEvents, earnings: { ...mu.calendarEvents.earnings, earningsDate: [] } } }
          : { ...mu, calendarEvents: { ...mu.calendarEvents, earnings: { ...mu.calendarEvents.earnings, earningsAverage: undefined } } },
    })
    const { frame, ctx } = await run(client, ['EMPTY', 'MU'])
    expect(objects(frame)).toEqual([{ symbol: 'MU', date: '2026-12-23', session: null, eps_estimate: null }])
    expect(ctx.logs).toEqual(['earnings: EMPTY has no earnings date on Yahoo'])
  })

  it('logs and skips a symbol whose call fails, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const flaky = fakeClient({
      quoteSummary: async (symbol, opts) => {
        if (symbol === 'NVDA') throw new Error('HTTP 500')
        return base.quoteSummary(symbol, opts)
      },
    })
    const { frame, ctx } = await run(flaky)
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['earnings: skipped NVDA: HTTP 500'])

    const dead = fakeClient({ quoteSummary: async () => { throw new Error('HTTP 500') } })
    await expect(run(dead)).rejects.toThrow(/earnings failed for every input \(2\): HTTP 500/)
  })
})
