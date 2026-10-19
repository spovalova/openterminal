import { describe, expect, it } from 'vitest'
import { barOnlyPanes, stackBadges } from '../ChartView'

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
