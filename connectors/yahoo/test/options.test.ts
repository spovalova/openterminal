import { describe, expect, it } from 'vitest'
import { KINDS } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { daysBetween, pickExpiration } from '../src/options.js'
import { V12_NOW, fakeClient, fixtures, objects, testCtx } from './helpers.js'

type Params = { symbol: string; expiration?: string; strikes: number; type: 'call' | 'put' | 'both' }
const run = (client = fakeClient(), params: Partial<Params> = {}, now: Date = V12_NOW) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client, now: () => now })
  return c.queries.options!({ symbol: 'MU', strikes: 10, type: 'both', ...params }, ctx).then((frame) => ({ frame, ctx, client }))
}
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe('options', () => {
  it('emits the catalog columns for the strike window at the requested expiration, iv as percent, greeks null', async () => {
    const { frame } = await run(fakeClient(), { expiration: '2026-10-19', strikes: 2 })
    expect(frame.columns).toEqual(KINDS.options.columns)
    const rows = objects(frame)
    // Two strikes below 878.84 (870, 875) and two at or above (880, 885), calls before puts at each strike.
    expect(rows.map((r) => `${r.strike} ${r.type}`)).toEqual(['870 call', '870 put', '875 call', '875 put', '880 call', '880 put', '885 call', '885 put'])
    expect(rows[0]).toEqual({
      symbol: 'MU', expiration: '2026-10-19', type: 'call', strike: 870, bid: 19.65, ask: 20, last: 20.4, volume: 515, open_interest: 116,
      iv: 58.0632, delta: null, gamma: null, theta: null, vega: null, underlying_price: 878.84, dte: 1,
    })
    expect(rows[1]).toMatchObject({ type: 'put', strike: 870, bid: 11.05, ask: 11.2, last: 10.8, volume: 3420, open_interest: 848, iv: 58.6186, dte: 1 })
  })

  it('omitted expiration means the nearest at least 7 days out, fetched with a second call', async () => {
    // Listed: 10-19 (1d), 10-21 (3d), 10-23 (5d), 10-26 (8d) as of Sunday 2026-10-18.
    const { frame, client } = await run(fakeClient(), { strikes: 2 })
    const rows = objects(frame)
    expect(client.calls.options).toEqual([
      ['MU', {}],
      ['MU', { date: d('2026-10-26') }],
    ])
    expect(new Set(rows.map((r) => r.expiration))).toEqual(new Set(['2026-10-26']))
    expect(new Set(rows.map((r) => r.dte))).toEqual(new Set([8]))
    // The window is the union of call and put strikes; this chain lists no calls between 850 and 900, so only puts remain.
    expect(rows.map((r) => `${r.strike} ${r.type}`)).toEqual(['870 put', '875 put', '880 put', '885 put'])
    expect(rows[0]).toMatchObject({ bid: 25.05, ask: 27.45, last: 24.79, volume: 25, open_interest: 81, iv: 55.637, underlying_price: 878.84 })
  })

  it('a given expiration snaps forward to the first listed date on or after it; the nearest chain needs no second call', async () => {
    const snapped = await run(fakeClient(), { expiration: '2026-10-24', strikes: 1 })
    expect(snapped.client.calls.options.map(([, o]) => o)).toEqual([{}, { date: d('2026-10-26') }])
    expect(objects(snapped.frame).map((r) => r.expiration)).toEqual(Array(objects(snapped.frame).length).fill('2026-10-26'))

    const far = await run(fakeClient(), { expiration: '2026-12-01', strikes: 1 })
    expect(objects(far.frame).map((r) => `${r.expiration} ${r.strike} ${r.type} ${r.dte}`)).toEqual(['2026-12-18 870 call 61', '2026-12-18 870 put 61', '2026-12-18 880 call 61', '2026-12-18 880 put 61'])

    const exact = await run(fakeClient(), { expiration: '2026-10-19', strikes: 1 })
    expect(exact.client.calls.options).toEqual([['MU', {}]])
    expect(objects(exact.frame).map((r) => `${r.strike} ${r.type}`)).toEqual(['875 call', '875 put', '880 call', '880 put'])
  })

  it('falls back to the nearest expiration at least 1 day out when none is 7 days out, and throws when none is upcoming', async () => {
    const recorded = fixtures.options().bySymbol['MU']!
    const base = fakeClient()
    const client = () =>
      fakeClient({
        options: async (s, o) => ({ ...(await base.options(s, o)), expirationDates: recorded.expirationDates.slice(0, 2) }), // 10-19 and 10-21 only
      })
    const sunday = await run(client(), { strikes: 1 })
    expect(objects(sunday.frame).map((r) => r.expiration)).toEqual(Array(4).fill('2026-10-19'))
    expect(sunday.client.calls.options).toHaveLength(1)

    // On the 19th itself that chain is 0 days out, so the 21st (not recorded) is asked for.
    await expect(run(client(), { strikes: 1 }, new Date('2026-10-19T14:00:00.000Z'))).rejects.toThrow(/no options fixture for MU at 2026-10-21/)
    await expect(run(client(), { strikes: 1 }, new Date('2026-10-21T14:00:00.000Z'))).rejects.toThrow(/options: MU has no upcoming expiration/)
    await expect(run(fakeClient(), { expiration: '2030-01-01' })).rejects.toThrow(/options: MU has no expiration on or after 2030-01-01/)
  })

  it('pickExpiration and daysBetween implement the catalog rule', () => {
    const listed = ['2026-10-19', '2026-10-21', '2026-10-26', '2026-11-20'].map(d)
    expect(pickExpiration(listed, '2026-10-18')).toEqual(d('2026-10-26'))
    expect(pickExpiration(listed, '2026-10-19')).toEqual(d('2026-10-26'))
    expect(pickExpiration(listed, '2026-10-20')).toEqual(d('2026-11-20'))
    expect(pickExpiration(listed.slice(0, 2), '2026-10-18')).toEqual(d('2026-10-19'))
    expect(pickExpiration(listed.slice(0, 2), '2026-10-19')).toEqual(d('2026-10-21'))
    expect(pickExpiration(listed.slice(0, 2), '2026-10-21')).toBeUndefined()
    expect(pickExpiration(listed, '2026-10-18', '2026-10-21')).toEqual(d('2026-10-21'))
    expect(pickExpiration(listed, '2026-10-18', '2026-10-22')).toEqual(d('2026-10-26'))
    expect(pickExpiration(listed, '2026-10-18', '2026-10-01')).toEqual(d('2026-10-19'))
    expect(pickExpiration(listed, '2026-10-18', '2026-12-01')).toBeUndefined()
    expect(pickExpiration([...listed].reverse(), '2026-10-18')).toEqual(d('2026-10-26'))
    expect(daysBetween('2026-10-18', '2026-10-26')).toBe(8)
    expect(daysBetween('2026-10-18', '2026-10-18')).toBe(0)
  })

  it('filters by type, keeps rows sorted by strike, and caps the window at the strikes Yahoo lists', async () => {
    const calls = objects((await run(fakeClient(), { expiration: '2026-12-18', strikes: 3, type: 'call' })).frame)
    expect(calls.map((r) => `${r.strike} ${r.type}`)).toEqual(['850 call', '860 call', '870 call', '880 call', '890 call', '900 call'])
    const puts = objects((await run(fakeClient(), { expiration: '2026-12-18', strikes: 3, type: 'put' })).frame)
    expect(puts.map((r) => `${r.strike} ${r.type}`)).toEqual(['850 put', '860 put', '870 put', '880 put', '890 put', '900 put'])
    // The recorded chain holds 14 strikes a side, so 30 a side yields every contract.
    const all = objects((await run(fakeClient(), { expiration: '2026-12-18', strikes: 30 })).frame)
    expect(all).toHaveLength(56)
    const strikes = all.map((r) => r.strike as number)
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b))
  })

  it('upper-cases the symbol and nulls a missing bid, ask, volume or open interest', async () => {
    const base = fakeClient()
    const client = fakeClient({
      options: async (s, o) => {
        const r = await base.options(s, o)
        const chain = r.options[0]!
        return { ...r, options: [{ ...chain, calls: chain.calls.map((c) => ({ ...c, bid: undefined, ask: undefined, volume: undefined, openInterest: undefined })) }] }
      },
    })
    const { frame } = await run(client, { symbol: 'mu', expiration: '2026-10-19', strikes: 1, type: 'call' })
    expect(client.calls.options[0]![0]).toBe('MU')
    expect(objects(frame)).toEqual([
      { symbol: 'MU', expiration: '2026-10-19', type: 'call', strike: 875, bid: null, ask: null, last: 17.23, volume: null, open_interest: null, iv: 57.7397, delta: null, gamma: null, theta: null, vega: null, underlying_price: 878.84, dte: 1 },
      { symbol: 'MU', expiration: '2026-10-19', type: 'call', strike: 880, bid: null, ask: null, last: 14.32, volume: null, open_interest: null, iv: 56.9829, delta: null, gamma: null, theta: null, vega: null, underlying_price: 878.84, dte: 1 },
    ])
  })

  it('propagates a failed call so the registry can fall back', async () => {
    const dead = fakeClient({ options: async () => { throw new Error('HTTP 500') } })
    await expect(run(dead)).rejects.toThrow('HTTP 500')
    const noPrice = fakeClient({ options: async (s, o) => { const r = await fakeClient().options(s, o); return { ...r, quote: { ...r.quote, regularMarketPrice: undefined } } } })
    await expect(run(noPrice, { expiration: '2026-10-19' })).rejects.toThrow(/no underlying price/)
  })
})
