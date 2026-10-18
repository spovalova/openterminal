import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { insiderAction, insiderPrice } from '../src/insiders.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU'], limit = 20) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.insiders!({ symbols, limit }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('insiders', () => {
  it('emits the catalog columns, newest first, with the action, price and value derived from the filing text', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.insiders.columns)
    const rows = objects(frame)
    expect(rows).toHaveLength(8)
    // A sale over a price range: the price is value / shares.
    expect(rows[0]).toEqual({ symbol: 'MU', date: '2026-08-21', name: 'MEHROTRA SANJAY', title: 'Chief Executive Officer', action: 'sell', shares: 40000, price: 968.9041, value: 38756162, url: null })
    // A sale at one price: the quoted price.
    expect(rows[1]).toEqual({ symbol: 'MU', date: '2026-08-18', name: 'SADANA SUMIT', title: 'Officer', action: 'sell', shares: 15000, price: 934.29, value: 14014350, url: null })
    // A grant at 0.00.
    expect(rows[7]).toEqual({ symbol: 'MU', date: '2026-06-30', name: 'LIU TEYIN MARK', title: 'Director', action: 'grant', shares: 27, price: 0, value: 0, url: null })
    const dates = rows.map((r) => r.date as string)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it('classifies Yahoo transaction texts', () => {
    expect(insiderAction('Sale at price 332.01 per share.')).toBe('sell')
    expect(insiderAction('Purchase at price 100.00 - 101.00 per share.')).toBe('buy')
    expect(insiderAction('Stock Award(Grant) at price 0.00 per share.')).toBe('grant')
    expect(insiderAction('Stock Gift at price 0.00 per share.')).toBe('other')
    expect(insiderAction('Conversion of Exercise of derivative security at price 25.00 per share.')).toBe('other')
    expect(insiderAction('')).toBe('other')
  })

  it('prices a filing from the text, else value / shares, else null', () => {
    expect(insiderPrice('Sale at price 1,000.00 per share.', 879, 879000)).toBe(1000)
    expect(insiderPrice('Sale at price 959.14 - 989.59 per share.', 40000, 38756162)).toBe(968.9041)
    expect(insiderPrice('Sale at price 959.14 - 989.59 per share.', 40000, 0)).toBe(959.14)
    expect(insiderPrice('Stock Gift at price 0.00 per share.', 500000, 0)).toBe(0)
    expect(insiderPrice('', 100, 2500)).toBe(25)
    expect(insiderPrice('', 100, null)).toBeNull()
  })

  it('applies limit per symbol and keeps multi-symbol output in symbol order', async () => {
    const { frame, client } = await run(fakeClient(), ['NVDA', 'MU'], 2)
    expect(objects(frame).map((r) => `${r.symbol} ${r.date} ${r.action}`)).toEqual(['NVDA 2026-09-21 sell', 'NVDA 2026-09-18 sell', 'MU 2026-08-21 sell', 'MU 2026-08-18 sell'])
    expect(client.calls.quoteSummary.map(([s, o]) => [s, o])).toEqual([
      ['NVDA', { modules: ['insiderTransactions'] }],
      ['MU', { modules: ['insiderTransactions'] }],
    ])
  })

  it('returns an empty frame for a company with no filings, but fails a symbol without the module', async () => {
    const mu = fixtures.summaryModules().bySymbol['MU']!
    const empty = fakeClient({ quoteSummary: async () => ({ insiderTransactions: { ...mu.insiderTransactions, transactions: [] } }) as any })
    expect((await run(empty)).frame.rows).toEqual([])

    const base = fakeClient()
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'SMH' ? {} : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['SMH', 'MU'], 1)
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['insiders: skipped SMH: no insider transactions on Yahoo (fund or index?)'])
    await expect(run(fakeClient(), ['SMH'])).rejects.toThrow(/insiders failed for every input \(1\)/)
  })
})
