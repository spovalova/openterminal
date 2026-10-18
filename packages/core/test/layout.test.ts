import { describe, expect, it } from 'vitest'
import { MIN_ROW_HEIGHT, THREE_COLUMNS_MIN, columnsFor, effectiveSpan, hasHoles, packLayout, rowHeightFor, spanFor, type ContentHint, type Size } from '../src/index.js'

const sizes = (...s: Size[]) => s.map((size) => ({ size }))
const cells = (p: ReturnType<typeof packLayout>) => p.map((x) => [x.col, x.row, x.cols, x.rows])

describe('columnsFor', () => {
  it('is 1 under 720, 2 under 960, 3 from there (v2: a 1440px laptop with the panel open gets three columns)', () => {
    expect(THREE_COLUMNS_MIN).toBe(960)
    expect(columnsFor(600)).toBe(1)
    expect(columnsFor(884)).toBe(2)
    expect(columnsFor(959)).toBe(2)
    expect(columnsFor(960)).toBe(3)
    expect(columnsFor(1060)).toBe(3) // 1440 minus the 380px panel
    expect(columnsFor(1900)).toBe(3)
  })
})

describe('effectiveSpan (size by content)', () => {
  const hint = (size: Size, contentHint: ContentHint) => ({ size, contentHint })
  it('keeps the size span without a hint (v1 behaviour)', () => {
    expect(effectiveSpan({ size: 'lg' }, 3, 5)).toEqual({ cols: 2, rows: 2, demoted: false })
    expect(effectiveSpan({ size: 'md' }, 3, 5)).toEqual({ cols: 2, rows: 1, demoted: false })
  })
  it('makes a table with six rows or fewer one row tall, and leaves longer tables alone', () => {
    expect(effectiveSpan(hint('lg', { kind: 'table', rows: 6 }), 3, 5)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('lg', { kind: 'table', rows: 1 }), 3, 5)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('lg', { kind: 'table', rows: 7 }), 3, 5)).toEqual({ cols: 2, rows: 2, demoted: false })
    expect(effectiveSpan(hint('lg', { kind: 'table' }), 3, 5)).toEqual({ cols: 2, rows: 2, demoted: false })
  })
  it('makes a stat and a facts card one row tall whatever the size', () => {
    expect(effectiveSpan(hint('lg', { kind: 'stat', rows: 1 }), 3, 4)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('lg', { kind: 'facts', rows: 1 }), 3, 4)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('sm', { kind: 'stat' }), 3, 4)).toEqual({ cols: 1, rows: 1, demoted: false })
  })
  it('makes charts two rows tall unless there are more than six widgets', () => {
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 3, 6)).toEqual({ cols: 2, rows: 2, demoted: true })
    expect(effectiveSpan(hint('sm', { kind: 'chart' }), 3, 3)).toEqual({ cols: 1, rows: 2, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 3, 7)).toEqual({ cols: 2, rows: 1, demoted: false })
    expect(effectiveSpan(hint('lg', { kind: 'chart' }), 3, 7)).toEqual({ cols: 2, rows: 2, demoted: false })
  })
  it('leaves the chain alone and clamps columns to the grid', () => {
    expect(effectiveSpan(hint('lg', { kind: 'chain', rows: 40 }), 3, 5)).toEqual({ cols: 2, rows: 2, demoted: false })
    expect(effectiveSpan(hint('lg', { kind: 'table', rows: 3 }), 1, 5)).toEqual({ cols: 1, rows: 1, demoted: true })
  })
  it('packs demoted widgets without holes and reports the demotion', () => {
    const widgets = [hint('lg', { kind: 'chart' }), hint('lg', { kind: 'table', rows: 4 }), hint('sm', { kind: 'stat', rows: 1 }), hint('md', { kind: 'table', rows: 12 }), hint('sm', { kind: 'facts', rows: 1 })]
    for (const columns of [1, 2, 3]) {
      const p = packLayout(widgets, columns)
      expect(hasHoles(p, columns)).toBe(false)
      expect(p[1]!.demoted).toBe(true)
      expect(p[3]!.demoted).toBe(false)
    }
    const three = packLayout(widgets, 3)
    expect(three[0]!.rows).toBe(2)
    expect(three[1]!.rows).toBe(1)
  })
})

