// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preview, type Frame } from '@terminal/core'
import { DOWN, UP } from './mocks'

const charts = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./mocks')['makeChartsMock']> }))
vi.mock('lightweight-charts', async () => {
  const { makeChartsMock } = await import('./mocks')
  charts.current = makeChartsMock()
  return charts.current.module
})
vi.mock('@terminal/ui', async () => {
  const { makeUiMock } = await import('./mocks')
  return makeUiMock()
})

import { SeriesView, legendText } from '../SeriesView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'
import { formatPercent, formatPrice } from '../format'
import { toCandleData, toLineData, groupBars, legendRows, seriesColumns } from '../series-data'

function mock() {
  return charts.current!
}

beforeEach(() => {
  mock().charts.length = 0
  mock().createChart.mockClear()
  mock().fitContent.mockClear()
})
afterEach(cleanup)

describe('SeriesView legend', () => {
  it('shows last close and change over the range exactly as preview() computes them (A1)', () => {
    const { widget, frame } = fixture('A1')
    render(<SeriesView widget={widget} frame={frame} />)
    const stats = preview(frame).stats
    const legend = screen.getByRole('list', { name: 'Series legend' })
    const items = within(legend).getAllByRole('listitem')
    expect(items.map((el) => el.getAttribute('data-symbol'))).toEqual(['MU', 'SNDK', 'WDC', 'STX'])
    for (const item of items) {
      const symbol = item.getAttribute('data-symbol')!
      const close = stats[symbol]!.close!
      expect(item.querySelector('[data-field="last"]')!.textContent).toBe(formatPrice(close.last))
      expect(item.querySelector('[data-field="change"]')!.textContent).toBe(formatPercent(close.changePct))
      // sanity: the legend is derived from the same first/last the agent sees
      const closes = frame.rows.filter((r) => r[0] === symbol).map((r) => r[5] as number)
      expect(close.first).toBe(closes[0])
      expect(close.last).toBe(closes[closes.length - 1])
    }
  })

  it('colours the change by direction', () => {
    const { widget, frame } = fixture('B1') // every symbol is down on the day
    render(<SeriesView widget={widget} frame={frame} />)
    const changes = screen.getAllByText(/%$/)
    expect(changes.length).toBe(3)
    for (const el of changes) expect((el as HTMLElement).style.color).toBe(hexToRgb(DOWN))
    cleanup()
    render(<SeriesView widget={fixture('A1').widget} frame={fixture('A1').frame} />)
    for (const el of screen.getAllByText(/%$/)) expect((el as HTMLElement).style.color).toBe(hexToRgb(UP))
  })
})

describe('SeriesView modes', () => {
  it('default view: one line per symbol in palette order on a normal price scale (C4)', () => {
    const { widget, frame } = fixture('C4')
    render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    expect(chart).toBeDefined()
    expect((chart!.options as { rightPriceScale: { mode: number } }).rightPriceScale.mode).toBe(0)
    expect(chart!.series.map((s) => (s.definition as { type: string }).type)).toEqual(['Line', 'Line'])
    expect(chart!.series.map((s) => (s.options as { color: string }).color)).toEqual(['#4c8dff', '#ff9f43'])
    const grouped = groupBars(frame, false)
    expect(chart!.series[0]!.stub.setData).toHaveBeenCalledWith(toLineData(grouped[0]!.bars))
    expect(chart!.series[1]!.stub.setData).toHaveBeenCalledWith(toLineData(grouped[1]!.bars))
    expect(mock().fitContent).toHaveBeenCalled()
  })

  it('normalize: lines on the IndexedTo100 price scale (A1)', () => {
    const { widget, frame } = fixture('A1')
    render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    expect((chart!.options as { rightPriceScale: { mode: number } }).rightPriceScale.mode).toBe(3)
    expect(chart!.series).toHaveLength(4)
    expect(chart!.series.every((s) => (s.definition as { type: string }).type === 'Line')).toBe(true)
    expect(document.querySelector('[data-view="series"]')!.getAttribute('data-mode')).toBe('normalize')
  })

  it('candle: one candlestick series with up/down colours plus a volume histogram on its own scale (A2)', () => {
    const { widget, frame } = fixture('A2')
    render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    expect(chart!.series.map((s) => (s.definition as { type: string }).type)).toEqual(['Candlestick', 'Histogram'])
    const candleOpts = chart!.series[0]!.options as { upColor: string; downColor: string }
    expect(candleOpts.upColor).toBe(UP)
    expect(candleOpts.downColor).toBe(DOWN)
    const volOpts = chart!.series[1]!.options as { priceScaleId: string; priceFormat: { type: string } }
    expect(volOpts.priceScaleId).toBe('volume')
    expect(volOpts.priceFormat.type).toBe('volume')
    const bars = groupBars(frame, false)[0]!.bars
    expect(chart!.series[0]!.stub.setData).toHaveBeenCalledWith(toCandleData(bars))
    const volData = chart!.series[1]!.stub.setData.mock.calls[0]![0] as { value: number; color: string }[]
    expect(volData.map((d) => d.value)).toEqual(bars.map((b) => b.volume))
    expect(new Set(volData.map((d) => d.color)).size).toBeGreaterThan(1) // coloured by bar direction
    expect((chart!.options as { rightPriceScale: { scaleMargins: { bottom: number } } }).rightPriceScale.scaleMargins.bottom).toBeGreaterThan(0.2)
  })
})

