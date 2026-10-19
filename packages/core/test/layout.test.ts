import { describe, expect, it } from 'vitest'
import {
  GRID_GAP,
  THREE_COLUMNS_MIN,
  TRACKS_PER_ROW,
  columnsFor,
  effectiveSpan,
  hasHoles,
  isShortContent,
  minHeight,
  naturalHeight,
  packLayout,
  placementHeight,
  spanFor,
  threeAcross,
  trackHeights,
  type ContentHint,
  type LayoutOptions,
  type LayoutWidget,
  type Placement,
  type Size,
} from '../src/index.js'

const sizes = (...s: Size[]) => s.map((size) => ({ size }))
const cells = (p: ReturnType<typeof packLayout>) => p.map((x) => [x.col, x.row, x.cols, x.rows])
const hint = (size: Size, contentHint: ContentHint): LayoutWidget => ({ size, contentHint })
/** The grid at 1440 with the panel open (343px columns, 751px under the tabs) and at 1920 (503px, 931px). */
const AT_1440: LayoutOptions = { columnWidth: 343, height: 751, gap: GRID_GAP }
const AT_1920: LayoutOptions = { columnWidth: 503, height: 931, gap: GRID_GAP }

/** Track heights for a packing, the way the grid sizes them from the estimates. */
function sized(widgets: LayoutWidget[], p: Placement[], opts: LayoutOptions): number[] {
  const items = p.map((x, i) => {
    const w = x.cols * opts.columnWidth! + (x.cols - 1) * GRID_GAP
    return { short: isShortContent(widgets[i]!), natural: naturalHeight(widgets[i]!.contentHint, w), min: minHeight(widgets[i]!.contentHint, w) }
  })
  return trackHeights(p, items, opts.height!, GRID_GAP)
}

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

describe('spanFor (round 2: rows are tracks, two per row of a size)', () => {
  it('clamps the size span to the column count, in tracks', () => {
    expect(TRACKS_PER_ROW).toBe(2)
    expect(spanFor('lg', 3)).toEqual({ cols: 2, rows: 4 })
    expect(spanFor('md', 2)).toEqual({ cols: 2, rows: 2 })
    expect(spanFor('md', 1)).toEqual({ cols: 1, rows: 2 })
    expect(spanFor('sm', 3)).toEqual({ cols: 1, rows: 2 })
  })
})

describe('effectiveSpan (size by content)', () => {
  it('keeps the size span without a hint (v1 behaviour)', () => {
    expect(effectiveSpan({ size: 'lg' }, 3)).toEqual({ cols: 2, rows: 4, demoted: false })
    expect(effectiveSpan({ size: 'md' }, 3)).toEqual({ cols: 2, rows: 2, demoted: false })
  })
  it('makes a table with six rows or fewer one track tall, and leaves longer tables alone', () => {
    expect(effectiveSpan(hint('lg', { kind: 'table', rows: 6 }), 3)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('lg', { kind: 'table', rows: 7 }), 3)).toEqual({ cols: 2, rows: 4, demoted: false })
    expect(effectiveSpan(hint('lg', { kind: 'table' }), 3)).toEqual({ cols: 2, rows: 4, demoted: false })
  })
  it('round 2: a card is never wider than one column; a stat row is one track and never the full width', () => {
    expect(effectiveSpan(hint('lg', { kind: 'facts', rows: 1 }), 3)).toEqual({ cols: 1, rows: 1, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'stat', items: 1 }), 3)).toEqual({ cols: 1, rows: 1, demoted: true })
    expect(effectiveSpan(hint('lg', { kind: 'stat', items: 7 }), 3)).toEqual({ cols: 2, rows: 1, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'stat', items: 4 }), 2)).toEqual({ cols: 1, rows: 1, demoted: true })
    expect(effectiveSpan(hint('sm', { kind: 'stat' }), 3)).toEqual({ cols: 1, rows: 1, demoted: true })
  })
  it('round 2: a table whose content is narrower than a column takes one column (pairs, reactions, a calendar)', () => {
    expect(effectiveSpan(hint('md', { kind: 'table', rows: 21, width: 220 }), 3, AT_1440)).toEqual({ cols: 1, rows: 2, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'table', rows: 21, width: 560 }), 3, AT_1440)).toEqual({ cols: 2, rows: 2, demoted: false })
    expect(effectiveSpan(hint('md', { kind: 'table', rows: 21, width: 480 }), 3, AT_1920)).toEqual({ cols: 1, rows: 2, demoted: true }) // 550 of 1,520px at 1920 was the reactions table
    expect(effectiveSpan(hint('md', { kind: 'table', rows: 21, width: 220 }), 3)).toEqual({ cols: 2, rows: 2, demoted: false }) // no column width, no narrowing
  })
  it('never makes a chart taller than it is wide: the lg hero is 2 columns by 4 tracks, an md chart one column by two', () => {
    expect(effectiveSpan(hint('lg', { kind: 'chart' }), 3)).toEqual({ cols: 2, rows: 4, demoted: false })
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 3)).toEqual({ cols: 1, rows: 2, demoted: true })
    expect(effectiveSpan(hint('md', { kind: 'chart' }), 2)).toEqual({ cols: 2, rows: 2, demoted: false })
    expect(effectiveSpan(hint('lg', { kind: 'chart' }), 1)).toEqual({ cols: 1, rows: 2, demoted: true })
    for (const size of ['lg', 'md', 'sm'] as Size[]) for (const columns of [1, 2, 3]) {
      const span = effectiveSpan(hint(size, { kind: 'chart' }), columns)
      expect(span.rows).toBeLessThanOrEqual(span.cols * TRACKS_PER_ROW)
    }
  })
  it('leaves the chain alone', () => {
    expect(effectiveSpan(hint('lg', { kind: 'chain', rows: 40 }), 3)).toEqual({ cols: 2, rows: 4, demoted: false })
  })
})

