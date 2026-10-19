// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type Frame, type WidgetV2 } from '@openterminal/core'

import { denseStat } from '@openterminal/core'
import { StatView, balancedRows, cardsPerRow, columnLabel, detailRows, orderStats, statRows, symbolOrder } from '../StatView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'

afterEach(cleanup)

/** A frame with the given columns and the stat field config (the key column, its change column, formats). */
function frame(columns: [string, 'string' | 'number' | 'time'][], rows: unknown[][], fields: Frame['meta']['fields'] = {}): Frame {
  return { columns: columns.map(([name, type]) => ({ name, type })), rows, meta: { connector: 'fixture', fetchedAt: 0, ttl: 60_000, fields } }
}
const QUOTE: [string, 'string' | 'number'][] = [['symbol', 'string'], ['price', 'number'], ['change_pct', 'number'], ['volume', 'number'], ['market_state', 'string'], ['extended_price', 'number'], ['extended_change_pct', 'number']]
const quoteFields = { price: { unit: 'usd' as const, format: 'price' as const, key: true }, change_pct: { unit: 'percent' as const, format: 'change' as const }, extended_price: { unit: 'usd' as const, format: 'price' as const }, extended_change_pct: { unit: 'percent' as const, format: 'change' as const } }
const quote = (rows: unknown[][]) => frame(QUOTE, rows, quoteFields)
const widget = (recipe: string, params: Record<string, unknown>, view: WidgetV2['view'] = { preset: 'stat' }): WidgetV2 => ({ id: 'w', title: 'x', size: 'sm', data: { main: { recipe, params } }, view })

const value = (symbol?: string) => (symbol ? document.querySelector(`[data-symbol="${symbol}"] [data-field="value"]`) : document.querySelector('[data-field="value"]'))

describe('column labels', () => {
  it('labels the common columns for people and falls back to the name with spaces', () => {
    expect(columnLabel('target_consensus')).toBe('Consensus target')
    expect(columnLabel('days_to_cover')).toBe('Days to cover')
    expect(columnLabel('iv30')).toBe('IV30')
    expect(columnLabel('something_else')).toBe('Something else')
  })
})

describe('statRows', () => {
  it('quote: the price, the signed day change, and the extended-hours line outside the regular session', () => {
    const control = { change: 'change_pct', format: 'price' as const, formats: { change_pct: 'change' as const, price: 'price' as const } }
    const rows = statRows(quote([['NVDA', 177.8, -3.48, 1, 'POST', 178.42, 0.35]]), 'price', control)
    expect(rows).toEqual([
      {
        symbol: 'NVDA',
        value: 177.8,
        text: '177.80',
        secondary: { text: '-3.48%', dir: 'down' },
        extended: { state: 'after hours', price: '178.42', change: '+0.35%', dir: 'up' },
      },
    ])
    const regular = statRows(quote([['MU', 199.6, 3.29, 1, 'REGULAR', 200, 0.1]]), 'price', control)[0]!
    expect(regular.secondary).toEqual({ text: '+3.29%', dir: 'up' })
    expect(regular.extended).toBeNull()
  })

  it('takes the first row per symbol (short interest reports arrive newest first) and formats by the control', () => {
    const f = frame(
      [['symbol', 'string'], ['date', 'string'], ['short_interest', 'number'], ['change_pct', 'number'], ['avg_volume', 'number'], ['days_to_cover', 'number']],
      [
        ['MU', '2026-09-30', 30_000_000, 4.2, 20_000_000, 1.5],
        ['MU', '2026-09-15', 28_000_000, -1.1, 20_000_000, 1.4],
        ['WDC', '2026-09-30', 10_000_000, -2.0, 5_000_000, 2.0],
      ],
    )
    const rows = statRows(f, 'days_to_cover', { change: 'change_pct', format: 'ratio', formats: { change_pct: 'change' } })
    expect(rows.map((r) => [r.symbol, r.text, r.secondary?.text, r.secondary?.dir])).toEqual([
      ['MU', '1.50', '+4.20%', 'up'],
      ['WDC', '2.00', '-2.00%', 'down'],
    ])
    const profile = frame([['symbol', 'string'], ['name', 'string'], ['sector', 'string'], ['market_cap', 'number']], [['NVDA', 'NVIDIA', 'Technology', 4_400_000_000_000]])
    expect(statRows(profile, 'market_cap', { change: 'sector', format: 'compact', formats: { sector: 'text' } })[0]).toMatchObject({ text: '4.40T', secondary: { text: 'Technology', dir: null } })
    const vol = frame([['symbol', 'string'], ['iv30', 'number'], ['iv_rank', 'number']], [['NVDA', 44.8, 33.5]])
    expect(statRows(vol, 'iv30', { change: 'iv_rank', format: 'percent', formats: { iv_rank: 'integer' } })[0]).toMatchObject({ text: '44.80%', secondary: { text: '34' } })
  })

  it('skips the secondary line when it is the column on display, and shows a dash for a null value', () => {
    const f = frame([['symbol', 'string'], ['pe', 'number'], ['forward_pe', 'number']], [['RDDT', null, 16.13]])
    expect(statRows(f, 'pe', { change: 'forward_pe', format: 'ratio', formats: { forward_pe: 'price' } })[0]).toMatchObject({ value: null, text: '—', secondary: { text: '16.13' } })
    expect(statRows(f, 'forward_pe', { change: 'forward_pe', format: 'ratio', formats: { forward_pe: 'price' } })[0]).toMatchObject({ value: 16.13, text: '16.13', secondary: null })
  })
})

