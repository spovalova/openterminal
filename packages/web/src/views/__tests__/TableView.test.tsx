// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '@terminal/core'

vi.mock('@terminal/ui', async () => {
  const { makeUiMock } = await import('./mocks')
  return makeUiMock()
})

import { TableView, extremesFor, projectFrame, sortRows } from '../TableView'
import { viewFor } from '../view-for'
import { RECIPE_FIXTURES, fixture } from '../fixtures'
import { controlOf } from '../fields'

afterEach(cleanup)

const one = (frame: Frame) => ({ main: frame })

function renderedFormats(): Record<string, string> {
  return JSON.parse(screen.getByTestId('data-table').getAttribute('data-formats')!)
}
function renderedSort(): { column: string; dir: string } | null {
  return JSON.parse(screen.getByTestId('data-table').getAttribute('data-sort')!)
}
/** Rendered column names, in display order (the table control orders them by priority). */
function renderedColumns(): string[] {
  return Array.from(screen.getByTestId('data-table').querySelectorAll('thead th button')).map((b) => b.textContent ?? '')
}
/** Rendered rows as objects keyed by column name, so assertions do not depend on the display order. */
function renderedRows(): Record<string, unknown>[] {
  const cols = renderedColumns()
  return Array.from(screen.getByTestId('data-table').querySelectorAll('tbody tr')).map((tr) => {
    const row = JSON.parse(tr.getAttribute('data-row')!) as unknown[]
    return Object.fromEntries(cols.map((c, i) => [c, row[i]]))
  })
}

describe('TableView formats from the frame’s field config', () => {
  const tableFixtures = RECIPE_FIXTURES.filter((f) => f.widget.view.preset === 'table' && f.frame.rows.length > 3)
  for (const f of tableFixtures) {
    it(`${f.id}: every column renders with the format its annotation implies`, () => {
      render(<TableView widget={f.widget} frames={one(f.frame)} />)
      const formats = renderedFormats()
      // every frame column is shown (in priority order, so compare as sets)
      expect(Object.keys(formats).sort()).toEqual(f.frame.columns.map((c) => c.name).sort())
      for (const [name, fmt] of Object.entries(formats)) {
        const column = f.frame.columns.find((c) => c.name === name)!
        if (/^(change_pct|extended_change_pct|upside_pct|surprise_pct|eps_growth_y|revenue_growth|earnings_growth)$/.test(name)) expect(fmt, `${f.id}.${name}`).toBe('change')
        else expect(fmt, `${f.id}.${name}`).not.toBe('change')
        if (/volume$|^(market_cap|revenue|net_income|value|offer_amount|shares)$/.test(name)) expect(fmt, `${f.id}.${name}`).toBe('compact')
        if (/margin$|_yield$|^iv$|^iv30|^hv30|^weight$|^rate$/.test(name)) expect(fmt, `${f.id}.${name}`).toBe('percent')
        if (/^(price|close|open|high|low|strike|bid|ask|eps_estimate|eps)$/.test(name)) expect(fmt, `${f.id}.${name}`).toBe('price')
        if (name === 'url') expect(fmt).toBe('link')
        if (column.type === 'time') expect(fmt, `${f.id}.${name}`).toBe('time')
        if (column.type === 'string' && name !== 'url') expect(fmt, `${f.id}.${name}`).toBe('text')
      }
    })
  }

  it('orders columns by the field config priority (the table control), the first three always shown', () => {
    const { widget, frame } = fixture('A5') // news
    render(<TableView widget={widget} frames={one(frame)} />)
    expect(renderedColumns()).toEqual(['headline', 'time', 'source', 'symbol', 'url'])
    const control = controlOf(widget, one(frame))
    expect(control?.kind).toBe('table')
    if (control?.kind === 'table') expect(control.columns).toEqual(['headline', 'time', 'source', 'symbol', 'url'])
  })
})

