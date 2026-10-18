// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { KIND_NAMES, parseWidget, type Widget } from '@terminal/core'

const actions = vi.hoisted(() => ({
  saveWidget: vi.fn(async (_workspaceId: string, _widget: unknown): Promise<void> => {}),
  removeWidget: vi.fn(async (_workspaceId: string, _widgetId: string): Promise<void> => {}),
}))
vi.mock('../../actions', () => ({ useActions: () => actions }))

import { WidgetEditor, fieldsFor, paramDraft, paramsFrom, viewTypesFor } from '../WidgetEditor'

beforeAll(() => {
  // jsdom has no <dialog> implementation
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})
afterEach(() => {
  cleanup()
  actions.saveWidget.mockClear()
})

const input = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement
const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
const saved = async (): Promise<Widget> => {
  await waitFor(() => expect(actions.saveWidget).toHaveBeenCalledTimes(1))
  return actions.saveWidget.mock.calls[0]![1] as Widget
}

describe('fieldsFor', () => {
  it('reads every kind from its zod schema', () => {
    for (const kind of KIND_NAMES) expect(fieldsFor(kind).length).toBeGreaterThan(0)
  })
  it('maps the v1 kinds exactly as the old hand-written form did', () => {
    expect(fieldsFor('quote').map((f) => [f.name, f.input, f.required])).toEqual([['symbols', 'list', true]])
    expect(fieldsFor('search').map((f) => [f.name, f.input])).toEqual([['q', 'list']])
    expect(fieldsFor('ohlcv').map((f) => [f.name, f.input])).toEqual([
      ['symbols', 'list'],
      ['interval', 'select'],
      ['range', 'select'],
    ])
    expect(fieldsFor('news').map((f) => [f.name, f.input, f.required, f.default])).toEqual([
      ['symbols', 'list', true, undefined],
      ['limit', 'number', false, 20],
    ])
    expect(fieldsFor('earnings').map((f) => [f.name, f.input])).toEqual([
      ['symbols', 'list'],
      ['from', 'date'],
      ['to', 'date'],
    ])
  })
  it('maps the new kinds: enums to selects, enum arrays to multi, optional dates, bounded integers', () => {
    const options = fieldsFor('options')
    expect(options.map((f) => [f.name, f.input, f.required])).toEqual([
      ['symbol', 'text', true],
      ['expiration', 'date', false],
      ['strikes', 'number', false],
      ['type', 'select', false],
    ])
    const strikes = options.find((f) => f.name === 'strikes')!
    expect(strikes).toMatchObject({ input: 'number', integer: true, min: 1, max: 30, default: 10 })
    const macro = fieldsFor('macro')
    expect(macro[0]).toMatchObject({ name: 'series', input: 'multi', max: 6 })
    expect((macro[0] as { options: string[] }).options).toContain('treasury_10y')
    expect(macro[1]).toMatchObject({ name: 'range', input: 'select', default: '1y' })
    expect(fieldsFor('movers')[0]).toMatchObject({ name: 'list', input: 'select', options: ['gainers', 'losers', 'active'] })
    expect(fieldsFor('movers').find((f) => f.name === 'limit')).toMatchObject({ input: 'number', integer: true })
    expect(fieldsFor('calendar').map((f) => [f.name, f.input])).toEqual([
      ['from', 'date'],
      ['to', 'date'],
      ['country', 'text'],
    ])
  })
  it('paramDraft and paramsFrom round-trip, upper-case tickers, and drop blank optionals', () => {
    expect(paramDraft('ohlcv')).toEqual({ symbols: '', interval: '1d', range: '3mo' })
    expect(paramDraft('news', { symbols: ['MU', 'STX'], limit: 5 })).toEqual({ symbols: 'MU, STX', limit: '5' })
    expect(paramsFrom('quote', { symbols: 'mu, sndk wdc' })).toEqual({ symbols: ['MU', 'SNDK', 'WDC'] })
    expect(paramsFrom('search', { q: 'Micron, Western Digital' })).toEqual({ q: ['Micron', 'Western', 'Digital'] })
    expect(paramsFrom('options', { symbol: 'nvda', expiration: '', strikes: '10', type: 'both' })).toEqual({ symbol: 'NVDA', strikes: 10, type: 'both' })
    expect(paramsFrom('macro', { series: ['fed_funds'], range: '2y' })).toEqual({ series: ['fed_funds'], range: '2y' })
    expect(paramsFrom('yield_curve', { date: '' })).toEqual({})
  })
  it('viewTypesFor: series for ohlcv and macro, chain for options, stat for the one-row-per-symbol kinds, table for all', () => {
    expect(viewTypesFor('ohlcv')).toEqual(['series', 'table'])
    expect(viewTypesFor('macro')).toEqual(['series', 'table'])
    expect(viewTypesFor('options')).toEqual(['chain', 'table'])
    expect(viewTypesFor('quote')).toEqual(['table', 'stat'])
    expect(viewTypesFor('metrics')).toEqual(['table', 'stat'])
    expect(viewTypesFor('short_interest')).toEqual(['table', 'stat'])
    expect(viewTypesFor('calendar')).toEqual(['table'])
    expect(viewTypesFor('news')).toEqual(['table'])
  })
})

