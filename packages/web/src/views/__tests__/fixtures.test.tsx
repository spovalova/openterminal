// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WidgetV2Schema, isWidgetV2, preview } from '@openterminal/core'

vi.mock('lightweight-charts', async () => {
  const { makeChartsMock } = await import('./mocks')
  return makeChartsMock().module
})
vi.mock('@openterminal/ui', async () => {
  const { makeUiMock } = await import('./mocks')
  return makeUiMock()
})

import { FIXTURES, RECIPE_FIXTURES } from '../fixtures'
import { V2_FIXTURES } from '../fixtures/v2'
import { ViewsGallery } from '../preview'
import { recipeOf, viewOf } from '../fields'
import { contentHintFor } from '../content-hint'

afterEach(cleanup)

describe('fixtures', () => {
  it('cover every widget row of PLAN.md section 5', () => {
    const ids = FIXTURES.map((f) => f.id)
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4']) expect(ids).toContain(id)
  })

  it('cover the chain, macro on compare (one dataset per series), and the tables', () => {
    const ids = FIXTURES.map((f) => f.id)
    for (const id of ['options', 'macro', 'financials', 'insiders', 'calendar', 'movers', 'volatility']) expect(ids).toContain(id)
    const options = RECIPE_FIXTURES.find((f) => f.id === 'options')!
    expect(options.widget.view.preset).toBe('chain')
    expect(new Set(options.frame.rows.map((r) => r[3])).size).toBe(20) // 10 strikes each side
    expect(new Set(options.frame.rows.map((r) => r[1])).size).toBe(1) // one expiration
    const macro = FIXTURES.find((f) => f.id === 'macro')!
    expect(macro.widget.view.preset).toBe('compare')
    expect(Object.keys(macro.frames)).toEqual(['treasury_10y', 'treasury_2y', 'fed_funds'])
    for (const [series, frame] of Object.entries(macro.frames)) expect(Object.keys(preview(frame).stats)).toEqual([series])
  })

  it('cover every v2 preset (PLAN.md section 17), as valid v2 widgets with one frame per dataset', () => {
    const presets = new Set(V2_FIXTURES.map((f) => f.widget.view.preset))
    for (const p of ['price', 'compare', 'curve', 'indicator', 'table', 'facts', 'stat', 'heatmap']) expect(presets.has(p as never), p).toBe(true)
    for (const f of V2_FIXTURES) {
      expect(WidgetV2Schema.safeParse(f.widget).success, f.id).toBe(true)
      expect(isWidgetV2(f.widget)).toBe(true)
      expect(Object.keys(f.frames).sort()).toEqual(Object.keys(f.widget.data).sort())
      for (const frame of Object.values(f.frames)) {
        expect(frame.rows.length).toBeGreaterThan(0)
        expect(frame.meta.fields).toBeDefined()
        for (const row of frame.rows) {
          expect(row).toHaveLength(frame.columns.length)
          frame.columns.forEach((c, i) => {
            const v = row[i]
            if (v == null) return
            expect(typeof v, `${f.id}.${c.name}`).toBe(c.type === 'time' ? 'number' : c.type)
          })
        }
      }
    }
    expect(FIXTURES.every((f) => f.frames.main === f.frame || Object.values(f.frames).includes(f.frame))).toBe(true)
  })

  for (const f of RECIPE_FIXTURES) {
    it(`${f.id}: a valid recipe widget whose frame carries field config and typed cells`, () => {
      expect(WidgetV2Schema.safeParse(f.widget).success).toBe(true)
      const recipe = recipeOf(f.widget)!
      expect(recipe).toBeTruthy()
      expect(f.frame.meta.lineage).toEqual({ recipe })
      expect(Object.keys(f.frame.meta.fields ?? {}).length).toBeGreaterThan(0)
      expect(f.frame.rows.length).toBeGreaterThan(0)
      for (const row of f.frame.rows) {
        expect(row).toHaveLength(f.frame.columns.length)
        f.frame.columns.forEach((c, i) => {
          const v = row[i]
          if (v == null) return
          expect(typeof v).toBe(c.type === 'time' ? 'number' : c.type)
        })
      }
      if (recipe === 'ohlcv') {
        // sorted by symbol then time, as the frame contract promises
        const symbols = (f.widget.data.main as unknown as { params: { symbols: string[] } }).params.symbols
        const keys = f.frame.rows.map((r) => [r[0] as string, r[1] as number] as const)
        const sorted = [...keys].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
        const bySymbolOrder = [...new Set(keys.map((k) => k[0]))]
        const sortedWithFirstSeen = [...keys].sort((a, b) => bySymbolOrder.indexOf(a[0]) - bySymbolOrder.indexOf(b[0]) || a[1] - b[1])
        expect(keys).toEqual(sortedWithFirstSeen)
        expect(sorted.length).toBe(keys.length)
        expect(symbols).toEqual(bySymbolOrder)
        expect(Object.keys(preview(f.frame).stats)).toEqual(symbols)
      }
    })
  }
})

