import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { DIVIDEND_LOOKBACK_MS } from '../src/dividends.js'
import { createYahooConnector } from '../src/index.js'
import { V12_NOW, fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA'], limit = 12) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client, now: () => V12_NOW })
  return c.queries.dividends!({ symbols, limit }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('dividends', () => {
  it('emits the catalog columns, newest ex-date first per symbol, up to limit', async () => {
    const { frame } = await run(fakeClient(), ['MU', 'NVDA'], 3)
    expect(frame.columns).toEqual(KINDS.dividends.columns)
    expect(objects(frame)).toEqual([
      { symbol: 'MU', ex_date: '2026-10-14', amount: 0.15 },
      { symbol: 'MU', ex_date: '2026-07-06', amount: 0.15 },
      { symbol: 'MU', ex_date: '2026-03-30', amount: 0.15 },
      { symbol: 'NVDA', ex_date: '2026-09-10', amount: 0.25 },
      { symbol: 'NVDA', ex_date: '2026-06-04', amount: 0.25 },
      { symbol: 'NVDA', ex_date: '2026-03-11', amount: 0.01 },
    ])
  })

  it('returns every recorded event when limit exceeds them, dated by the New York session day', async () => {
    const { frame } = await run(fakeClient(), ['MU'], 60)
    const rows = objects(frame)
    expect(rows).toHaveLength(fixtures.dividends().bySymbol['MU']!.events!.dividends!.length)
    expect(rows.at(-1)).toEqual({ symbol: 'MU', ex_date: '2023-04-06', amount: 0.115 })
    // A 14:30Z (winter) stamp is still the same calendar day in New York.
    expect(rows.find((r) => r.ex_date === '2025-12-29')).toBeDefined()
  })

  it('asks the chart endpoint for dividend events over a 30-year window of monthly bars', async () => {
    const { client } = await run(fakeClient(), ['MU'])
    expect(client.calls.chart).toHaveLength(1)
    const [symbol, opts] = client.calls.chart[0]! as [string, { period1: Date; period2: Date; interval: string; events: string; includePrePost: boolean }]
    expect(symbol).toBe('MU')
    expect(opts).toMatchObject({ interval: '1mo', events: 'div', includePrePost: false })
    expect(opts.period2).toEqual(V12_NOW)
    expect(V12_NOW.getTime() - opts.period1.getTime()).toBe(DIVIDEND_LOOKBACK_MS)
  })

  it('treats a symbol with no dividend events as an empty answer, not a failure', async () => {
    const recorded = fixtures.dividends().bySymbol['MU']!
    const client = fakeClient({ chart: async () => ({ meta: recorded.meta, quotes: [] }) })
    const { frame, ctx } = await run(client, ['GOOG'])
    expect(frame.rows).toEqual([])
    expect(ctx.logs).toEqual([])
  })

  it('skips a symbol whose call fails, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const client = fakeClient({ chart: async (s, o) => { if (s === 'NVDA') throw new Error('HTTP 500'); return base.chart(s, o) } })
    const { frame, ctx } = await run(client)
    expect(new Set(objects(frame).map((r) => r.symbol))).toEqual(new Set(['MU']))
    expect(ctx.logs).toEqual(['dividends: skipped NVDA: HTTP 500'])
    const dead = fakeClient({ chart: async () => { throw new Error('HTTP 500') } })
    await expect(run(dead)).rejects.toThrow(/dividends failed for every input \(2\): HTTP 500/)
  })
})