describe('WidgetEditor', () => {
  it('builds a stat widget on metrics with a column override, and edits one back to the default column', async () => {
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" />)
    fireEvent.change(input('Title'), { target: { value: 'MU forward P/E' } })
    fireEvent.change(input('Kind'), { target: { value: 'metrics' } })
    expect(Array.from((input('View') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['table', 'stat'])
    expect(screen.queryByLabelText('Column')).toBeNull()
    fireEvent.change(input('View'), { target: { value: 'stat' } })
    const column = input('Column') as HTMLSelectElement
    expect(Array.from(column.options).map((o) => o.value)).toEqual(['', 'market_cap', 'forward_pe', 'peg', 'ev_ebitda', 'ps', 'pb', 'gross_margin', 'operating_margin', 'profit_margin', 'revenue_growth', 'earnings_growth', 'roe', 'debt_to_equity', 'dividend_yield'])
    expect(column.options[0]!.textContent).toBe('pe (default)')
    fireEvent.change(column, { target: { value: 'forward_pe' } })
    fireEvent.change(input(/^symbols/), { target: { value: 'mu' } })
    submit()
    const w = await saved()
    expect(() => parseWidget(w)).not.toThrow()
    expect(w.query).toEqual({ kind: 'metrics', params: { symbols: ['MU'] } })
    expect(w.view).toEqual({ type: 'stat', column: 'forward_pe' })

    cleanup()
    actions.saveWidget.mockClear()
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" widget={w} />)
    expect((input('View') as HTMLSelectElement).value).toBe('stat')
    expect((input('Column') as HTMLSelectElement).value).toBe('forward_pe')
    fireEvent.change(input('Column'), { target: { value: '' } })
    submit()
    expect((await saved()).view).toEqual({ type: 'stat' })
  })

  it('builds a macro widget from the generated fields (checkbox series, range select) on the series view', async () => {
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" />)
    fireEvent.change(input('Title'), { target: { value: 'Rates' } })
    fireEvent.change(input('Kind'), { target: { value: 'macro' } })
    expect((input('View') as HTMLSelectElement).value).toBe('series')
    expect(Array.from((input('View') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['series', 'table'])
    expect(screen.queryByLabelText(/candle/)).toBeNull() // candle and normalize are ohlcv only
    expect((input(/^range/) as HTMLSelectElement).value).toBe('1y')
    fireEvent.click(screen.getByLabelText('treasury_10y'))
    fireEvent.click(screen.getByLabelText('fed_funds'))
    fireEvent.change(input(/^range/), { target: { value: '2y' } })
    submit()
    const w = await saved()
    expect(() => parseWidget(w)).not.toThrow()
    expect(w.query).toEqual({ kind: 'macro', params: { series: ['treasury_10y', 'fed_funds'], range: '2y' } })
    expect(w.view).toEqual({ type: 'series' })
    expect(w.title).toBe('Rates')
  })

  it('builds an options widget on the chain view, leaving the optional expiration blank', async () => {
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" />)
    fireEvent.change(input('Title'), { target: { value: 'NVDA chain' } })
    fireEvent.change(input('Kind'), { target: { value: 'options' } })
    expect((input('View') as HTMLSelectElement).value).toBe('chain')
    expect((input(/^strikes/) as HTMLInputElement).value).toBe('10')
    expect((input(/^strikes/) as HTMLInputElement).max).toBe('30')
    expect((input(/^type/) as HTMLSelectElement).value).toBe('both')
    fireEvent.change(input(/^symbol/), { target: { value: 'nvda' } })
    fireEvent.change(input(/^strikes/), { target: { value: '5' } })
    submit()
    const w = await saved()
    expect(() => parseWidget(w)).not.toThrow()
    expect(w.query).toEqual({ kind: 'options', params: { symbol: 'NVDA', strikes: 5, type: 'both' } })
    expect(w.view).toEqual({ type: 'chain' })
    expect(w.size).toBe('md')
  })

  it('shows validation errors instead of saving when a required field is blank', async () => {
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" />)
    fireEvent.change(input('Title'), { target: { value: 'Empty' } })
    fireEvent.change(input('Kind'), { target: { value: 'holdings' } })
    submit()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/symbol/)
    expect(actions.saveWidget).not.toHaveBeenCalled()
  })

  it('edits an existing ohlcv widget with the v1 fields and the candle/normalize toggles', async () => {
    const widget = parseWidget({
      id: 'w1',
      title: 'MU daily',
      size: 'md',
      query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } },
      view: { type: 'series', candle: true },
    })
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" widget={widget} />)
    expect((input(/^symbols/) as HTMLInputElement).value).toBe('MU')
    expect((input(/^interval/) as HTMLSelectElement).value).toBe('1d')
    expect((input(/^range/) as HTMLSelectElement).value).toBe('6mo')
    expect((screen.getByLabelText(/candle/) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText(/candle/))
    fireEvent.click(screen.getByLabelText(/normalize/))
    fireEvent.change(input(/^symbols/), { target: { value: 'mu, sndk' } })
    fireEvent.change(input(/^range/), { target: { value: '2y' } })
    submit()
    const w = await saved()
    expect(w.id).toBe('w1')
    expect(w.query).toEqual({ kind: 'ohlcv', params: { symbols: ['MU', 'SNDK'], interval: '1d', range: '2y' } })
    expect(w.view).toEqual({ type: 'series', normalize: true })
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('switching kind picks its natural view and offers only the views it supports', () => {
    render(<WidgetEditor open onClose={() => {}} workspaceId="ws1" />)
    expect((input('View') as HTMLSelectElement).value).toBe('table')
    fireEvent.change(input('Kind'), { target: { value: 'ohlcv' } })
    expect((input('View') as HTMLSelectElement).value).toBe('series')
    expect(screen.getByLabelText(/candle/)).toBeTruthy()
    fireEvent.change(input('View'), { target: { value: 'table' } })
    expect(screen.queryByLabelText(/candle/)).toBeNull()
    fireEvent.change(input('Kind'), { target: { value: 'macro' } })
    expect((input('View') as HTMLSelectElement).value).toBe('series')
    fireEvent.change(input('Kind'), { target: { value: 'options' } })
    expect((input('View') as HTMLSelectElement).value).toBe('chain')
    fireEvent.change(input('Kind'), { target: { value: 'insiders' } })
    expect((input('View') as HTMLSelectElement).value).toBe('table')
    expect(Array.from((input('View') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['table'])
  })
})
