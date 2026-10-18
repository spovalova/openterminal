// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KINDS, WidgetSchema, preview } from '@terminal/core'

vi.mock('lightweight-charts', async () => {
  const { makeChartsMock } = await import('./mocks')
  return makeChartsMock().module
})
vi.mock('@terminal/ui', async () => {
  const { makeUiMock } = await import('./mocks')
  return makeUiMock()
})

import { FIXTURES } from '../fixtures'
import { ViewsGallery } from '../preview'

afterEach(cleanup)

describe('fixtures', () => {
  it('cover every widget row of PLAN.md section 5', () => {
    const ids = FIXTURES.map((f) => f.id)
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4']) expect(ids).toContain(id)
  })

  it('cover the v1.2 views: a chain, macro on series, and the new tables', () => {
    const ids = FIXTURES.map((f) => f.id)
    for (const id of ['options', 'macro', 'financials', 'insiders', 'calendar', 'movers', 'volatility']) expect(ids).toContain(id)
    const options = FIXTURES.find((f) => f.id === 'options')!
    expect(options.widget.view.type).toBe('chain')
    expect(new Set(options.frame.rows.map((r) => r[3])).size).toBe(20) // 10 strikes each side
    expect(new Set(options.frame.rows.map((r) => r[1])).size).toBe(1) // one expiration
    const macro = FIXTURES.find((f) => f.id === 'macro')!
    expect(macro.widget.view.type).toBe('series')
    expect(Object.keys(preview(macro.frame).stats)).toEqual(['treasury_10y', 'treasury_2y', 'fed_funds'])
  })

  for (const f of FIXTURES) {
    it(`${f.id}: widget is valid and the frame matches the ${f.widget.query.kind} columns`, () => {
      expect(WidgetSchema.safeParse(f.widget).success).toBe(true)
      expect(f.frame.columns).toEqual(KINDS[f.widget.query.kind].columns)
      expect(f.frame.rows.length).toBeGreaterThan(0)
      for (const row of f.frame.rows) {
        expect(row).toHaveLength(f.frame.columns.length)
        f.frame.columns.forEach((c, i) => {
          const v = row[i]
          if (v == null) return
          expect(typeof v).toBe(c.type === 'time' ? 'number' : c.type)
        })
      }
      if (f.widget.query.kind === 'ohlcv') {
        // sorted by symbol then time, as the frame contract promises
        const keys = f.frame.rows.map((r) => [r[0] as string, r[1] as number] as const)
        const sorted = [...keys].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
        const bySymbolOrder = [...new Set(keys.map((k) => k[0]))]
        const sortedWithFirstSeen = [...keys].sort((a, b) => bySymbolOrder.indexOf(a[0]) - bySymbolOrder.indexOf(b[0]) || a[1] - b[1])
        expect(keys).toEqual(sortedWithFirstSeen)
        expect(sorted.length).toBe(keys.length)
        expect(f.widget.query.params.symbols).toEqual(bySymbolOrder)
        expect(Object.keys(preview(f.frame).stats)).toEqual(f.widget.query.params.symbols)
      }
    })
  }
})

describe('ViewsGallery', () => {
  it('renders every fixture through viewFor', () => {
    const { container } = render(<ViewsGallery />)
    const cards = container.querySelectorAll('[data-fixture]')
    expect(cards).toHaveLength(FIXTURES.length)
    expect(container.querySelectorAll('[data-view="series"]')).toHaveLength(FIXTURES.filter((f) => f.widget.view.type === 'series').length)
    expect(container.querySelectorAll('[data-view="table"]')).toHaveLength(FIXTURES.filter((f) => f.widget.view.type === 'table').length)
    expect(container.querySelectorAll('[data-view="chain"]')).toHaveLength(FIXTURES.filter((f) => f.widget.view.type === 'chain').length)
    expect(container.querySelectorAll('[data-view="chain"]').length).toBeGreaterThan(0)
  })
})