describe('content hints', () => {
  it('report the view kind and the row count; a one-row table is a facts card; charts are charts before the frame lands', () => {
    const a1 = FIXTURES.find((f) => f.id === 'A1')!
    expect(contentHintFor(a1.widget, a1.frames)).toEqual({ kind: 'chart', rows: a1.frame.rows.length })
    expect(contentHintFor(a1.widget, {})).toEqual({ kind: 'chart' })
    const c2 = FIXTURES.find((f) => f.id === 'C2')!
    expect(contentHintFor(c2.widget, c2.frames)).toEqual({ kind: 'facts', rows: 1 })
    const a3 = FIXTURES.find((f) => f.id === 'A3')!
    expect(contentHintFor(a3.widget, a3.frames)).toEqual({ kind: 'table', rows: 4, columns: a3.frame.columns.length }) // the column count keeps a wide compare table two grid columns wide
    expect(contentHintFor(FIXTURES.find((f) => f.id === 'stat-quote')!.widget, {})).toEqual({ kind: 'stat' })
    expect(contentHintFor(FIXTURES.find((f) => f.id === 'options')!.widget, {})).toEqual({ kind: 'chain' })
    expect(contentHintFor(FIXTURES.find((f) => f.id === 'v2-heatmap')!.widget, {})).toEqual({ kind: 'chart' })
    expect(contentHintFor(FIXTURES.find((f) => f.id === 'v2-facts')!.widget, {})).toEqual({ kind: 'facts' })
  })
})

describe('ViewsGallery', () => {
  it('renders every fixture through viewFor', () => {
    const { container } = render(<ViewsGallery />)
    const cards = container.querySelectorAll('[data-fixture]')
    expect(cards).toHaveLength(FIXTURES.length)
    const presetOf = (id: string) => viewOf(FIXTURES.find((f) => f.id === id)!.widget).preset
    const charts = FIXTURES.filter((f) => ['price', 'compare', 'curve', 'indicator'].includes(presetOf(f.id)))
    expect(container.querySelectorAll('[data-view="chart"]')).toHaveLength(charts.length)
    // a table over one row renders the facts card (product rule 8): C2 and v2-table-one-row
    const tables = FIXTURES.filter((f) => presetOf(f.id) === 'table' && f.frame.rows.length > 1)
    expect(container.querySelectorAll('[data-view="table"]')).toHaveLength(tables.length)
    expect(container.querySelectorAll('[data-view="facts"]')).toHaveLength(FIXTURES.filter((f) => presetOf(f.id) === 'facts' || (presetOf(f.id) === 'table' && f.frame.rows.length === 1)).length)
    expect(container.querySelectorAll('[data-view="chain"]')).toHaveLength(FIXTURES.filter((f) => presetOf(f.id) === 'chain').length)
    expect(container.querySelectorAll('[data-view="heatmap"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-view="stat"]').length).toBeGreaterThan(4)
    expect(container.querySelectorAll('[data-view="chain"]').length).toBeGreaterThan(0)
  })
})