describe('naturalHeight and minHeight (round 2: cards end where their content ends)', () => {
  it('estimates a card from its parts and leaves charts and long tables to the grid', () => {
    const facts = naturalHeight({ kind: 'facts', fields: 6 }, 343)!
    expect(facts).toBeGreaterThan(150)
    expect(facts).toBeLessThan(260)
    expect(naturalHeight({ kind: 'facts', fields: 6 }, 600)).toBeLessThan(facts) // three pairs across
    expect(naturalHeight({ kind: 'stat', items: 7 }, 694)).toBeLessThan(naturalHeight({ kind: 'stat', items: 7 }, 343)! + 1)
    expect(naturalHeight({ kind: 'table', rows: 5 }, 343)).toBe(50 + 32 + 5 * 29 + 4)
    expect(naturalHeight({ kind: 'table', rows: 20 }, 343)).toBeUndefined()
    expect(naturalHeight({ kind: 'chart' }, 343)).toBeUndefined()
  })
  it('gives a comparison chart a 160px plot at least and a long table eight rows', () => {
    expect(minHeight({ kind: 'chart', dense: true }, 343)).toBeGreaterThanOrEqual(300)
    expect(minHeight({ kind: 'chart' }, 1045)).toBeGreaterThanOrEqual(500) // a full-width chart stays landscape
    expect(minHeight({ kind: 'table', rows: 20 }, 343)).toBe(50 + 32 + 8 * 29 + 4)
    expect(minHeight({ kind: 'table', rows: 7 }, 343)).toBe(50 + 32 + 7 * 29 + 4)
  })
})

describe('trackHeights (round 2: the page fills, cards keep their height)', () => {
  const at = (col: number, row: number, cols: number, rows: number): Placement => ({ col, row, cols, rows, stretched: false, demoted: false })
  it('sizes a track of cards to its tallest card and shares the rest between the other tracks', () => {
    // A hero over four tracks, a facts card and a long table beside it.
    const p = [at(0, 0, 2, 4), at(2, 0, 1, 1), at(2, 1, 1, 3)]
    const t = trackHeights(p, [{ short: false, min: 300 }, { short: true, natural: 180, min: 180 }, { short: false, min: 200 }], 751)
    expect(t[0]).toBe(180)
    expect(t.slice(1).every((h) => Math.abs(h - t[1]!) <= 1)).toBe(true)
    expect(t.reduce((s, h) => s + h, 0) + GRID_GAP * (t.length - 1)).toBeGreaterThanOrEqual(749)
  })
  it('gives every widget its minimum, scrolling rather than squeezing', () => {
    const p = [at(0, 0, 3, 2), at(0, 2, 3, 2)]
    const t = trackHeights(p, [{ short: false, min: 600 }, { short: false, min: 400 }], 751)
    expect(placementHeight(p[0]!, t)).toBeGreaterThanOrEqual(599)
    expect(placementHeight(p[1]!, t)).toBeGreaterThanOrEqual(399)
  })
  it('shares the leftover between all tracks when every track is a card track (never empty canvas)', () => {
    const p = [at(0, 0, 1, 1), at(1, 0, 2, 1)]
    const t = trackHeights(p, [{ short: true, natural: 200, min: 200 }, { short: true, natural: 150, min: 150 }], 751)
    expect(t).toEqual([751])
  })
})