describe('SeriesView time handling', () => {
  it('daily bars use business days and the time scale hides the clock (A1)', () => {
    const { widget, frame } = fixture('A1')
    render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    const opts = chart!.options as { timeScale: { timeVisible: boolean; secondsVisible: boolean } }
    expect(opts.timeScale.timeVisible).toBe(false)
    expect(opts.timeScale.secondsVisible).toBe(false)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: unknown }[]
    expect(data[0]!.time).toEqual({ year: 2026, month: 10, day: 6 })
    // every symbol shares the same x positions
    const times = chart!.series.map((s) => JSON.stringify((s.stub.setData.mock.calls[0]![0] as { time: unknown }[]).map((d) => d.time)))
    expect(new Set(times).size).toBe(1)
  })

  it('intraday bars use epoch seconds and show the clock (B1)', () => {
    const { widget, frame } = fixture('B1')
    render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    const opts = chart!.options as { timeScale: { timeVisible: boolean; secondsVisible: boolean } }
    expect(opts.timeScale.timeVisible).toBe(true)
    expect(opts.timeScale.secondsVisible).toBe(false)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: number }[]
    expect(data[0]!.time).toBe(Date.UTC(2026, 9, 16, 13, 30) / 1000)
    expect(data.every((d) => Number.isInteger(d.time))).toBe(true)
  })

  it('drops bars with a null close, keeps the last of duplicate times, sorts ascending', () => {
    const base = fixture('C4').frame
    const t = (i: number) => base.rows[i]![1] as number
    const frame: Frame = {
      ...base,
      rows: [
        ['SPY', t(2), 1, 1, 1, 3, 10],
        ['SPY', t(0), 1, 1, 1, 1, 10],
        ['SPY', t(1), 1, 1, 1, null, 10],
        ['SPY', t(0), 1, 1, 1, 2, 10],
      ],
    }
    const [spy] = groupBars(frame, false)
    expect(spy!.bars.map((b) => b.close)).toEqual([2, 3])
  })
})

describe('SeriesView lifecycle', () => {
  it('disposes the chart on unmount and replaces series on data change', () => {
    const { widget, frame } = fixture('C4')
    const { rerender, unmount } = render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    expect(chart!.series).toHaveLength(2)
    const next: Frame = { ...frame, rows: frame.rows.filter((r) => r[0] === 'SPY') }
    rerender(<SeriesView widget={widget} frame={next} />)
    expect(mock().createChart).toHaveBeenCalledTimes(1)
    expect(chart!.chart.removeSeries).toHaveBeenCalledTimes(2)
    expect(chart!.series).toHaveLength(3) // two from the first load, one from the second
    expect(mock().fitContent).toHaveBeenCalledTimes(2)
    unmount()
    expect(chart!.chart.remove).toHaveBeenCalledTimes(1)
  })

  it('renders EmptyState for an empty frame and creates no chart', () => {
    const { widget, frame } = fixture('A1')
    render(<SeriesView widget={widget} frame={{ ...frame, rows: [] }} />)
    expect(screen.getByTestId('empty-state')).toBeTruthy()
    expect(mock().createChart).not.toHaveBeenCalled()
  })

  it('viewFor picks SeriesView for series views', () => {
    expect(viewFor({ type: 'series' })).toBe(SeriesView)
    expect(viewFor({ type: 'series', candle: true })).toBe(SeriesView)
  })
})

