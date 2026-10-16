import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { fakeClient, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), q: string[] = ['micron', 'sandisk']) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.search!({ q }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('search', () => {
  it('emits the catalog columns and one row per term, in input order', async () => {
    const { frame } = await run(fakeClient(), ['sandisk', 'micron', 'SPY'])
    expect(frame.columns).toEqual(KINDS.search.columns)
    expect(frame.meta.connector).toBe('yahoo')
    expect(objects(frame)).toEqual([
      { query: 'sandisk', symbol: 'SNDK', name: 'Sandisk Corporation', exchange: 'NASDAQ' },
      { query: 'micron', symbol: 'MU', name: 'Micron Technology, Inc.', exchange: 'NASDAQ' },
      { query: 'SPY', symbol: 'SPY', name: 'State Street SPDR S&P 500 ETF Trust', exchange: 'NYSEArca' },
    ])
  })

  it('skips futures and foreign listings even when they outrank the US equity', async () => {
    // The micron fixture lists CME futures and MU.TO after MU; the sandisk one lists SNDK.TO and a crypto token.
    const { frame } = await run(fakeClient(), ['micron'])
    expect(objects(frame)[0]!.symbol).toBe('MU')
  })

  it('emits a null row for a term with no US equity or ETF match', async () => {
    const { frame } = await run(fakeClient(), ['zqxv-no-such-company'])
    expect(objects(frame)).toEqual([{ query: 'zqxv-no-such-company', symbol: null, name: null, exchange: null }])
  })

  it('fans out one call per term with news disabled', async () => {
    const { client } = await run(fakeClient(), ['micron', 'sandisk', 'SPY'])
    expect(client.calls.search.map(([t]) => t)).toEqual(['micron', 'sandisk', 'SPY'])
    for (const [, opts] of client.calls.search) expect(opts).toMatchObject({ newsCount: 0 })
  })

  it('logs and skips a term whose call fails, keeping the others', async () => {
    const base = fakeClient()
    const client = fakeClient({
      search: async (term, opts) => {
        if (term === 'sandisk') throw new Error('boom')
        return base.search(term, opts)
      },
    })
    const { frame, ctx } = await run(client, ['micron', 'sandisk'])
    expect(objects(frame).map((r) => r.query)).toEqual(['micron'])
    expect(ctx.logs).toEqual(['search: skipped "sandisk": boom'])
  })

  it('throws when every term fails', async () => {
    const client = fakeClient({ search: async () => { throw new Error('down') } })
    await expect(run(client, ['micron', 'sandisk'])).rejects.toThrow(/search failed for every input \(2\): down/)
  })
})