describe('packLayout without the page size (the agent note, tests): the structural rules', () => {
  it('leaves no empty cell for every size mix at 1, 2 and 3 columns', () => {
    const all: Size[] = ['lg', 'md', 'sm']
    for (let n = 1; n <= 6; n++) {
      for (let seed = 0; seed < 3 ** Math.min(n, 4); seed++) {
        const mix: Size[] = []
        let s = seed
        for (let i = 0; i < n; i++) {
          mix.push(all[s % 3]!)
          s = Math.floor(s / 3)
        }
        for (const columns of [1, 2, 3]) {
          const p = packLayout(sizes(...mix), columns)
          expect(p, `${columns} cols: ${mix.join(',')}`).toHaveLength(mix.length)
          expect(hasHoles(p, columns), `${columns} cols: ${mix.join(',')}`).toBe(false)
          for (const x of p) expect(x.col + x.cols, `${columns} cols: ${mix.join(',')}`).toBeLessThanOrEqual(columns)
        }
      }
    }
  })
  it('keeps a tiling set exactly as its sizes ask (3 cols: lg + sm + sm + md + sm)', () => {
    const p = packLayout(sizes('lg', 'sm', 'sm', 'md', 'sm'), 3)
    expect(cells(p)).toEqual([
      [0, 0, 2, 4],
      [2, 0, 1, 2],
      [2, 2, 1, 2],
      [0, 4, 2, 2],
      [2, 4, 1, 2],
    ])
    expect(p.every((x) => !x.stretched)).toBe(true)
  })
  it('two short widgets share the height of one chart beside the hero (round 2: a card is one track)', () => {
    const p = packLayout([hint('lg', { kind: 'chart' }), hint('sm', { kind: 'stat', items: 1 }), hint('sm', { kind: 'facts' }), hint('md', { kind: 'chart' })], 3)
    expect(hasHoles(p, 3)).toBe(false)
    expect(p[1]!.rows).toBe(1)
    expect(p[2]!.rows).toBe(1)
    expect(p[1]!.col).toBe(2)
    expect(p[2]!.col).toBe(2)
  })
  it('returns nothing for no widgets', () => {
    expect(packLayout([], 3)).toEqual([])
  })
  it('never leaves a hole over random hinted sets', () => {
    const kinds: ContentHint[] = [{ kind: 'chart', rows: 50 }, { kind: 'chart', dense: true }, { kind: 'table', rows: 3 }, { kind: 'table', rows: 20, width: 300 }, { kind: 'table', rows: 20, width: 700, minWidth: 320 }, { kind: 'stat', items: 1, fields: 6 }, { kind: 'stat', items: 7 }, { kind: 'facts', fields: 4 }, { kind: 'chain', rows: 40 }]
    const all: Size[] = ['lg', 'md', 'sm']
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let trial = 0; trial < 120; trial++) {
      const n = 1 + Math.floor(rnd() * 6)
      const widgets = Array.from({ length: n }, () => ({ size: all[Math.floor(rnd() * 3)]!, contentHint: kinds[Math.floor(rnd() * kinds.length)]! }))
      for (const [columns, opts] of [[2, {}], [3, {}], [3, AT_1440], [3, AT_1920]] as const) {
        const p = packLayout(widgets, columns, opts)
        expect(p, JSON.stringify(widgets)).toHaveLength(n)
        expect(hasHoles(p, columns), JSON.stringify(widgets)).toBe(false)
        for (const x of p) expect(x.col + x.cols).toBeLessThanOrEqual(columns)
      }
    }
  })
})

