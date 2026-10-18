import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA'], limit = 8) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.eps_history!({ symbols, limit }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('eps_history', () => {
  it('emits the catalog columns, newest quarter first, with the surprise as percent', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.eps_history.columns)
    expect(objects(frame)).toEqual([
      { symbol: 'MU', date: '2026-08-31', eps_actual: 33.42, eps_estimate: 31.81801, surprise_pct: 5.03 },
      { symbol: 'MU', date: '2026-05-31', eps_actual: 25.11, eps_estimate: 20.68603, surprise_pct: 21.39 },
      { symbol: 'MU', date: '2026-02-28', eps_actual: 12.2, eps_estimate: 9.15866, surprise_pct: 33.21 },
      { symbol: 'MU', date: '2025-11-30', eps_actual: 4.78, eps_estimate: 3.96409, surprise_pct: 20.58 },
      { symbol: 'NVDA', date: '2026-07-31', eps_actual: 2.22, eps_estimate: 2.09113, surprise_pct: 6.16 },
      { symbol: 'NVDA', date: '2026-04-30', eps_actual: 1.87, eps_estimate: 1.77191, surprise_pct: 5.54 },
      { symbol: 'NVDA', date: '2026-01-31', eps_actual: 1.62, eps_estimate: 1.53812, surprise_pct: 5.32 },
      { symbol: 'NVDA', date: '2025-10-31', eps_actual: 1.3, eps_estimate: 1.25647, surprise_pct: 3.46 },
    ])
  })

  it('applies limit per symbol and requests only earningsHistory', async () => {
    const { frame, client } = await run(fakeClient(), ['MU', 'NVDA'], 2)
    expect(objects(frame).map((r) => `${r.symbol} ${r.date}`)).toEqual(['MU 2026-08-31', 'MU 2026-05-31', 'NVDA 2026-07-31', 'NVDA 2026-04-30'])
    expect(client.calls.quoteSummary).toEqual([
      ['MU', { modules: ['earningsHistory'] }],
      ['NVDA', { modules: ['earningsHistory'] }],
    ])
  })

  it('keeps the UTC date of the midnight stamp and nulls a missing actual', async () => {
    const mu = fixtures.summaryModules().bySymbol['MU']!
    const history = (mu.earningsHistory as any).history
    const client = fakeClient({
      quoteSummary: async () => ({ earningsHistory: { ...mu.earningsHistory, history: [{ ...history[0], epsActual: null, surprisePercent: null }, { ...history[1], quarter: null }] } }) as any,
    })
    const { frame } = await run(client, ['MU'])
    expect(objects(frame)).toEqual([{ symbol: 'MU', date: '2025-11-30', eps_actual: null, eps_estimate: 3.96409, surprise_pct: null }])
  })

  it('skips a symbol without the module, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'SMH' ? {} : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['SMH', 'MU'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU', 'MU', 'MU', 'MU'])
    expect(ctx.logs).toEqual(['eps_history: skipped SMH: no earnings history on Yahoo'])
    await expect(run(fakeClient(), ['SMH'])).rejects.toThrow(/eps_history failed for every input \(1\)/)
  })
})
