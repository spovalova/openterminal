import { describe, expect, it } from 'vitest'
import { stackBadges } from '../ChartView'

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
})
