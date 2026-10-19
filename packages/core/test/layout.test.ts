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
  it('makes a stat and a facts card one row tall whatever the size, and never the full width of a grid (change 1)', () => {
    expect(effectiveSpan(hint('lg', { kind: 'stat', rows: 1 }), 3, 4)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('lg', { kind: 'facts', rows: 1 }), 3, 4)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('sm', { kind: 'stat' }), 3, 4)).toEqual({ cols: 1, rows: 1, demoted: false })
    expect(effectiveSpan(hint('md', { kind: 'stat' }), 2, 4)).toEqual({ cols: 1, rows: 1, demoted: true }) // two columns: one, not both
    expect(effectiveSpan(hint('md', { kind: 'facts' }), 1, 4)).toEqual({ cols: 1, rows: 1, demoted: false })
  })
  it('never makes a chart taller than it is wide: the lg hero is 2x2, an md chart one cell in three columns, an sm chart one cell (change 1)', () => {
    expect(effectiveSpan(hint('lg', { kind: 'chart' }), 3, 6)).toEqual({ cols: 2, rows: 2, demoted: false })
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 3, 6)).toEqual({ cols: 1, rows: 1, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 3, 2)).toEqual({ cols: 1, rows: 1, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 2, 6)).toEqual({ cols: 2, rows: 1, demoted: false }) // two columns: the md span as is
    expect(effectiveSpan(hint('sm', { kind: 'chart' }), 3, 3)).toEqual({ cols: 1, rows: 1, demoted: false })
    expect(effectiveSpan(hint('lg', { kind: 'chart' }), 1, 3)).toEqual({ cols: 1, rows: 1, demoted: true }) // one column: never 1x2
    for (const size of ['lg', 'md', 'sm'] as Size[]) for (const columns of [1, 2, 3]) {
      const span = effectiveSpan(hint(size, { kind: 'chart' }), columns, 5)
      expect(span.rows).toBeLessThanOrEqual(span.cols)
    }
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

