import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { priorMonthShares } from '../src/short-interest.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA'], limit = 12) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.short_interest!({ symbols, limit }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('short_interest', () => {
  it('emits one current row per symbol with the change from the prior month and the volume behind days to cover', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.short_interest.columns)
    expect(objects(frame)).toEqual([
      { symbol: 'MU', date: '2026-09-30', short_interest: 26023190, change_pct: -12.3956, avg_volume: 25022298, days_to_cover: 1.04 },
      { symbol: 'NVDA', date: '2026-09-30', short_interest: 311389688, change_pct: 4.3875, avg_volume: 113232614, days_to_cover: 2.75 },
    ])
  })

  it('recovers the prior month share count that yahoo-finance2 coerces into a Date', () => {
    expect(priorMonthShares(new Date(29705339 * 1000))).toBe(29705339)
    expect(priorMonthShares(29705339)).toBe(29705339)
    expect(priorMonthShares(undefined)).toBeNull()
  })

  it('requests only defaultKeyStatistics and ignores limit (Yahoo has one settlement)', async () => {
    const { frame, client } = await run(fakeClient(), ['MU'], 1)
    expect(frame.rows).toHaveLength(1)
    expect(client.calls.quoteSummary).toEqual([['MU', { modules: ['defaultKeyStatistics'] }]])
  })

  it('nulls change and volume when the prior count or ratio is missing', async () => {
    const ks = fixtures.summaryModules().bySymbol['MU']!.defaultKeyStatistics!
    const client = fakeClient({ quoteSummary: async () => ({ defaultKeyStatistics: { ...ks, sharesShortPriorMonth: undefined, shortRatio: undefined } }) })
    expect(objects((await run(client, ['MU'])).frame)[0]).toEqual({ symbol: 'MU', date: '2026-09-30', short_interest: 26023190, change_pct: null, avg_volume: null, days_to_cover: null })
  })

  it('skips a symbol without a settlement date or share count, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const ks = fixtures.summaryModules().bySymbol['MU']!.defaultKeyStatistics!
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'SMH' ? { defaultKeyStatistics: { ...ks, sharesShort: undefined } } : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['SMH', 'MU'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['short_interest: skipped SMH: no short interest on Yahoo'])
    await expect(run(fakeClient(), ['SMH'])).rejects.toThrow(/short_interest failed for every input \(1\)/)
  })
})
