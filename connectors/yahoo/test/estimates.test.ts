import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { ESTIMATES_MODULES } from '../src/estimates.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA']) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.estimates!({ symbols }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('estimates', () => {
  it('emits the catalog columns with targets, upside to the last price, and the 0q / 0y EPS estimates', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.estimates.columns)
    expect(objects(frame)).toEqual([
      { symbol: 'MU', recommendation: 'strong_buy', analysts: 46, target_low: 361, target_consensus: 1560.5652, target_high: 3000, upside_pct: 77.571, eps_estimate_q: 38.27861, eps_estimate_y: 176.54659, eps_growth_y: 133.77 },
      { symbol: 'NVDA', recommendation: 'strong_buy', analysts: 59, target_low: 180, target_consensus: 328.71695, target_high: 515, upside_pct: 53.5128, eps_estimate_q: 2.47325, eps_estimate_y: 9.31242, eps_growth_y: 95.23 },
    ])
  })

  it('requests financialData and earningsTrend once per symbol', async () => {
    const { client } = await run(fakeClient(), ['MU'])
    expect(client.calls.quoteSummary).toEqual([['MU', { modules: ESTIMATES_MODULES }]])
  })

  it('nulls the EPS columns without earningsTrend and the targets without financialData', async () => {
    const mu = fixtures.summaryModules().bySymbol['MU']!
    const noTrend = fakeClient({ quoteSummary: async () => ({ financialData: mu.financialData }) })
    expect(objects((await run(noTrend, ['MU'])).frame)[0]).toMatchObject({ recommendation: 'strong_buy', upside_pct: 77.571, eps_estimate_q: null, eps_estimate_y: null, eps_growth_y: null })
    const noFd = fakeClient({ quoteSummary: async () => ({ earningsTrend: mu.earningsTrend }) })
    expect(objects((await run(noFd, ['MU'])).frame)[0]).toMatchObject({ recommendation: null, analysts: null, target_consensus: null, upside_pct: null, eps_estimate_q: 38.27861 })
  })

  it('skips a symbol with neither module, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'SMH' ? {} : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['SMH', 'MU'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['estimates: skipped SMH: no estimates on Yahoo'])
    const dead = fakeClient({ quoteSummary: async () => { throw new Error('HTTP 500') } })
    await expect(run(dead)).rejects.toThrow(/estimates failed for every input \(2\): HTTP 500/)
  })
})