describe('StatView', () => {
  it('is the view for the stat preset', () => {
    expect(viewFor({ preset: 'stat' })).toBe(StatView)
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
    expect(screen.getByText('Fwd P/E')).toBeTruthy()
  })

  it('ticks the number once when a refreshed frame changes it, with the direction', async () => {
    const w = widget('quote', { symbols: ['NVDA'] })
    const at = (price: number) => quote([['NVDA', price, 1, 1, 'REGULAR', null, null]])
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
    render(<StatView widget={widget('quote', { symbols: ['NVDA'] })} frames={{ main: quote([]) }} />)
    expect(document.querySelector('[data-view="stat"]')).toBeNull()
    expect(screen.getByText('No data')).toBeTruthy()
  })
})

describe('StatView, the taste round (change 2)', () => {
  it('orders the cards by the symbols the widget asked for, not the frame order', () => {
    const w = widget('quote', { symbols: ['NVDA', 'AMD', 'MU'] })
    const f = quote([
      ['MU', 199.6, 3.29, 1, 'REGULAR', null, null],
      ['AMD', 250, -1, 1, 'REGULAR', null, null],
      ['NVDA', 177.8, -3.48, 1, 'REGULAR', null, null],
      ['SPY', 760, 0.1, 1, 'REGULAR', null, null],
    ])
    render(<StatView widget={w} frames={{ main: f }} />)
    expect(Array.from(document.querySelectorAll('[data-symbol]')).map((el) => el.getAttribute('data-symbol'))).toEqual(['NVDA', 'AMD', 'MU', 'SPY'])
    expect(orderStats([{ symbol: 'B' } as never, { symbol: 'A' } as never], ['a', 'b']).map((s) => s.symbol)).toEqual(['A', 'B'])
    expect(symbolOrder(w)).toEqual(['NVDA', 'AMD', 'MU'])
  })
  it('renders several symbols as compact cards and one symbol as a capped hero with its details in a grid', () => {
    const { widget: many, frame: f } = fixture('stat-quotes')
    render(<StatView widget={many} frames={{ main: f }} />)
    expect(document.querySelectorAll('.stat-card')).toHaveLength(4)
    expect(document.querySelector('.stat-cards')).toBeTruthy()
    cleanup()
    const { widget: one, frame: q } = fixture('stat-quote')
    render(<StatView widget={one} frames={{ main: q }} />)
    expect(value()!.className).toContain('stat-hero')
    expect(document.querySelector('[data-details]')).toBeTruthy()
    expect(document.querySelector('.stat-card')).toBeNull()
  })
})

describe('denseStat (round 2: the width alone picks cards or the one-line-per-symbol list)', () => {
  it('lists more than four symbols in a column that holds two cards across, and keeps cards otherwise', () => {
    expect(denseStat(4, 340)).toBe(false)
    expect(denseStat(5, 340)).toBe(true)
    expect(denseStat(7, 690)).toBe(false) // the morning watchlist across two columns: four and three cards
    expect(denseStat(7, 1000)).toBe(false)
  })
})

