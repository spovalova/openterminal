// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KINDS, STAT_KEY_COLUMN, STAT_KINDS, numericColumns, parseWidget, statColumn, type Frame, type Kind, type WidgetInput } from '@terminal/core'

import { StatView, columnLabel, statRows } from '../StatView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'

afterEach(cleanup)

function frame(kind: Kind, rows: unknown[][]): Frame {
  return { columns: KINDS[kind].columns, rows, meta: { connector: 'fixture', fetchedAt: 0, ttl: 60_000 } }
}
const widget = (kind: Kind, params: Record<string, unknown>, view: WidgetInput['view'] = { type: 'stat' }) =>
  parseWidget({ id: 'w', title: 'x', size: 'sm', query: { kind, params } as WidgetInput['query'], view })

const value = (symbol?: string) => (symbol ? document.querySelector(`[data-symbol="${symbol}"] [data-field="value"]`) : document.querySelector('[data-field="value"]'))

describe('the key-column table', () => {
  it('names a numeric column of each stat kind, and only those kinds take a stat view', () => {
    expect(STAT_KEY_COLUMN).toEqual({ quote: 'price', metrics: 'pe', volatility: 'iv30', estimates: 'target_consensus', profile: 'market_cap', short_interest: 'days_to_cover' })
    for (const [kind, column] of Object.entries(STAT_KEY_COLUMN) as [Kind, string][]) {
      expect(STAT_KINDS.has(kind)).toBe(true)
      expect(numericColumns(kind), kind).toContain(column)
      expect(KINDS[kind].columns[0]!.name, kind).toBe('symbol')
    }
    expect(STAT_KINDS.has('ohlcv')).toBe(false)
    expect(STAT_KINDS.has('news')).toBe(false)
  })

  it('statColumn is the view column when set, else the key column', () => {
    expect(statColumn('quote', { type: 'stat' })).toBe('price')
    expect(statColumn('metrics', { type: 'stat', column: 'forward_pe' })).toBe('forward_pe')
    expect(statColumn('news', { type: 'table' })).toBeUndefined()
  })

  it('labels the key columns for people', () => {
    expect(columnLabel('target_consensus')).toBe('consensus target')
    expect(columnLabel('days_to_cover')).toBe('days to cover')
    expect(columnLabel('iv30')).toBe('IV30')
    expect(columnLabel('something_else')).toBe('something else')
  })
})

describe('statRows', () => {
  it('quote: the price, the signed day change, and the extended-hours line outside the regular session', () => {
    const rows = statRows(frame('quote', [['NVDA', 177.8, -3.48, 1, 'POST', 178.42, 0.35]]), 'quote', 'price')
    expect(rows).toEqual([
      {
        symbol: 'NVDA',
        value: 177.8,
        text: '177.80',
        secondary: { text: '-3.48%', dir: 'down' },
        extended: { state: 'after hours', price: '178.42', change: '+0.35%', dir: 'up' },
      },
    ])
    const regular = statRows(frame('quote', [['MU', 199.6, 3.29, 1, 'REGULAR', 200, 0.1]]), 'quote', 'price')[0]!
    expect(regular.secondary).toEqual({ text: '+3.29%', dir: 'up' })
    expect(regular.extended).toBeNull()
  })

  it('takes the first row per symbol (the newest report for short_interest) and formats by the kind', () => {
    const f = frame('short_interest', [
      ['MU', '2026-09-30', 30_000_000, 4.2, 20_000_000, 1.5],
      ['MU', '2026-09-15', 28_000_000, -1.1, 20_000_000, 1.4],
      ['WDC', '2026-09-30', 10_000_000, -2.0, 5_000_000, 2.0],
    ])
    const rows = statRows(f, 'short_interest', 'days_to_cover')
    expect(rows.map((r) => [r.symbol, r.text, r.secondary?.text, r.secondary?.dir])).toEqual([
      ['MU', '1.50', '+4.20%', 'up'],
      ['WDC', '2.00', '-2.00%', 'down'],
    ])
    expect(statRows(frame('profile', [['NVDA', 'NVIDIA', 'NASDAQ', 'Technology', 'Semis', 4_400_000_000_000, 1, 1, 'd']]), 'profile', 'market_cap')[0]).toMatchObject({ text: '4.40T', secondary: { text: 'Technology', dir: null } })
    expect(statRows(frame('volatility', [['NVDA', 44.8, 71.2, 31.5, 33.5, null, 1, 1, 1, 1]]), 'volatility', 'iv30')[0]).toMatchObject({ text: '44.80%', secondary: { text: '33.50', label: 'IV rank' } })
  })

  it('skips the secondary line when it is the column on display, and shows a dash for a null value', () => {
    const f = frame('metrics', [['RDDT', 1, null, 16.13, 0.78, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, null]])
    expect(statRows(f, 'metrics', 'pe')[0]).toMatchObject({ value: null, text: '—', secondary: { text: '16.13', label: 'forward' } })
    expect(statRows(f, 'metrics', 'forward_pe')[0]).toMatchObject({ value: 16.13, text: '16.13', secondary: null })
  })
})

