import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { fakeClient, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbols: string[] = ['MU'], limit = 20) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.institutions!({ symbols, limit }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('institutions', () => {
  it('emits the catalog columns, largest holder first, with the change scaled to percent', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.institutions.columns)
    const rows = objects(frame)
    expect(rows).toHaveLength(10) // Yahoo lists ten
    expect(rows.slice(0, 3)).toEqual([
      { symbol: 'MU', date: '2026-06-30', holder: 'Blackrock Inc.', shares: 104827219, change_pct: 1.63, value: 92126355961 },
      { symbol: 'MU', date: '2026-06-30', holder: 'Vanguard Capital Management LLC', shares: 73659544, change_pct: 0.71, value: 64734955627 },
      { symbol: 'MU', date: '2026-06-30', holder: 'State Street Corporation', shares: 50075870, change_pct: -4.14, value: 44008678935 },
    ])
    const shares = rows.map((r) => r.shares as number)
    expect(shares).toEqual([...shares].sort((a, b) => b - a))
  })

  it('applies limit per symbol and requests only institutionOwnership', async () => {
    const { frame, client } = await run(fakeClient(), ['MU', 'NVDA'], 2)
    expect(objects(frame).map((r) => `${r.symbol} ${r.holder}`)).toEqual(['MU Blackrock Inc.', 'MU Vanguard Capital Management LLC', 'NVDA Blackrock Inc.', 'NVDA Vanguard Capital Management LLC'])
    expect(client.calls.quoteSummary).toEqual([
      ['MU', { modules: ['institutionOwnership'] }],
      ['NVDA', { modules: ['institutionOwnership'] }],
    ])
  })

  it('skips a symbol without the module, and throws only when every symbol fails', async () => {
    const base = fakeClient()
    const client = fakeClient({ quoteSummary: async (s, o) => (s === 'SMH' ? {} : base.quoteSummary(s, o)) })
    const { frame, ctx } = await run(client, ['SMH', 'MU'], 1)
    expect(objects(frame).map((r) => r.symbol)).toEqual(['MU'])
    expect(ctx.logs).toEqual(['institutions: skipped SMH: no institutional holders on Yahoo (fund or index?)'])
    const dead = fakeClient({ quoteSummary: async () => { throw new Error('HTTP 500') } })
    await expect(run(dead, ['MU', 'NVDA'])).rejects.toThrow(/institutions failed for every input \(2\): HTTP 500/)
  })
})
