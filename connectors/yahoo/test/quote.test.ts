import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import type { Quote } from '../src/client.js'
import { createYahooConnector } from '../src/index.js'
import { fakeClient, fixtures, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU', 'NVDA', 'SPY']) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.quote!({ symbols }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('quote', () => {
  it('emits the catalog columns with post-market fields mapped to extended_*', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.quote.columns)
    const rows = objects(frame)
    expect(rows.map((r) => r.symbol)).toEqual(['MU', 'NVDA', 'SPY'])
    // Recorded after the close on a Friday: marketState POST and postMarket* present, preMarket* absent.
    const mu = rows[0]!
    expect(mu).toEqual({
      symbol: 'MU',
      price: 878.84,
      change_pct: -5.6269026,
      volume: 30031963,
      market_state: 'POST',
      extended_price: 880.4092,
      extended_change_pct: 0.17854817,
    })
    for (const r of rows) {
      expect(typeof r.price).toBe('number')
      expect(typeof r.extended_price).toBe('number')
    }
  })

  it('batches every symbol into one call, upper-cased and trimmed', async () => {
    const { client } = await run(fakeClient(), [' mu', 'nvda ', 'SPY', 'MU'])
    expect(client.calls.quote).toEqual([[['MU', 'NVDA', 'SPY']]])
  })

  it('maps pre-market fields in PRE and leaves extended_* null in REGULAR', async () => {
    const recorded = fixtures.quote().result
    const synth = (patch: Partial<Quote>): Quote => ({ ...recorded[0]!, postMarketPrice: undefined, postMarketChangePercent: undefined, ...patch }) as Quote
    const client = fakeClient({
      quote: async () => [
        synth({ symbol: 'PRE1', marketState: 'PRE', preMarketPrice: 100.5, preMarketChangePercent: 1.25 }),
        synth({ symbol: 'REG1', marketState: 'REGULAR' }),
      ],
    })
    const { frame } = await run(client, ['PRE1', 'REG1'])
    const [pre, reg] = objects(frame)
    expect(pre).toMatchObject({ market_state: 'PRE', extended_price: 100.5, extended_change_pct: 1.25 })
    expect(reg).toMatchObject({ market_state: 'REGULAR', extended_price: null, extended_change_pct: null })
  })

  it('logs and skips a symbol Yahoo drops from the response', async () => {
    const { frame, ctx } = await run(fakeClient(), ['MU', 'NOPE'])
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toHaveLength(1)
    expect(ctx.logs[0]).toMatch(/quote: skipped NOPE/)
  })

  it('throws when Yahoo returns nothing for any symbol', async () => {
    await expect(run(fakeClient(), ['NOPE'])).rejects.toThrow(/no quotes for NOPE/)
  })
})