describe('SeriesView over macro frames', () => {
  it('groups by series and plots value, one line per series in palette order, on business days', () => {
    const { widget, frame } = fixture('macro')
    expect(seriesColumns(frame)).toEqual({ group: 'series', value: 'value' })
    const grouped = groupBars(frame, false)
    expect(grouped.map((g) => g.group)).toEqual(['treasury_10y', 'treasury_2y', 'fed_funds'])
    expect(grouped.every((g) => g.bars.length === 52)).toBe(true)
    expect(grouped[0]!.bars[0]!.close).toBe(frame.rows[0]![2])
    render(<SeriesView widget={widget} frame={frame} />)
    const [chart] = mock().charts
    expect(chart!.series.map((s) => (s.definition as { type: string }).type)).toEqual(['Line', 'Line', 'Line'])
    expect(chart!.series.map((s) => (s.options as { color: string }).color)).toEqual(['#4c8dff', '#ff9f43', '#2ecc71'])
    expect((chart!.options as { rightPriceScale: { mode: number } }).rightPriceScale.mode).toBe(0)
    expect((chart!.options as { timeScale: { timeVisible: boolean } }).timeScale.timeVisible).toBe(false)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: unknown; value: number }[]
    expect(data[0]!.time).toEqual({ year: 2025, month: 10, day: 24 })
    expect(data.map((d) => d.value)).toEqual(grouped[0]!.bars.map((b) => b.close))
    expect(document.querySelector('[data-view="series"]')!.getAttribute('data-kind')).toBe('macro')
  })

  it('legend shows each series as a rate with the move in basis points, from preview stats', () => {
    const { widget, frame } = fixture('macro')
    render(<SeriesView widget={widget} frame={frame} />)
    const stats = preview(frame).stats
    const items = within(screen.getByRole('list', { name: 'Series legend' })).getAllByRole('listitem')
    expect(items.map((el) => el.getAttribute('data-symbol'))).toEqual(['treasury_10y', 'treasury_2y', 'fed_funds'])
    expect(items.map((el) => el.querySelector('span:nth-child(2)')!.textContent)).toEqual(['10Y', '2Y', 'Fed funds'])
    for (const item of items) {
      const v = stats[item.getAttribute('data-symbol')!]!.value!
      expect(item.querySelector('[data-field="last"]')!.textContent).toBe(`${v.last.toFixed(2)}%`)
      const bp = Math.round((v.last - v.first) * 100)
      expect(item.querySelector('[data-field="change"]')!.textContent).toBe(`${bp > 0 ? '+' : ''}${bp} bp`)
    }
    // the fed funds path fell: coloured down
    const ff = items[2]!.querySelector('[data-field="change"]') as HTMLElement
    expect(ff.style.color).toBe(hexToRgb(DOWN))
    expect(legendRows(frame, ['treasury_10y'], () => undefined)[0]).toMatchObject({ group: 'treasury_10y', first: stats.treasury_10y!.value!.first, last: stats.treasury_10y!.value!.last })
  })

  it('legendText: m2 is a compact dollar amount with a relative change; ohlcv keeps price and percent', () => {
    expect(legendText({ group: 'm2', first: 21_000_000_000_000, last: 21_900_000_000_000, changePct: 4.29, color: undefined }, 'macro')).toEqual({ label: 'M2', last: '21.9T', change: '+4.29%', changeValue: 4.29 })
    expect(legendText({ group: 'cpi_yoy', first: 3.3, last: 2.9, changePct: -12.12, color: undefined }, 'macro')).toEqual({ label: 'CPI YoY', last: '2.90%', change: '-40 bp', changeValue: -40 })
    expect(legendText({ group: 'MU', first: 100, last: 110, changePct: 10, color: undefined }, 'ohlcv')).toEqual({ label: 'MU', last: '110.00', change: '+10.00%', changeValue: 10 })
    expect(legendText({ group: 'sofr', first: null, last: null, changePct: null, color: undefined }, 'macro')).toEqual({ label: 'SOFR', last: '–', change: '–', changeValue: null })
  })

  it('renders the macro empty state', () => {
    const { widget, frame } = fixture('macro')
    render(<SeriesView widget={widget} frame={{ ...frame, rows: [] }} />)
    expect(screen.getByTestId('empty-state').textContent).toContain('No observations')
  })
})

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
