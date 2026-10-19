import { describe, expect, it } from 'vitest'
import { buildSnapshot, canonicalKey, heldFrames, releaseSnapshot, snapshotCurrent, widgetDataKey, type AnyQuery, type Frame, type WidgetV2 } from '../src/index.js'

const frame = (v: number, fetchedAt = 1): Frame => ({ columns: [{ name: 'price', type: 'number' }], rows: [[v]], meta: { connector: 'x', fetchedAt, ttl: 10_000 } })
const quote = (symbols: string[]): AnyQuery => ({ recipe: 'quote', params: { symbols } })
const widget = (id: string, data: Record<string, AnyQuery>): WidgetV2 => ({ id, title: id, size: 'sm', data, view: { preset: 'stat' } }) as WidgetV2
const MON_1429 = Date.UTC(2026, 9, 19, 18, 29) // 14:29 ET on Monday 2026-10-19

describe('the reply snapshot (taste round 2, change 5: one snapshot for the reply and the widgets)', () => {
  it('keeps the frames each widget showed, else the frames the run fetched for the same query', () => {
    const a = widget('a', { main: quote(['AAPL']) })
    const b = widget('b', { main: quote(['MU']), bars: { recipe: 'ohlcv', params: { symbols: ['MU'] } } as AnyQuery })
    const c = widget('c', { main: quote(['TSLA']) })
    const seen = new Map([[canonicalKey(quote(['MU'])), frame(91)], [canonicalKey({ recipe: 'ohlcv', params: { symbols: ['MU'] } } as AnyQuery), frame(90)]])
    const snap = buildSnapshot([a, b, c], new Map([['a/main', frame(343.17)]]), (q) => seen.get(canonicalKey(q)), MON_1429)
    expect(Object.keys(snap.widgets)).toEqual(['a', 'b']) // c: neither shown nor seen, it stays live
    expect(snap.widgets.a!.frames.main!.rows).toEqual([[343.17]])
    expect(snap.widgets.b!.frames.bars!.rows).toEqual([[90]])
    expect(snap.asOf).toBe(MON_1429)
  })
  it('holds a widget\'s frames, marked heldAt, only while its queries are the same and on the trading day the reply was written', () => {
    const a = widget('a', { main: quote(['AAPL']) })
    const snap = buildSnapshot([a], new Map([['a/main', frame(343.17)]]), () => undefined, MON_1429)
    const held = heldFrames(snap, a, MON_1429 + 3_600_000)!
    expect(held.main!.meta.heldAt).toBe(MON_1429)
    expect(held.main!.rows).toEqual([[343.17]])
    expect(heldFrames(snap, widget('a', { main: quote(['AAPL', 'MSFT']) }), MON_1429)).toBeUndefined() // the widget changed
    expect(snapshotCurrent(snap, MON_1429 + 9 * 3_600_000)).toBe(true) // 23:29 ET the same day
    expect(snapshotCurrent(snap, MON_1429 + 24 * 3_600_000)).toBe(false) // the next day: live again
    expect(heldFrames(snap, a, MON_1429 + 24 * 3_600_000)).toBeUndefined()
  })
  it('releases one widget or all of them to live data', () => {
    const a = widget('a', { main: quote(['AAPL']) })
    const b = widget('b', { main: quote(['MU']) })
    const snap = buildSnapshot([a, b], new Map([['a/main', frame(1)], ['b/main', frame(2)]]), () => undefined, MON_1429)
    expect(Object.keys(releaseSnapshot(snap, ['a']).widgets)).toEqual(['b'])
    expect(releaseSnapshot(snap).widgets).toEqual({})
    expect(widgetDataKey(a)).toBe(widgetDataKey(widget('a', { main: quote(['AAPL']) })))
  })
})
