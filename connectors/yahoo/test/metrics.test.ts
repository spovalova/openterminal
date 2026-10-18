import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { METRICS_MODULES, dividendYieldPct } from '../src/metrics.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA']) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.metrics!({ symbols }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('metrics', () => {
  it('emits the catalog columns with multiples as given and margins, growth, ROE and yield scaled to percent', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.metrics.columns)
    const [mu, nvda] = objects(frame)
    expect(mu).toEqual({
      symbol: 'MU',
      market_cap: 994340044800,
      pe: 11.82349,
      forward_pe: 4.247783,
      peg: 0.16,
      ev_ebitda: 8.784,
      ps: 7.4656878,
      pb: 7.183,
      gross_margin: 80.716, // 0.80716 on Yahoo
      operating_margin: 80.678,
      profit_margin: 63.796,
      revenue_growth: 379.3,
      earnings_growth: 1059.5,
      roe: 88.26,
      debt_to_equity: 0.0374, // Yahoo's 3.743 is percent-form
      dividend_yield: 0.07, // 0.0007 on Yahoo
    })
    expect(nvda).toMatchObject({ symbol: 'NVDA', pe: 27.070797, gross_margin: 74.674, roe: 117.211, debt_to_equity: 0.1697, dividend_yield: 0.47 })
  })

  it('requests the four modules once per symbol', async () => {
    const { client } = await run()
    expect(client.calls.quoteSummary).toEqual([
      ['MU', { modules: METRICS_MODULES }],
      ['NVDA', { modules: METRICS_MODULES }],
    ])
  })

  it('leaves the fundamentals null for an ETF and takes the fund yield', async () => {
    const { frame } = await run(fakeClient(), ['SMH'])
    expect(objects(frame)[0]).toEqual({
      symbol: 'SMH', market_cap: null, pe: 28.838007, forward_pe: null, peg: null, ev_ebitda: null, ps: null, pb: null,
      gross_margin: null, operating_margin: null, profit_margin: null, revenue_growth: null, earnings_growth: null, roe: null, debt_to_equity: null, dividend_yield: 0.18,
    })
  })

  it('reads dividendYield at whichever scale agrees with dividendRate / price', () => {
    // NVDA as recorded: 0.0047 is a fraction (1 / 214.13 = 0.47%).
    expect(dividendYieldPct({ dividendYield: 0.0047, dividendRate: 1 }, 214.13)).toBe(0.47)
    // The same yield shipped as a percent must not become 47%.
    expect(dividendYieldPct({ dividendYield: 0.47, dividendRate: 1 }, 214.13)).toBe(0.47)
    // A high yield in both forms (VZ: 2.83 / 44.79).
    expect(dividendYieldPct({ dividendYield: 0.0632, dividendRate: 2.83 }, 44.79)).toBe(6.32)
    expect(dividendYieldPct({ dividendYield: 6.32, dividendRate: 2.83 }, 44.79)).toBe(6.32)
    // Without a rate the trailing yield (always a fraction) is the reference; without any reference a fraction is assumed.
    expect(dividendYieldPct({ dividendYield: 6.32, trailingAnnualDividendYield: 0.0629 }, null)).toBe(6.32)
    expect(dividendYieldPct({ dividendYield: 0.0632 }, null)).toBe(6.32)
    expect(dividendYieldPct({ dividendRate: 2.83 }, 44.79)).toBe(6.3184)
    expect(dividendYieldPct({}, 44.79)).toBeNull()
    expect(dividendYieldPct(undefined, null)).toBeNull()
  })

  it('nulls a missing field rather than guessing', async () => {
    const mu = fixtures.summaryModules().bySymbol['MU']!
    const client = fakeClient({ quoteSummary: async () => ({ summaryDetail: mu.summaryDetail, defaultKeyStatistics: mu.defaultKeyStatistics }) })
    const { frame } = await run(client, ['MU'])
    expect(objects(frame)[0]).toMatchObject({ pe: 11.82349, gross_margin: null, roe: null, debt_to_equity: null, profit_margin: 63.796 })
  })

  it('skips a symbol with no data, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'NOPE' ? {} : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['NOPE', 'NVDA'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['NVDA'])
    expect(ctx.logs).toEqual(['metrics: skipped NOPE: no metrics data on Yahoo'])
    await expect(run(fakeClient(), ['NOPE'])).rejects.toThrow(/metrics failed for every input \(1\)/)
  })
})
