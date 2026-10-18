import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { PROFILE_MODULES } from '../src/profile.js'
import { fakeClient, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA']) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.profile!({ symbols }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('profile', () => {
  it('emits the catalog columns with name, exchange, sector, industry, market cap, employees, beta, and description', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.profile.columns)
    const [mu, nvda] = objects(frame)
    expect(mu).toMatchObject({ symbol: 'MU', name: 'Micron Technology, Inc.', exchange: 'NasdaqGS', sector: 'Technology', industry: 'Semiconductors', market_cap: 994340044800, employees: 61000, beta: 2.226 })
    expect(String(mu!.description)).toMatch(/^Micron Technology, Inc\. engages in/)
    expect(nvda).toMatchObject({ symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NasdaqGS', market_cap: 5170596937728, employees: 42000, beta: 2.216 })
  })

  it('requests the profile modules once per symbol, upper-cased and de-duplicated', async () => {
    const { client } = await run(fakeClient(), ['mu', 'MU', ' nvda'])
    expect(client.calls.quoteSummary).toEqual([
      ['MU', { modules: PROFILE_MODULES }],
      ['NVDA', { modules: PROFILE_MODULES }],
    ])
  })

  it('profiles an ETF with null sector, industry, employees and market cap, and the 3-year beta', async () => {
    const { frame } = await run(fakeClient(), ['SMH'])
    expect(objects(frame)[0]).toMatchObject({ symbol: 'SMH', name: 'VanEck Semiconductor ETF', exchange: 'NasdaqGM', sector: null, industry: null, market_cap: null, employees: null, beta: 2 })
    expect(String(objects(frame)[0]!.description)).toMatch(/^The fund normally invests/)
  })

  it('skips a symbol with no data, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'NOPE' ? {} : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['MU', 'NOPE'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['profile: skipped NOPE: no profile data on Yahoo'])

    const dead = fakeClient({ quoteSummary: async () => { throw new Error('HTTP 500') } })
    await expect(run(dead)).rejects.toThrow(/profile failed for every input \(2\): HTTP 500/)
  })
})
