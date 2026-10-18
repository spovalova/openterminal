// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Frame, Widget } from '@terminal/core'

import { ChainView, buildChain, inTheMoney, sideColumns } from '../ChainView'
import { TableView } from '../TableView'
import { SeriesView } from '../SeriesView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'

afterEach(cleanup)

const strikeOf = (tr: Element) => Number(tr.getAttribute('data-strike'))
const bodyRows = () => Array.from(document.querySelectorAll('[data-view="chain"] tbody tr'))
const headerLabels = () => Array.from(document.querySelectorAll('[data-view="chain"] thead tr:last-child th')).map((th) => th.textContent)

describe('buildChain', () => {
  it('pivots the options frame into one row per strike, ascending, with the ATM row nearest the underlying', () => {
    const { frame } = fixture('options')
    const chain = buildChain(frame)
    expect(chain.symbol).toBe('NVDA')
    expect(chain.expiration).toBe('2026-10-23')
    expect(chain.dte).toBe(7)
    expect(chain.underlying).toBe(182.43)
    expect(chain.rows).toHaveLength(20)
    expect(chain.rows.map((r) => r.strike)).toEqual([...chain.rows.map((r) => r.strike)].sort((a, b) => a - b))
    expect(chain.rows.every((r) => r.call && r.put)).toBe(true)
    expect(chain.rows[chain.atmIndex]!.strike).toBe(182.5)
    expect(chain.hasCalls && chain.hasPuts).toBe(true)
  })

  it('classifies calls ITM below the price and puts ITM above it', () => {
    expect(inTheMoney('call', 180, 182.43)).toBe(true)
    expect(inTheMoney('call', 185, 182.43)).toBe(false)
    expect(inTheMoney('put', 185, 182.43)).toBe(true)
    expect(inTheMoney('put', 180, 182.43)).toBe(false)
    expect(inTheMoney('put', 185, null)).toBe(false)
  })

  it('sm drops volume and delta', () => {
    expect(sideColumns('lg').map((c) => c.key)).toEqual(['bid', 'ask', 'last', 'volume', 'open_interest', 'iv', 'delta'])
    expect(sideColumns('md').map((c) => c.key)).toEqual(['bid', 'ask', 'last', 'volume', 'open_interest', 'iv', 'delta'])
    expect(sideColumns('sm').map((c) => c.key)).toEqual(['bid', 'ask', 'last', 'open_interest', 'iv'])
  })
})