describe('StatView', () => {
  it('is the view for { type: "stat" }', () => {
    expect(viewFor({ type: 'stat' })).toBe(StatView)
  })

  it('renders one symbol as a hero number with the symbol as its label and the change under it', () => {
    const { widget: w, frame: f } = fixture('stat-quote')
    render(<StatView widget={w} frames={{ main: f }} />)
    const root = document.querySelector('[data-view="stat"]')!
    expect(root.getAttribute('data-count')).toBe('1')
    expect(root.getAttribute('data-column')).toBe('price')
    expect(screen.getByText('NVDA')).toBeTruthy()
    expect(value()!.textContent).toBe('177.80')
    expect(value()!.className).toContain('stat-hero')
    const secondary = document.querySelector('[data-field="secondary"]')!
    expect(secondary.textContent).toBe('-3.48%')
    expect(secondary.className).toContain('text-down')
    expect(document.querySelector('[data-field="extended"]')!.textContent).toContain('after hours 178.42 +0.35%')
  })

  it('renders several symbols as a row of cards, in frame order', () => {
    const { widget: w, frame: f } = fixture('stat-quotes')
    render(<StatView widget={w} frames={{ main: f }} />)
    expect(document.querySelector('[data-view="stat"]')!.getAttribute('data-count')).toBe('4')
    expect(Array.from(document.querySelectorAll('[data-symbol]')).map((el) => el.getAttribute('data-symbol'))).toEqual(['MU', 'SNDK', 'WDC', 'STX'])
    expect(value('WDC')!.textContent).toBe('112.30')
    expect(document.querySelector('[data-symbol="WDC"] [data-field="secondary"]')!.className).toContain('text-down')
    expect(document.querySelector('[data-field="extended"]')).toBeNull()
  })

  it('honours the view column', () => {
    const { widget: w, frame: f } = fixture('stat-metrics')
    render(<StatView widget={w} frames={{ main: f }} />)
    expect(document.querySelector('[data-view="stat"]')!.getAttribute('data-column')).toBe('forward_pe')
    expect(value()!.textContent).toBe('16.13')
    expect(screen.getByText('forward P/E')).toBeTruthy()
  })

  it('ticks the number once when a refreshed frame changes it, with the direction', async () => {
    const w = widget('quote', { symbols: ['NVDA'] })
    const at = (price: number) => frame('quote', [['NVDA', price, 1, 1, 'REGULAR', null, null]])
    const { rerender } = render(<StatView widget={w} frames={{ main: at(100) }} />)
    expect(value()!.getAttribute('data-tick')).toBeNull()
    await act(async () => rerender(<StatView widget={w} frames={{ main: at(101) }} />))
    expect(value()!.textContent).toBe('101.00')
    expect(value()!.getAttribute('data-tick')).toBe('up')
    // the same value again: nothing new to highlight
    await act(async () => rerender(<StatView widget={w} frames={{ main: at(101) }} />))
    expect(value()!.getAttribute('data-tick')).toBe('up')
    await act(async () => rerender(<StatView widget={w} frames={{ main: at(99.5) }} />))
    expect(value()!.getAttribute('data-tick')).toBe('down')
  })

  it('shows the empty state when the frame has no rows', () => {
    render(<StatView widget={widget('quote', { symbols: ['NVDA'] })} frames={{ main: frame('quote', []) }} />)
    expect(document.querySelector('[data-view="stat"]')).toBeNull()
    expect(screen.getByText('No data')).toBeTruthy()
  })
})
