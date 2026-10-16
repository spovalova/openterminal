import { describe, expect, it } from 'vitest'
import { KINDS, type Interval, type Range } from '@terminal/core'
import { createYahooConnector } from '../src/index.js'
import { RECORDED_AT, fakeClient, fixtures, objects, testCtx } from './helpers.js'

type Params = { symbols: string[]; interval: Interval; range: Range }

const run = (client = fakeClient(), params: Params = { symbols: ['MU'], interval: '5m', range: '1d' }, now: Date = RECORDED_AT) => {
  const ctx = testCtx()
  const c = createYahooConnector({ client, now: () => now })
  return c.queries.ohlcv!(params, ctx).then((frame) => ({ frame, ctx, client }))
}

describe('ohlcv', () => {
  it('emits the catalog columns, time as epoch ms, one row per bar with a close', async () => {
    const { frame } = await run()
    expect(frame.columns).toEqual(KINDS.ohlcv.columns)
    const rows = objects(frame)
    const fixture = fixtures.chart().byKey['MU-5m-1d']!
    expect(rows).toHaveLength(fixture.quotes.length)
    const first = fixture.quotes[0]!
    expect(rows[0]).toEqual({
      symbol: 'MU',
      time: Date.UTC(2026, 9, 16, 13, 30), // 09:30 ET, the first regular-session bar
      open: first.open,
      high: first.high,
      low: first.low,
      close: first.close,
      volume: first.volume,
    })
    expect(first.date.getTime()).toBe(Date.UTC(2026, 9, 16, 13, 30))
    for (const r of rows) expect(Number.isInteger(r.time)).toBe(true)
  })

  it('keeps the live partial bar when its close is set and drops bars with a null close', async () => {
    const recorded = fixtures.chart().byKey['MU-5m-1d']!
    const last = recorded.quotes.at(-1)!
    expect(last.volume).toBe(0) // the 16:00 ET partial bar as recorded
    const client = fakeClient({
      chart: async () => ({
        meta: recorded.meta,
        quotes: [
          ...recorded.quotes.slice(0, 3),
          { ...recorded.quotes[3]!, close: null, open: null, high: null, low: null, volume: null },
          last,
        ],
      }),
    })
    const { frame } = await run(client)
    const rows = objects(frame)
    expect(rows).toHaveLength(4)
    expect(rows.at(-1)!.time).toBe(last.date.getTime())
  })

  it('sorts rows by symbol then time regardless of input order', async () => {
    const { frame, client } = await run(fakeClient(), { symbols: ['nvda', 'MU'], interval: '5m', range: '1d' })
    expect(client.calls.chart.map(([s]) => s)).toEqual(['NVDA', 'MU'])
    const rows = objects(frame)
    const keys = rows.map((r) => [r.symbol as string, r.time as number] as const)
    const sorted = [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
    expect(keys).toEqual(sorted)
    expect(rows[0]!.symbol).toBe('MU')
    expect(rows.at(-1)!.symbol).toBe('NVDA')
  })

  it('maps 1w to 1wk, passes includePrePost false, and never sends a range option', async () => {
    const { client } = await run(fakeClient(), { symbols: ['MU'], interval: '1w', range: '6mo' })
    const [, opts] = client.calls.chart[0]!
    expect(opts).toMatchObject({ interval: '1wk', includePrePost: false })
    expect(opts).not.toHaveProperty('range')
  })

  it.each<[Interval, string]>([
    ['1m', '1m'],
    ['5m', '5m'],
    ['15m', '15m'],
    ['1h', '1h'],
    ['1d', '1d'],
    ['1w', '1wk'],
  ])('interval %s is sent as %s', async (ours, yahoo) => {
    const client = fakeClient({ chart: async () => ({ meta: {} as any, quotes: [] }) })
    await run(client, { symbols: ['MU'], interval: ours, range: '5d' })
    expect(client.calls.chart[0]![1]).toMatchObject({ interval: yahoo })
  })

  describe('range to period', () => {
    const periods = async (range: Range, now: Date) => {
      const client = fakeClient({ chart: async () => ({ meta: {} as any, quotes: [] }) })
      await run(client, { symbols: ['MU'], interval: '1d', range }, now)
      const o = client.calls.chart[0]![1] as { period1: Date; period2: Date }
      return { period1: o.period1.toISOString(), period2: o.period2.toISOString() }
    }
    const now = new Date('2026-10-16T20:40:00.000Z')

    it('period2 is now; calendar ranges step back whole months, 5d steps back a week', async () => {
      expect(await periods('5d', now)).toEqual({ period1: '2026-10-09T20:40:00.000Z', period2: now.toISOString() })
      expect(await periods('1mo', now)).toEqual({ period1: '2026-09-16T20:40:00.000Z', period2: now.toISOString() })
      expect(await periods('3mo', now)).toEqual({ period1: '2026-07-16T20:40:00.000Z', period2: now.toISOString() })
      expect(await periods('6mo', now)).toEqual({ period1: '2026-04-16T20:40:00.000Z', period2: now.toISOString() })
      expect(await periods('1y', now)).toEqual({ period1: '2025-10-16T20:40:00.000Z', period2: now.toISOString() })
      expect(await periods('5y', now)).toEqual({ period1: '2021-10-16T20:40:00.000Z', period2: now.toISOString() })
    })

    it('clamps month arithmetic to the last day of the shorter month', async () => {
      expect((await periods('1mo', new Date('2026-03-31T12:00:00.000Z'))).period1).toBe('2026-02-28T12:00:00.000Z')
    })

    it('1d starts at NY midnight of today when queried after the open on a weekday', async () => {
      // Friday 16:40 ET: today's session, EDT so midnight is 04:00Z.
      expect((await periods('1d', now)).period1).toBe('2026-10-16T04:00:00.000Z')
      // Wednesday 09:30 ET exactly: the open has passed.
      expect((await periods('1d', new Date('2026-10-14T13:30:00.000Z'))).period1).toBe('2026-10-14T04:00:00.000Z')
    })

    it('1d falls back to the previous session before the open and on weekends', async () => {
      // Monday 08:00 ET: previous Friday.
      expect((await periods('1d', new Date('2026-10-19T12:00:00.000Z'))).period1).toBe('2026-10-16T04:00:00.000Z')
      // Wednesday 09:29 ET: Tuesday.
      expect((await periods('1d', new Date('2026-10-14T13:29:00.000Z'))).period1).toBe('2026-10-13T04:00:00.000Z')
      // Saturday and Sunday: Friday.
      expect((await periods('1d', new Date('2026-10-17T15:00:00.000Z'))).period1).toBe('2026-10-16T04:00:00.000Z')
      expect((await periods('1d', new Date('2026-10-18T15:00:00.000Z'))).period1).toBe('2026-10-16T04:00:00.000Z')
      // Early Tuesday UTC is still Monday evening in New York: Monday's session.
      expect((await periods('1d', new Date('2026-10-20T01:00:00.000Z'))).period1).toBe('2026-10-19T04:00:00.000Z')
    })

    it('1d respects standard time (05:00Z midnight) in winter', async () => {
      expect((await periods('1d', new Date('2026-01-15T20:00:00.000Z'))).period1).toBe('2026-01-15T05:00:00.000Z')
    })
  })

  it('logs and skips a symbol whose chart call fails, keeping the others', async () => {
    const base = fakeClient()
    const client = fakeClient({
      chart: async (symbol, opts) => {
        if (symbol === 'NVDA') throw new Error('Not Found')
        return base.chart(symbol, opts)
      },
    })
    const { frame, ctx } = await run(client, { symbols: ['MU', 'NVDA'], interval: '5m', range: '1d' })
    expect(new Set(objects(frame).map((r) => r.symbol))).toEqual(new Set(['MU']))
    expect(ctx.logs).toEqual(['ohlcv: skipped NVDA: Not Found'])
  })

  it('throws when every symbol fails', async () => {
    const client = fakeClient({ chart: async () => { throw new Error('Not Found') } })
    await expect(run(client, { symbols: ['MU', 'NVDA'], interval: '5m', range: '1d' })).rejects.toThrow(/ohlcv failed for every input \(2\): Not Found/)
  })
})