describe('balancedRows (change 2: no orphaned card)', () => {
  it('splits cards into rows of near-equal length, longer rows first', () => {
    const rows = (n: number, perRow: number) => balancedRows(Array.from({ length: n }, (_, i) => i), perRow).map((r) => r.length)
    expect(rows(7, 6)).toEqual([4, 3]) // the morning watchlist at 1920: was six and one
    expect(rows(7, 3)).toEqual([3, 2, 2]) // the Mag 7 at 1920: was three, three and one
    expect(rows(4, 3)).toEqual([2, 2]) // four neoclouds: was three and one
    expect(rows(4, 4)).toEqual([4])
    expect(rows(3, 2)).toEqual([2, 1])
    expect(rows(0, 3)).toEqual([])
    expect(cardsPerRow(994)).toBe(6)
    expect(cardsPerRow(100)).toBe(1)
  })
})

describe('detailRows (companions in the headline unit)', () => {
  const names = ['symbol', 'prev_close', 'open', 'high', 'low', 'volume', 'year_high', 'year_low', 'iv30', 'iv30_annual_high', 'iv30_annual_low', 'hv30_annual_high', 'hv30_annual_low']
  const vol = {
    columns: names.map((name) => ({ name, type: name === 'symbol' ? ('string' as const) : ('number' as const) })),
    rows: [['TSLA', 354.72, 357.63, 369.47, 354.47, 24585212, 498.83, 297.38, 45.48, 60.73, 37.18, 69.8, 31.0]],
    meta: { connector: 'openbb', fetchedAt: 0 },
  } as unknown as Frame
  it('puts the IV and HV ranges under IV30, never the stock price slots (the volatility card showed prev close and the day range)', () => {
    expect(detailRows(vol, 'iv30', undefined, {}, 6, 'percent').map((d) => d.label)).toEqual(['IV30 high', 'IV30 low', 'HV30 high', 'HV30 low'])
    // nor the stock's bid and ask, annotated dollar fields of the same snapshot
    const withBid = { ...vol, columns: [...vol.columns, { name: 'bid', type: 'number' as const }], rows: [[...vol.rows[0]!, 367.61]] } as Frame
    expect(detailRows(withBid, 'iv30', undefined, { bid: { label: 'Bid', unit: 'usd', format: 'price' } }, 6, 'percent').map((d) => d.label)).not.toContain('Bid')
  })
  it('keeps the quote slots under a price, in slot order', () => {
    expect(detailRows(vol, 'prev_close', undefined, { prev_close: { unit: 'usd' } }, 6, 'price').map((d) => d.label)).toEqual(['Open', 'Day high', 'Day low', 'Volume', '52w high', '52w low'])
  })
  it('drops the price slots and dollar fields under a reading that is not a price (RSI showed "Open 551.97")', () => {
    const rsi = { ...vol, columns: [...vol.columns, { name: 'rsi', type: 'number' as const }], rows: [[...vol.rows[0]!, 41.2]] } as Frame
    expect(detailRows(rsi, 'rsi', undefined, {}, 6, 'price')).toEqual([])
    expect(detailRows(rsi, 'rsi', undefined, { open: { label: 'Open', unit: 'usd' }, high: { label: 'High', format: 'price' }, volume: { label: 'Volume', unit: 'shares' } }, 6, 'price')).toEqual([])
  })
  it("keeps a transform's own dollar columns under a percent (the implied move's straddle and strike)", () => {
    const move = {
      columns: ['symbol', 'implied_move', 'atm_strike', 'underlying', 'straddle'].map((name) => ({ name, type: name === 'symbol' ? ('string' as const) : ('number' as const) })),
      rows: [['TSLA', 6.65, 367.5, 367.41, 24.45]],
      meta: { connector: 'transform', fetchedAt: 0 },
    } as unknown as Frame
    const fields = { implied_move: { unit: 'percent' }, atm_strike: { label: 'ATM strike', unit: 'usd' }, underlying: { label: 'Underlying', unit: 'usd' }, straddle: { label: 'ATM straddle', unit: 'usd' } }
    expect(detailRows(move, 'implied_move', undefined, fields, 6, 'percent').map((d) => d.label)).toEqual(['ATM strike', 'Underlying', 'ATM straddle'])
  })
})