describe('spanFor', () => {
  it('clamps the size span to the column count', () => {
    expect(spanFor('lg', 3)).toEqual({ cols: 2, rows: 2 })
    expect(spanFor('lg', 2)).toEqual({ cols: 2, rows: 2 })
    expect(spanFor('md', 2)).toEqual({ cols: 2, rows: 1 })
    expect(spanFor('md', 1)).toEqual({ cols: 1, rows: 1 })
    expect(spanFor('sm', 3)).toEqual({ cols: 1, rows: 1 })
  })
})

describe('packLayout', () => {
  it('leaves no empty cell for every size mix at 1, 2 and 3 columns', () => {
    const all: Size[] = ['lg', 'md', 'sm']
    const mixes: Size[][] = []
    for (let n = 1; n <= 6; n++) {
      for (let seed = 0; seed < 3 ** Math.min(n, 4); seed++) {
        const mix: Size[] = []
        let s = seed
        for (let i = 0; i < n; i++) {
          mix.push(all[s % 3]!)
          s = Math.floor(s / 3)
        }
        mixes.push(mix)
      }
    }
    for (const columns of [1, 2, 3]) {
      for (const mix of mixes) {
        const p = packLayout(sizes(...mix), columns)
        expect(p, `${columns} cols: ${mix.join(',')}`).toHaveLength(mix.length)
        expect(hasHoles(p, columns), `${columns} cols: ${mix.join(',')}`).toBe(false)
        for (const x of p) expect(x.col + x.cols, `${columns} cols: ${mix.join(',')}`).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('keeps a tiling set exactly as its sizes ask (3 cols: lg + sm + sm + md + sm)', () => {
    const p = packLayout(sizes('lg', 'sm', 'sm', 'md', 'sm'), 3)
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 2, 1],
      [2, 2, 1, 1],
    ])
    expect(p.every((x) => !x.stretched)).toBe(true)
  })

  it('pulls a later sm up into the gap beside the hero', () => {
    const p = packLayout(sizes('lg', 'md', 'md', 'sm', 'sm'), 3)
    expect(cells(p)[3]).toEqual([2, 0, 1, 1])
    expect(cells(p)[4]).toEqual([2, 1, 1, 1])
    expect(cells(p)[1]).toEqual([0, 2, 3, 1]) // md stretched across the row
    expect(p[1]!.stretched).toBe(true)
  })

  it('stretches the sm beside a hero to the hero height when nothing else fills it (3 cols: lg sm md md md)', () => {
    const p = packLayout(sizes('lg', 'sm', 'md', 'md', 'md'), 3)
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 2],
      [0, 2, 3, 1],
      [0, 3, 3, 1],
      [0, 4, 3, 1],
    ])
    expect(p.map((x) => x.stretched)).toEqual([false, true, true, true, true])
  })

  it('at two columns the hero and md widgets are full width and two sm share a row', () => {
    const p = packLayout(sizes('lg', 'sm', 'md', 'sm'), 2)
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [0, 2, 1, 1],
      [0, 3, 2, 1],
      [1, 2, 1, 1],
    ])
    expect(p.every((x) => !x.stretched)).toBe(true)
  })

  it('a lone sm at two columns becomes full width', () => {
    const p = packLayout(sizes('lg', 'sm', 'md'), 2)
    expect(cells(p)[1]).toEqual([0, 2, 2, 1])
    expect(p[1]!.stretched).toBe(true)
  })

  it('at one column everything is one column wide and the hero keeps two rows', () => {
    const p = packLayout(sizes('lg', 'md', 'sm'), 1)
    expect(cells(p)).toEqual([
      [0, 0, 1, 2],
      [0, 2, 1, 1],
      [0, 3, 1, 1],
    ])
  })

  it('returns nothing for no widgets', () => {
    expect(packLayout([], 3)).toEqual([])
  })
})

describe('rowHeightFor', () => {
  it('shares the pane height between one or two rows and floors at the minimum from three on', () => {
    expect(rowHeightFor(1, 740, 52)).toBe(688)
    expect(rowHeightFor(2, 740, 52)).toBe(340)
    expect(rowHeightFor(3, 740, 52)).toBe(MIN_ROW_HEIGHT)
    expect(rowHeightFor(6, 740, 52)).toBe(MIN_ROW_HEIGHT)
    expect(rowHeightFor(2, 1400, 52)).toBe(670)
  })
  it('falls back to the minimum before the pane is measured', () => {
    expect(rowHeightFor(2, 0)).toBe(MIN_ROW_HEIGHT)
    expect(rowHeightFor(0, 740)).toBe(MIN_ROW_HEIGHT)
  })
})
