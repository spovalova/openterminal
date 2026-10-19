// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KINDS, type Frame, type Kind } from '@terminal/core'

vi.mock('@terminal/ui', async () => {
  const { makeUiMock } = await import('./mocks')
  return makeUiMock()
})

import { TableView, defaultSortFor, extremesFor, formatsFor, projectFrame, sortRows } from '../TableView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'
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

describe('TableView formats (v1 kinds through legacy field config)', () => {
  const expected: Partial<Record<Kind, Record<string, string>>> = {
    quote: { symbol: 'text', price: 'price', change_pct: 'change', volume: 'integer', market_state: 'text', extended_price: 'price', extended_change_pct: 'change' },
    news: { time: 'time', headline: 'text', source: 'text', url: 'link', symbol: 'text' },
    earnings: { symbol: 'text', date: 'date', session: 'text', eps_estimate: 'price' },
    search: { query: 'text', symbol: 'text', name: 'text', exchange: 'text' },
    ohlcv: { symbol: 'text', time: 'time', open: 'price', high: 'price', low: 'price', close: 'price', volume: 'integer' },
    financials: {
      symbol: 'text',
      period_ending: 'date',
      revenue: 'compact',
      gross_profit: 'compact',
      operating_income: 'compact',
      net_income: 'compact',
      eps: 'price',
      operating_cash_flow: 'compact',
      capex: 'compact',
      free_cash_flow: 'compact',
      cash: 'compact',
      debt: 'compact',
      shares: 'compact',
    },
    movers: { symbol: 'text', name: 'text', price: 'price', change_pct: 'change', volume: 'integer' },
    volatility: { symbol: 'text', iv30: 'percent', iv30_high: 'percent', iv30_low: 'percent', iv_rank: 'price', hv30: 'percent', hv30_high: 'percent', hv30_low: 'percent', year_high: 'price', year_low: 'price' },
    insiders: { symbol: 'text', date: 'date', name: 'text', title: 'text', action: 'text', shares: 'compact', price: 'price', value: 'compact', url: 'link' },
  }
  const sample: Partial<Record<Kind, string>> = { quote: 'A3', news: 'A5', earnings: 'A4', search: 'search', ohlcv: 'C4', financials: 'financials', movers: 'movers', volatility: 'volatility', insiders: 'insiders' }

  for (const kind of Object.keys(expected) as Kind[]) {
    it(`maps every ${kind} column to a CellFormat`, () => {
      expect(formatsFor(kind, KINDS[kind].columns)).toEqual(expected[kind])
      const { widget, frame } = fixture(sample[kind]!)
      render(<TableView widget={widget} frames={one(frame)} />)
      expect(renderedFormats()).toEqual(expected[kind])
      // hides nothing: every frame column is shown (in priority order now, so compare as sets)
      expect(Object.keys(renderedFormats()).sort()).toEqual(frame.columns.map((c) => c.name).sort())
    })
  }

  it('orders columns by the kind\'s priority (the table control), the first three always shown', () => {
    const { widget, frame } = fixture('A5') // news
    render(<TableView widget={widget} frames={one(frame)} />)
    expect(renderedColumns()).toEqual(['headline', 'time', 'source', 'symbol', 'url'])
    const control = controlOf(widget, one(frame))
    expect(control?.kind).toBe('table')
    if (control?.kind === 'table') expect(control.columns).toEqual(['headline', 'time', 'source', 'symbol', 'url'])
  })
})

describe('TableView formats for every kind', () => {
  it('uses change only for signed moves, percent for levels, compact for amounts, integer for volumes', () => {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      const f = formatsFor(kind, KINDS[kind].columns)
      for (const [name, fmt] of Object.entries(f)) {
        if (/^(change_pct|extended_change_pct|upside_pct|surprise_pct|eps_growth_y|revenue_growth|earnings_growth)$/.test(name)) expect(fmt, `${kind}.${name}`).toBe('change')
        else expect(fmt, `${kind}.${name}`).not.toBe('change')
        if (/volume$/.test(name)) expect(fmt, `${kind}.${name}`).toBe('integer')
        if (kind !== 'macro' && /^(market_cap|revenue|net_income|value|offer_amount|shares)$/.test(name)) expect(fmt, `${kind}.${name}`).toBe('compact')
        if (/margin$|_yield$|^iv$|^weight$|^rate$/.test(name)) expect(fmt, `${kind}.${name}`).toBe('percent')
      }
    }
  })
})

describe('TableView default sort', () => {
  it('news sorts by time descending', () => {
    expect(defaultSortFor('news')).toEqual({ column: 'time', dir: 'desc' })
    const { widget, frame } = fixture('C3')
    render(<TableView widget={widget} frames={one(frame)} />)
    expect(renderedSort()).toEqual({ column: 'time', dir: 'desc' })
    const times = renderedRows().map((r) => r.time as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('earnings sorts by date ascending', () => {
    expect(defaultSortFor('earnings')).toEqual({ column: 'date', dir: 'asc' })
    const { widget, frame } = fixture('A4')
    render(<TableView widget={widget} frames={one(frame)} />)
    expect(renderedRows().map((r) => r.symbol)).toEqual(['STX', 'WDC', 'SNDK', 'MU'])
  })

  it('quote sorts by symbol', () => {
    expect(defaultSortFor('quote')).toEqual({ column: 'symbol', dir: 'asc' })
    const { widget, frame } = fixture('B3')
    render(<TableView widget={widget} frames={one(frame)} />)
    expect(renderedRows().map((r) => r.symbol)).toEqual(['AMD', 'AVGO', 'NVDA', 'SMH', 'SPY', 'TSM'])
  })

  it('ohlcv sorts by time descending; search keeps connector order', () => {
    expect(defaultSortFor('ohlcv')).toEqual({ column: 'time', dir: 'desc' })
    expect(defaultSortFor('search')).toBeUndefined()
    const { widget, frame } = fixture('C4')
    render(<TableView widget={widget} frames={one(frame)} />)
    const times = renderedRows().map((r) => r.time as number)
    expect(times[0]).toBe(Math.max(...times))
    cleanup()
    const s = fixture('search')
    render(<TableView widget={s.widget} frames={one(s.frame)} />)
    expect(renderedSort()).toBeNull()
    expect(renderedRows().map((r) => r.symbol)).toEqual(s.frame.rows.map((r) => r[1]))
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

  it('viewFor picks TableView for table views and table presets', () => {
    expect(viewFor({ type: 'table' })).toBe(TableView)
    expect(viewFor({ preset: 'table' })).toBe(TableView)
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
    const c2 = fixture('C2') // v1 earnings with one row: the same rule
    render(<TableView widget={c2.widget} frames={one(c2.frame)} />)
    expect(document.querySelector('[data-view="facts"]')).toBeTruthy()
    expect(document.querySelector('[data-fact="symbol"] [data-field="value"]')!.textContent).toBe('TSLA')
  })
})
