import { describe, expect, it } from 'vitest'
import { BADGE_MAX, atTheMoney, badgePlan, barOnlyPanes, rebaseData, signedPercent, stackBadges } from '../ChartView'
import type { SeriesSpec } from '../chart/data'

const series = (id: string, over: Partial<SeriesSpec> = {}): SeriesSpec => ({
  id,
  pane: 0,
  kind: 'line',
  color: '#000',
  label: id,
  group: id,
  data: [],
  side: 'right',
  format: 'price',
  precision: 2,
  width: 2,
  legend: true,
  lastValue: true,
  range: undefined,
  markers: [],
  priceLines: [],
  bands: [],
  first: 1,
  last: 2,
  changePct: 100,
  byTime: new Map(),
  ...over,
})

describe('badgePlan (taste round 2, change 3: at most three badges per chart)', () => {
  it('badges three series or fewer on the price pane and leaves the rest of the three to levels', () => {
    const plan = badgePlan({ x: 'time', series: [series('a'), series('b'), series('vol', { kind: 'histogram' })] })
    expect(BADGE_MAX).toBe(3)
    expect([...plan.series]).toEqual(['a', 'b'])
    expect(plan.levels).toBe(1)
    expect(plan.legend).toBe('badges')
  })
  it('past three series the legend carries the values and no badge stacks into a column', () => {
    const plan = badgePlan({ x: 'time', series: ['AAPL', 'AMZN', 'GOOGL', 'META', 'MSFT', 'NVDA', 'TSLA'].map((s) => series(s)) })
    expect(plan.series.size).toBe(0)
    expect(plan.levels).toBe(0)
    expect(plan.legend).toBe('values')
  })
  it('never badges a strike axis or an indicator pane', () => {
    expect(badgePlan({ x: 'number', series: [series('oi', { kind: 'histogram' }), series('vol', { kind: 'histogram' })] })).toEqual({ series: new Set(), levels: 0, legend: 'totals' })
    const plan = badgePlan({ x: 'time', series: [series('amd'), series('rsi', { pane: 2 }), series('macd', { pane: 3 }), series('signal', { pane: 3 })] })
    expect([...plan.series]).toEqual(['amd'])
  })
})

describe('rebased charts read one number (round 2)', () => {
  it('plots the percent change from the first value, candles and lines alike', () => {
    expect(rebaseData([{ time: 1, value: 50 }, { time: 2, value: 75 }] as never, 50)).toEqual([
      { time: 1, value: 0 },
      { time: 2, value: 50 },
    ])
    expect(rebaseData([{ time: 1, open: 100, high: 110, low: 90, close: 105 }] as never, 100)).toEqual([{ time: 1, open: 0, high: 10, low: -10, close: 5 }])
    expect(signedPercent(-28.14)).toBe('-28.14%')
    expect(signedPercent(25.844)).toBe('+25.84%')
  })
  it('reads a by-strike line at the strike nearest the underlying, never the last strike', () => {
    const iv = series('iv', { byTime: new Map([[340, 0.62], [350, 0.6], [360, 0.58], [370, 0.57], [390, 0.55]]) })
    expect(atTheMoney(iv, 367.9)).toEqual({ strike: 370, value: 0.57 })
    expect(atTheMoney(iv, undefined)).toBeUndefined()
  })
})

describe('stackBadges (change 4: badges never collide)', () => {
  it('leaves separated badges alone and pushes a colliding one 16px under the one above', () => {
    expect(stackBadges([{ top: 100 }, { top: 140 }], 0, 300).map((b) => b.top)).toEqual([100, 140])
    expect(stackBadges([{ top: 100 }, { top: 104 }, { top: 110 }], 0, 300).map((b) => b.top)).toEqual([100, 116, 132])
  })
  it('sorts by position so 71.86 over 71.08 stays in value order', () => {
    expect(stackBadges([{ top: 120, id: 'b' }, { top: 100, id: 'a' }], 0, 300).map((b) => b.id)).toEqual(['a', 'b'])
  })
  it('keeps a stacked group inside the pane', () => {
    const out = stackBadges([{ top: 290 }, { top: 292 }, { top: 294 }], 0, 300)
    expect(out.map((b) => b.top)).toEqual([260, 276, 292])
    expect(stackBadges([{ top: 2 }], 0, 300)[0]!.top).toBe(8)
  })
  it('stacks a level with the last values (the 360 strike sat under the 368.20 badge)', () => {
    const out = stackBadges([{ top: 100, id: 'last' }, { top: 108, id: 'level 360' }, { top: 120, id: 'level 350' }], 0, 300)
    expect(out.map((b) => [b.id, b.top])).toEqual([
      ['last', 100],
      ['level 360', 116],
      ['level 350', 132],
    ])
  })
})

describe('barOnlyPanes (bars by strike carry their last value)', () => {
  it('names the panes whose badge-carrying series are all bars', () => {
    // OI and volume by strike: one pane of bars.
    expect([...barOnlyPanes([{ pane: 0, kind: 'histogram', lastValue: true }, { pane: 0, kind: 'histogram', lastValue: true }])]).toEqual([0])
    // Candles over volume, MACD lines with their histogram, a volume pane without last values: none.
    expect([...barOnlyPanes([{ pane: 0, kind: 'candle', lastValue: true }, { pane: 0, kind: 'histogram', lastValue: true }])]).toEqual([])
    expect([...barOnlyPanes([{ pane: 1, kind: 'histogram', lastValue: false }])]).toEqual([])
    expect([...barOnlyPanes([{ pane: 2, kind: 'histogram', lastValue: true }, { pane: 2, kind: 'line', lastValue: true }])]).toEqual([])
  })
})