describe('TableView default sort', () => {
  it('the view’s sort applies (the news recipe sorts newest first); a view without one keeps the frame order', () => {
    const { widget, frame } = fixture('C3')
    const sorted = { ...widget, view: { preset: 'table' as const, sort: { column: 'time', dir: 'desc' as const } } }
    render(<TableView widget={sorted} frames={one(frame)} />)
    expect(renderedSort()).toEqual({ column: 'time', dir: 'desc' })
    const times = renderedRows().map((r) => r.time as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    cleanup()
    const s = fixture('search')
    render(<TableView widget={s.widget} frames={one(s.frame)} />)
    expect(renderedSort()).toBeNull()
    expect(renderedRows().map((r) => r.symbol)).toEqual(s.frame.rows.map((r) => r[1]))
  })

  it('an ascending sort on a date column and a symbol sort', () => {
    const a4 = fixture('A4')
    render(<TableView widget={{ ...a4.widget, view: { preset: 'table', sort: { column: 'date', dir: 'asc' } } }} frames={one(a4.frame)} />)
    expect(renderedRows().map((r) => r.symbol)).toEqual(['STX', 'WDC', 'SNDK', 'MU'])
    cleanup()
    const b3 = fixture('B3')
    render(<TableView widget={{ ...b3.widget, view: { preset: 'table', sort: { column: 'symbol', dir: 'asc' } } }} frames={one(b3.frame)} />)
    expect(renderedRows().map((r) => r.symbol)).toEqual(['AMD', 'AVGO', 'NVDA', 'SMH', 'SPY', 'TSM'])
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
    render(<TableView widget={widget} frames={one(frame)} />)
    fireEvent.click(screen.getByRole('button', { name: 'change_pct' }))
    expect(renderedSort()).toEqual({ column: 'change_pct', dir: 'desc' })
    expect(renderedRows().map((r) => r.symbol)).toEqual(['SPY', 'AVGO', 'TSM', 'AMD', 'SMH', 'NVDA'])
    fireEvent.click(screen.getByRole('button', { name: 'change_pct' }))
    expect(renderedSort()).toEqual({ column: 'change_pct', dir: 'asc' })
    expect(renderedRows().map((r) => r.symbol)[0]).toBe('NVDA')
    fireEvent.click(screen.getByRole('button', { name: 'symbol' }))
    expect(renderedSort()).toEqual({ column: 'symbol', dir: 'asc' })
  })

  it('renders EmptyState for an empty frame', () => {
    const { widget, frame } = fixture('A5')
    render(<TableView widget={widget} frames={one({ ...frame, rows: [] })} />)
    expect(screen.getByTestId('empty-state').textContent).toContain('No rows')
    expect(screen.queryByTestId('data-table')).toBeNull()
  })

  it('viewFor picks TableView for table presets', () => {
    expect(viewFor({ preset: 'table' })).toBe(TableView)
    expect(viewFor(fixture('A3').widget)).toBe(TableView)
  })
})

describe('TableView from the table control (v2)', () => {
  it('a compare table: columns by priority with labels, the control\'s sort, the highlighted row, best and worst per column', () => {
    const { widget, frames } = fixture('v2-table-compare')
    render(<TableView widget={widget} frames={frames} />)
    expect(renderedColumns()).toEqual(['symbol', 'pe', 'forward_pe', 'revenue_growth', 'gross_margin', 'fcf_margin', 'debt_to_equity', 'market_cap'])
    expect(renderedSort()).toEqual({ column: 'pe', dir: 'asc' })
    expect(renderedRows().map((r) => r.symbol)).toEqual(['IREN', 'NVDA', 'CRWV', 'NBIS', 'APLD']) // nulls last
    expect(renderedFormats()).toMatchObject({ pe: 'price', revenue_growth: 'change', gross_margin: 'percent', market_cap: 'compact' })
    const table = screen.getByTestId('data-table')
    expect(table.getAttribute('data-labels')).toContain('"pe":"P/E"')
    expect(table.getAttribute('data-highlight')).toBe('NVDA')
    const marks = JSON.parse(table.getAttribute('data-marks')!) as Record<string, Record<string, string>>
    expect(marks.NVDA).toMatchObject({ pe: 'worst', fcf_margin: 'best', market_cap: 'best' }) // a lower P/E is better
    expect(marks.IREN).toMatchObject({ pe: 'best', gross_margin: 'best' })
    expect(marks.NBIS).toMatchObject({ revenue_growth: 'best', fcf_margin: 'worst', debt_to_equity: 'best' }) // lower leverage is better
    expect(marks.CRWV).toMatchObject({ debt_to_equity: 'worst' })
  })

  it('extremesFor swaps best and worst where lower is better, skips text and single-valued columns', () => {
    const frame = fixture('v2-table-compare').frame
    const projected = projectFrame(frame, ['symbol', 'pe', 'gross_margin'])
    const ex = extremesFor(projected, ['symbol', 'pe', 'gross_margin'], { symbol: 'text', pe: 'price', gross_margin: 'percent' })
    const row = (s: string) => projected.rows.find((r) => r[0] === s)!
    expect(ex.get(row('IREN'))).toEqual({ pe: 'best', gross_margin: 'best' })
    expect(ex.get(row('NVDA'))).toEqual({ pe: 'worst' })
    expect(ex.get(row('APLD'))).toEqual({ gross_margin: 'worst' })
    expect(extremesFor({ ...projected, rows: projected.rows.slice(0, 1) }, ['pe'], { pe: 'price' }).size).toBe(0)
  })

  it('a table over one row renders the facts card (product rule 8)', () => {
    const { widget, frames } = fixture('v2-table-one-row')
    render(<TableView widget={widget} frames={frames} />)
    expect(screen.queryByTestId('data-table')).toBeNull()
    const card = document.querySelector('[data-view="facts"]')!
    expect(card).toBeTruthy()
    expect(card.getAttribute('data-count')).toBe('12')
    cleanup()
    const c2 = fixture('C2') // earnings with one row: the same rule
    render(<TableView widget={c2.widget} frames={one(c2.frame)} />)
    expect(document.querySelector('[data-view="facts"]')).toBeTruthy()
    expect(document.querySelector('[data-fact="symbol"] [data-field="value"]')!.textContent).toBe('TSLA')
  })
})
