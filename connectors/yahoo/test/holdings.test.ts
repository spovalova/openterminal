import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { fakeClient, objects, testCtx } from './helpers.js'

const run = (client = fakeClient(), symbol = 'SMH') => {
  const ctx = testCtx()
  const c = createYahooConnector({ client })
  return c.queries.holdings!({ symbol }, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('holdings', () => {
  it('emits the catalog columns with the ETF, constituent, name and weight as percent, largest first', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.holdings.columns)
    const rows = objects(frame)
    expect(rows).toHaveLength(10) // Yahoo's topHoldings is the top ten
    expect(rows.slice(0, 3)).toEqual([
      { etf: 'SMH', symbol: 'NVDA', name: 'NVIDIA Corp', weight: 19.3104 },
      { etf: 'SMH', symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Co Ltd ADR', weight: 9.2795 },
      { etf: 'SMH', symbol: 'AMD', name: 'Advanced Micro Devices Inc', weight: 5.541 },
    ])
    const weights = rows.map((r) => r.weight as number)
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })

  it('upper-cases the symbol and requests only topHoldings', async () => {
    const { frame, client } = await run(fakeClient(), ' smh ')
    expect(objects(frame)[0]!.etf).toBe('SMH')
    expect(client.calls.quoteSummary).toEqual([['SMH', { modules: ['topHoldings'] }]])
  })

  it('throws for a symbol that is not a fund so the registry can fall back', async () => {
    await expect(run(fakeClient(), 'MU')).rejects.toThrow(/no quoteSummary fixture for MU/)
    const stock = fakeClient({ quoteSummary: async () => ({}) })
    await expect(run(stock, 'MU')).rejects.toThrow(/holdings: MU has no holdings on Yahoo \(not a fund\?\)/)
  })
})
