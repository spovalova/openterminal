// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KINDS, type Kind } from '@terminal/core'

vi.mock('@terminal/ui', async () => {
  const { makeUiMock } = await import('./mocks')
  return makeUiMock()
})

import { TableView, defaultSortFor, formatsFor, sortRows } from '../TableView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'

afterEach(cleanup)

function renderedFormats(): Record<string, string> {
  return JSON.parse(screen.getByTestId('data-table').getAttribute('data-formats')!)
}
function renderedSort(): { column: string; dir: string } | null {
  return JSON.parse(screen.getByTestId('data-table').getAttribute('data-sort')!)
}
function renderedRows(): unknown[][] {
  return Array.from(screen.getByTestId('data-table').querySelectorAll('tbody tr')).map((tr) => JSON.parse(tr.getAttribute('data-row')!))
}

describe('TableView formats', () => {
  const expected: Record<Kind, Record<string, string>> = {
    quote: { symbol: 'text', price: 'price', change_pct: 'percent', volume: 'integer', market_state: 'text', extended_price: 'price', extended_change_pct: 'percent' },
    news: { time: 'time', headline: 'text', source: 'text', url: 'link', symbol: 'text' },
    earnings: { symbol: 'text', date: 'date', session: 'text', eps_estimate: 'price' },
    search: { query: 'text', symbol: 'text', name: 'text', exchange: 'text' },
    ohlcv: { symbol: 'text', time: 'time', open: 'price', high: 'price', low: 'price', close: 'price', volume: 'integer' },
  }
  const sample: Record<Kind, string> = { quote: 'A3', news: 'A5', earnings: 'A4', search: 'search', ohlcv: 'C4' }

  for (const kind of Object.keys(expected) as Kind[]) {
    it(`maps every ${kind} column to a CellFormat`, () => {
      expect(formatsFor(kind, KINDS[kind].columns)).toEqual(expected[kind])
      const { widget, frame } = fixture(sample[kind])
      render(<TableView widget={widget} frame={frame} />)
      expect(renderedFormats()).toEqual(expected[kind])
      expect(Object.keys(renderedFormats())).toEqual(frame.columns.map((c) => c.name)) // hides nothing
    })
  }
})

describe('TableView default sort', () => {
  it('news sorts by time descending', () => {
    expect(defaultSortFor('news')).toEqual({ column: 'time', dir: 'desc' })
    const { widget, frame } = fixture('C3')
    render(<TableView widget={widget} frame={frame} />)
    expect(renderedSort()).toEqual({ column: 'time', dir: 'desc' })
    const times = renderedRows().map((r) => r[0] as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('earnings sorts by date ascending', () => {
    expect(defaultSortFor('earnings')).toEqual({ column: 'date', dir: 'asc' })
    const { widget, frame } = fixture('A4')
    render(<TableView widget={widget} frame={frame} />)
    expect(renderedRows().map((r) => r[0])).toEqual(['STX', 'WDC', 'SNDK', 'MU'])
  })

  it('quote sorts by symbol', () => {
    expect(defaultSortFor('quote')).toEqual({ column: 'symbol', dir: 'asc' })
    const { widget, frame } = fixture('B3')
    render(<TableView widget={widget} frame={frame} />)
    expect(renderedRows().map((r) => r[0])).toEqual(['AMD', 'AVGO', 'NVDA', 'SMH', 'SPY', 'TSM'])
  })

  it('ohlcv sorts by time descending; search keeps connector order', () => {
    expect(defaultSortFor('ohlcv')).toEqual({ column: 'time', dir: 'desc' })
    expect(defaultSortFor('search')).toBeUndefined()
    const { widget, frame } = fixture('C4')
    render(<TableView widget={widget} frame={frame} />)
    const times = renderedRows().map((r) => r[1] as number)
    expect(times[0]).toBe(Math.max(...times))
    cleanup()
    const s = fixture('search')
    render(<TableView widget={s.widget} frame={s.frame} />)
    expect(renderedSort()).toBeNull()
    expect(renderedRows()).toEqual(s.frame.rows)
  })

  it('sinks nulls to the bottom in both directions and keeps the sort stable', () => {
    const { frame } = fixture('A4')
    const asc = sortRows(frame, { column: 'session', dir: 'asc' }).map((r) => r[0])
    const desc = sortRows(frame, { column: 'session', dir: 'desc' }).map((r) => r[0])
    expect(asc).toEqual(['MU', 'SNDK', 'WDC', 'STX'])
    expect(desc).toEqual(['MU', 'SNDK', 'WDC', 'STX'])
    expect(sortRows(frame, undefined)).toBe(frame.rows)
  })
})

describe('TableView column sort', () => {
  it('clicking a header sorts by it (numbers newest/largest first) and clicking again flips', () => {
    const { widget, frame } = fixture('B3')
    render(<TableView widget={widget} frame={frame} />)
    fireEvent.click(screen.getByRole('button', { name: 'change_pct' }))
    expect(renderedSort()).toEqual({ column: 'change_pct', dir: 'desc' })
    expect(renderedRows().map((r) => r[0])).toEqual(['SPY', 'AVGO', 'TSM', 'AMD', 'SMH', 'NVDA'])
    fireEvent.click(screen.getByRole('button', { name: 'change_pct' }))
    expect(renderedSort()).toEqual({ column: 'change_pct', dir: 'asc' })
    expect(renderedRows().map((r) => r[0])[0]).toBe('NVDA')
    fireEvent.click(screen.getByRole('button', { name: 'symbol' }))
    expect(renderedSort()).toEqual({ column: 'symbol', dir: 'asc' })
  })

  it('renders EmptyState for an empty frame', () => {
    const { widget, frame } = fixture('A5')
    render(<TableView widget={widget} frame={{ ...frame, rows: [] }} />)
    expect(screen.getByTestId('empty-state').textContent).toContain('No rows')
    expect(screen.queryByTestId('data-table')).toBeNull()
  })

  it('viewFor picks TableView for table views', () => {
    expect(viewFor({ type: 'table' })).toBe(TableView)
  })
})