describe('packLayout prefers stretching a chart over a short table (phase 2, from the (d) report)', () => {
  const hint = (size: Size, contentHint: ContentHint) => ({ size, contentHint })
  it('a three-row table is not pulled up beside the hero when the cell under it would be a hole: the hero chart grows across instead', () => {
    // lg chart, sm earnings table (3 rows), md chart, md news table (12 rows): the (d) screenshot.
    const widgets = [hint('lg', { kind: 'chart', rows: 60 }), hint('sm', { kind: 'table', rows: 3 }), hint('md', { kind: 'chart', rows: 60 }), hint('md', { kind: 'table', rows: 12 })]
    const p = packLayout(widgets, 3)
    expect(hasHoles(p, 3)).toBe(false)
    // The md chart is one cell in this grid (change 1), so it fills the cell under the table beside the hero; the news table takes the row under.
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 3, 1],
    ])
    expect(p.slice(0, 3).every((x) => !x.stretched)).toBe(true)
  })
  it('the same set with a two-column-wide md chart (two columns in the grid): the hero grows across and the table keeps one row', () => {
    const widgets = [hint('lg', { kind: 'chart', rows: 60 }), hint('sm', { kind: 'table', rows: 3 }), hint('md', { kind: 'chart', rows: 60 }), hint('md', { kind: 'table', rows: 12 })]
    const p = packLayout(widgets, 2)
    expect(hasHoles(p, 2)).toBe(false)
    expect(p[1]!.rows).toBe(1)
    expect(p[3]!.rows).toBe(1)
  })
  it('a short table still sits beside the hero when a later one-cell widget fills the cell under it', () => {
    const widgets = [hint('lg', { kind: 'chart' }), hint('sm', { kind: 'table', rows: 3 }), hint('sm', { kind: 'stat', rows: 4 }), hint('md', { kind: 'table', rows: 20 })]
    const p = packLayout(widgets, 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(cells(p).slice(0, 3)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
    ])
    expect(p.slice(0, 3).every((x) => !x.stretched)).toBe(true)
  })
  it('with only a hero and a short table, the hero takes the width and the table takes a row', () => {
    const p = packLayout([hint('lg', { kind: 'chart' }), hint('sm', { kind: 'table', rows: 3 })], 3)
    expect(cells(p)).toEqual([
      [0, 0, 3, 2],
      [0, 2, 3, 1],
    ])
  })
  it('when a hole has a chart and a short widget as neighbours, the chart grows; a short widget grows sideways before taller', () => {
    // The hole at (2,2) has the four-row table to its left (short, sideways), the facts card above it (short, taller)
    // and the twelve-row table below it (fills its height): the long table grows up.
    const widgets = [hint('lg', { kind: 'chart' }), hint('lg', { kind: 'table', rows: 4 }), hint('sm', { kind: 'stat', rows: 1 }), hint('md', { kind: 'table', rows: 12 }), hint('sm', { kind: 'facts', rows: 1 })]
    const p = packLayout(widgets, 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(p[2]!.rows).toBe(1)
    expect(p[4]!.rows).toBe(1)
    expect(p[1]!.rows).toBe(1)
  })
  it('a long table, a stat and a chart (the cheap-tech case): the stat keeps one row and the one-cell chart sits under it beside the table', () => {
    const p = packLayout([hint('lg', { kind: 'table', rows: 43 }), hint('sm', { kind: 'stat', rows: 1 }), hint('md', { kind: 'chart', rows: 11 })], 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
    ])
    expect(p[1]!.rows).toBe(1)
  })
  it('the curve case (hero, two md charts, a stat): the stat shares the column beside the hero with one chart and the other chart takes the row under, so the stat is never full width', () => {
    const widgets = [hint('lg', { kind: 'chart', rows: 1248 }), hint('md', { kind: 'chart', rows: 11 }), hint('md', { kind: 'chart', rows: 1248 }), hint('sm', { kind: 'stat', rows: 1 })]
    const p = packLayout(widgets, 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(p[3]!.rows).toBe(1)
    expect(p[3]!.cols).toBe(1)
    expect(p.reduce((n, x) => Math.max(n, x.row + x.rows), 0)).toBe(3)
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [0, 2, 3, 1],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
    ])
  })
  it('change 1: no chart is ever portrait and no stat or facts card is full width when any other layout fills the grid', () => {
    // The neoclouds case: hero compare, the compare table (the answer), a quote row, news. The table and the stat share
    // the column beside the hero; the news table takes the row under; nothing is portrait.
    const neo = [hint('lg', { kind: 'chart', rows: 500 }), hint('md', { kind: 'table', rows: 19 }), hint('md', { kind: 'stat', rows: 4 }), hint('md', { kind: 'table', rows: 20 })]
    const p = packLayout(neo, 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(cells(p)).toEqual([
      [0, 0, 2, 2],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 3, 1],
    ])
    // The crwv case: hero, two md charts, a quote, two tables: three rows, every chart one cell or the 2x2 hero.
    const crwv = [hint('lg', { kind: 'chart', rows: 100 }), hint('md', { kind: 'chart', rows: 20 }), hint('md', { kind: 'chart', rows: 60 }), hint('sm', { kind: 'stat', rows: 1 }), hint('md', { kind: 'table', rows: 12 }), hint('md', { kind: 'table', rows: 20 })]
    const q = packLayout(crwv, 3)
    expect(hasHoles(q, 3)).toBe(false)
    expect(q.reduce((n, x) => Math.max(n, x.row + x.rows), 0)).toBe(3)
    for (const x of q) expect(x.rows).toBeLessThanOrEqual(x.cols)
    expect(q[3]!.cols).toBe(1)
    // The morning case: a seven-symbol quote row, a chart and a news table tile one band.
    const morning = [hint('lg', { kind: 'stat', rows: 7 }), hint('md', { kind: 'chart', rows: 20 }), hint('md', { kind: 'table', rows: 20 })]
    expect(cells(packLayout(morning, 3))).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
    ])
  })
  it('a dense placement that strands a short widget at every slot takes the first such slot, never a fresh row past the limit', () => {
    // A hero and a two-column stat: the stat goes right under the hero (both grow across), not four rows down.
    const p = packLayout([hint('lg', { kind: 'chart', rows: 100 }), hint('md', { kind: 'stat', rows: 5 })], 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(p.reduce((n, x) => Math.max(n, x.row + x.rows), 0)).toBe(3)
    expect(p[0]!.rows).toBe(2)
  })
  it('never stretches a stat, a facts card or a short table taller when any other neighbour can grow, over random hinted sets', () => {
    const kinds: ContentHint[] = [{ kind: 'chart', rows: 50 }, { kind: 'table', rows: 3 }, { kind: 'table', rows: 20 }, { kind: 'stat', rows: 2 }, { kind: 'facts', rows: 1 }, { kind: 'chain', rows: 40 }]
    const all: Size[] = ['lg', 'md', 'sm']
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rnd() * 7)
      const widgets = Array.from({ length: n }, () => ({ size: all[Math.floor(rnd() * 3)]!, contentHint: kinds[Math.floor(rnd() * kinds.length)]! }))
      for (const columns of [2, 3]) {
        const p = packLayout(widgets, columns)
        expect(p, JSON.stringify(widgets)).toHaveLength(n)
        expect(hasHoles(p, columns), JSON.stringify(widgets)).toBe(false)
        for (const x of p) expect(x.col + x.cols).toBeLessThanOrEqual(columns)
      }
    }
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
  it('caps the row at two thirds of the column width when it knows it (change 1): 1440 with the panel open gets the minimum, 1920 gets 332', () => {
    expect(rowHeightFor(2, 790, 52, 342)).toBe(MIN_ROW_HEIGHT)
    expect(rowHeightFor(3, 790, 52, 342)).toBe(MIN_ROW_HEIGHT)
    expect(rowHeightFor(2, 970, 52, 503)).toBe(332)
    expect(rowHeightFor(3, 970, 52, 503)).toBe(300)
    expect(rowHeightFor(2, 1400, 52)).toBe(670)
  })
  it('falls back to the minimum before the pane is measured', () => {
    expect(rowHeightFor(2, 0)).toBe(MIN_ROW_HEIGHT)
    expect(rowHeightFor(0, 740)).toBe(MIN_ROW_HEIGHT)
  })
})