describe('packLayout with the page size (round 2: the critic\'s cases)', () => {
  const total = (t: number[]) => t.reduce((s, h) => s + h, 0) + GRID_GAP * (t.length - 1)
  it('nvda-pe: the P/E chart runs the full height, the card ends at its content and the EPS table takes the rest', () => {
    const w = [hint('lg', { kind: 'chart' }), hint('sm', { kind: 'stat', items: 1, fields: 6 }), hint('sm', { kind: 'table', rows: 12, width: 260 })]
    for (const opts of [AT_1440, AT_1920]) {
      const p = packLayout(w, 3, opts)
      const t = sized(w, p, opts)
      expect(Math.abs(total(t) - opts.height!)).toBeLessThanOrEqual(40) // the page fills: never 300px of empty canvas
      expect(placementHeight(p[0]!, t)).toBeGreaterThanOrEqual(opts.height! - 4)
      expect(placementHeight(p[1]!, t)).toBe(naturalHeight(w[1]!.contentHint, opts.columnWidth!))
      expect(p[2]!.cols).toBe(1)
    }
  })
  it('cheap-tech: the screener is the answer: it keeps two columns and runs to the bottom', () => {
    const w = [hint('lg', { kind: 'table', rows: 41, width: 700, minWidth: 280 }), hint('sm', { kind: 'facts', fields: 2 }), hint('md', { kind: 'chart', dense: true })]
    const p = packLayout(w, 3, AT_1440)
    const t = sized(w, p, AT_1440)
    expect(p[0]!.cols).toBe(2)
    expect(placementHeight(p[0]!, t)).toBeGreaterThanOrEqual(AT_1440.height! - 4)
  })
  it('mag7-corr: a narrow pairs table takes one column beside the heatmap, not the full width', () => {
    const w = [hint('lg', { kind: 'chart' }), hint('md', { kind: 'chart', dense: true }), hint('md', { kind: 'table', rows: 21, width: 220 })]
    const p = packLayout(w, 3, AT_1440)
    expect(p[2]!.cols).toBe(1)
    expect(cells(p)).toEqual([
      [0, 0, 2, 4],
      [2, 0, 1, 2],
      [2, 2, 1, 2],
    ])
  })
  it('curve: the stat sits in the column of charts beside the hero, never full width under it', () => {
    const w = [hint('lg', { kind: 'chart' }), hint('md', { kind: 'chart' }), hint('md', { kind: 'chart', dense: true }), hint('sm', { kind: 'stat', items: 1, fields: 4 })]
    for (const opts of [AT_1440, AT_1920]) {
      const p = packLayout(w, 3, opts)
      expect(p[3]!.cols).toBe(1)
      expect(p[0]!.rows).toBe(5) // the hero grows down beside two charts and the card
      const t = sized(w, p, opts)
      expect(Math.abs(total(t) - opts.height!)).toBeLessThanOrEqual(40)
    }
  })
  it('morning: the quote row is one track across two columns and the chart and news fill the page under and beside it', () => {
    const w = [hint('lg', { kind: 'stat', items: 7 }), hint('md', { kind: 'chart' }), hint('md', { kind: 'table', rows: 20, width: 760, minWidth: 330 })]
    const p = packLayout(w, 3, AT_1440)
    const t = sized(w, p, AT_1440)
    expect(p[0]).toMatchObject({ cols: 2, rows: 1 })
    expect(Math.abs(total(t) - AT_1440.height!)).toBeLessThanOrEqual(40)
    expect(placementHeight(p[1]!, t) / (p[1]!.cols * 343)).toBeLessThan(1.4) // the chart is not portrait
  })
  it('a hero beside three one-column widgets puts three across when nothing else tiles (threeAcross)', () => {
    const at = (col: number, row: number, cols: number, rows: number): Placement => ({ col, row, cols, rows, stretched: false, demoted: false })
    expect(threeAcross([at(0, 0, 1, 2), at(1, 0, 1, 2), at(2, 0, 1, 2)], 3)).toBe(true)
    expect(threeAcross([at(0, 0, 2, 2), at(2, 0, 1, 2)], 3)).toBe(false)
  })
})