describe('ChainView', () => {
  it('renders one row per strike with calls left, strike centre, puts right, and the header line', () => {
    const { widget, frame } = fixture('options')
    render(<ChainView widget={widget} frame={frame} />)
    const rows = bodyRows()
    expect(rows).toHaveLength(20)
    expect(rows.map(strikeOf)).toEqual([...rows.map(strikeOf)].sort((a, b) => a - b))
    // mirrored columns: calls read delta … bid toward the strike, puts bid … delta away from it
    expect(headerLabels()).toEqual(['Delta', 'IV', 'OI', 'Vol', 'Last', 'Ask', 'Bid', 'Bid', 'Ask', 'Last', 'Vol', 'OI', 'IV', 'Delta'])
    const first = rows[0]!
    const cells = Array.from(first.querySelectorAll('td'))
    expect(cells).toHaveLength(15)
    expect(cells.slice(0, 7).every((td) => td.getAttribute('data-side') === 'call')).toBe(true)
    expect(cells[7]!.getAttribute('data-field')).toBe('strike')
    expect(cells.slice(8).every((td) => td.getAttribute('data-side') === 'put')).toBe(true)
    const header = document.querySelector('[data-chain-header]')!
    expect(header.textContent).toContain('NVDA')
    expect(within(header as HTMLElement).getByText('Oct 23, 2026')).toBeTruthy()
    expect(within(header as HTMLElement).getByText('7 DTE')).toBeTruthy()
    expect(header.querySelector('[data-field="underlying"]')!.textContent).toContain('182.43')
  })

  it('shades ITM cells (calls below the price, puts above) and marks the row nearest the price', () => {
    const { widget, frame } = fixture('options')
    render(<ChainView widget={widget} frame={frame} />)
    for (const tr of bodyRows()) {
      const strike = strikeOf(tr)
      const calls = Array.from(tr.querySelectorAll('td[data-side="call"]'))
      const puts = Array.from(tr.querySelectorAll('td[data-side="put"]'))
      expect(calls.every((td) => td.hasAttribute('data-itm') === strike < 182.43)).toBe(true)
      expect(puts.every((td) => td.hasAttribute('data-itm') === strike > 182.43)).toBe(true)
      expect(calls.every((td) => td.classList.contains('bg-fg/8') === strike < 182.43)).toBe(true)
    }
    const atm = document.querySelectorAll('[data-view="chain"] tbody tr[data-atm]')
    expect(atm).toHaveLength(1)
    expect(strikeOf(atm[0]!)).toBe(182.5)
    expect(atm[0]!.querySelector('[data-field="strike"]')!.classList.contains('text-accent')).toBe(true)
  })

  it('formats cells: prices with two decimals, OI as integers, IV with one decimal and a percent sign', () => {
    const { widget, frame } = fixture('options')
    render(<ChainView widget={widget} frame={frame} />)
    const atm = document.querySelector('[data-view="chain"] tbody tr[data-atm]')!
    const put = buildChain(frame).rows.find((r) => r.strike === 182.5)!.put!
    const puts = Array.from(atm.querySelectorAll('td[data-side="put"]')).map((td) => td.textContent)
    expect(puts[0]).toBe(put.bid!.toFixed(2))
    expect(puts[4]).toBe(put.open_interest!.toLocaleString('en-US'))
    expect(puts[5]).toBe(`${put.iv!.toFixed(1)}%`)
    expect(puts[6]).toBe(put.delta!.toFixed(2))
  })

  it('sm size drops volume and delta on both sides', () => {
    const { widget, frame } = fixture('options')
    render(<ChainView widget={{ ...widget, size: 'sm' }} frame={frame} />)
    expect(headerLabels()).toEqual(['IV', 'OI', 'Last', 'Ask', 'Bid', 'Bid', 'Ask', 'Last', 'OI', 'IV'])
    expect(bodyRows()[0]!.querySelectorAll('td')).toHaveLength(11)
    expect(document.querySelector('[data-view="chain"]')!.getAttribute('data-size')).toBe('sm')
  })

  it('hides a side that has no contracts (type: call)', () => {
    const { widget, frame } = fixture('options')
    const calls: Frame = { ...frame, rows: frame.rows.filter((r) => r[2] === 'call') }
    const w: Widget = { ...widget, query: { kind: 'options', params: { ...widget.query.params, type: 'call' } } } as Widget
    render(<ChainView widget={w} frame={calls} />)
    expect(screen.queryByText('Puts')).toBeNull()
    expect(screen.getByText('Calls')).toBeTruthy()
    expect(bodyRows()).toHaveLength(20)
    expect(bodyRows()[0]!.querySelectorAll('td')).toHaveLength(8)
  })

  it('renders an empty state for a frame with no rows', () => {
    const { widget, frame } = fixture('options')
    render(<ChainView widget={widget} frame={{ ...frame, rows: [] }} />)
    expect(screen.getByText('No contracts')).toBeTruthy()
    expect(document.querySelector('[data-view="chain"]')).toBeNull()
  })

  it('viewFor picks ChainView for chain views and keeps the others', () => {
    expect(viewFor({ type: 'chain' })).toBe(ChainView)
    expect(viewFor({ type: 'table' })).toBe(TableView)
    expect(viewFor({ type: 'series' })).toBe(SeriesView)
  })
})
