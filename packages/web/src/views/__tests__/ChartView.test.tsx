// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preview, type Frame, type WidgetV2 } from '@terminal/core'
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

import { ChartView } from '../ChartView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'
import { formatPercent, formatPrice } from '../format'
import { legendLabel } from '../series-data'
import { buildChart, detectIntraday, legendValues, nearest, toChartTime } from '../chart/data'
import { expandView } from '../view-for'
import { datasetsFor } from '../fields'

function mock() {
  return charts.current!
}
const one = (frame: Frame) => ({ main: frame })

beforeEach(() => {
  mock().charts.length = 0
  mock().markers.length = 0
  mock().createChart.mockClear()
  mock().createOptionsChart.mockClear()
  mock().createYieldCurveChart.mockClear()
  mock().fitContent.mockClear()
})
afterEach(cleanup)

const legendItems = () => within(screen.getByRole('list', { name: 'Series legend' })).getAllByRole('listitem').filter((el) => el.hasAttribute('data-symbol'))

describe('ChartView legend (chips in the plot\'s top-left)', () => {
  it('shows last close and change over the range exactly as preview() computes them (A1)', () => {
    const { widget, frame } = fixture('A1')
    render(<ChartView widget={widget} frames={one(frame)} />)
    const stats = preview(frame).stats
    const items = legendItems()
    expect(items.map((el) => el.getAttribute('data-symbol'))).toEqual(['MU', 'SNDK', 'WDC', 'STX'])
    for (const item of items) {
      const symbol = item.getAttribute('data-symbol')!
      const close = stats[symbol]!.close!
      expect(item.querySelector('[data-field="last"]')!.textContent).toBe(formatPrice(close.last))
      expect(item.querySelector('[data-field="change"]')!.textContent).toBe(formatPercent(close.changePct))
    }
    expect(document.querySelector('[data-legend]')!.className).toContain('absolute')
  })

  it('shows the widget\'s legend labels in place of the symbol, keeping the symbol on the row (A1)', () => {
    const { widget, frame } = fixture('A1')
    const labelled: WidgetV2 = { ...widget, view: { preset: 'compare', normalize: true, labels: { MU: 'Micron', STX: 'Seagate' } } }
    render(<ChartView widget={labelled} frames={one(frame)} />)
    const items = legendItems()
    expect(items.map((el) => el.getAttribute('data-symbol'))).toEqual(['MU', 'SNDK', 'WDC', 'STX'])
    expect(items.map((el) => el.querySelector('span:nth-child(2)')!.textContent)).toEqual(['Micron', 'SNDK', 'WDC', 'Seagate'])
    expect(items.map((el) => el.getAttribute('title'))).toEqual(['MU', null, null, 'STX'])
    expect(legendLabel('fed_funds')).toBe('Fed funds')
    expect(legendLabel('fed_funds', { fed_funds: 'Policy rate' })).toBe('Policy rate')
    expect(legendLabel('NVDA')).toBe('NVDA')
  })

  it('colours the change by direction', () => {
    const { widget, frame } = fixture('B1') // every symbol is down on the day
    render(<ChartView widget={widget} frames={one(frame)} />)
    const changes = legendItems().map((el) => el.querySelector('[data-field="change"]') as HTMLElement)
    expect(changes.length).toBe(3)
    for (const el of changes) expect(el.style.color).toBe(hexToRgb(DOWN))
    cleanup()
    render(<ChartView widget={fixture('A1').widget} frames={one(fixture('A1').frame)} />)
    for (const el of legendItems().map((el) => el.querySelector('[data-field="change"]') as HTMLElement)) expect(el.style.color).toBe(hexToRgb(UP))
  })
})

describe('ChartView v1 modes, preserved', () => {
  it('default view: one line per symbol in palette order on a normal price scale, last values on the axis (C4)', () => {
    const { widget, frame } = fixture('C4')
    render(<ChartView widget={widget} frames={one(frame)} />)
    const [chart] = mock().charts
    expect(chart).toBeDefined()
    expect(chart!.factory).toBe('time')
    expect(chart!.chart.scales['right:0']!.mode).toBe(0)
    expect(chart!.series.map((s) => (s.definition as { type: string }).type)).toEqual(['Line', 'Line'])
    expect(chart!.series.map((s) => (s.options as { color: string }).color)).toEqual(['#4c8dff', '#ff9f43'])
    expect(chart!.series.every((s) => (s.options as { lastValueVisible: boolean }).lastValueVisible)).toBe(true)
    expect(chart!.series.every((s) => (s.options as { priceScaleId: string }).priceScaleId === 'right')).toBe(true)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: unknown; value: number }[]
    expect(data.map((d) => d.value)).toEqual(frame.rows.filter((r) => r[0] === 'SPY').map((r) => r[5]))
    expect(mock().fitContent).toHaveBeenCalled()
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-last-value')).toBe('2')
  })

  it('normalize: lines on the IndexedTo100 price scale (A1)', () => {
    const { widget, frame } = fixture('A1')
    render(<ChartView widget={widget} frames={one(frame)} />)
    const [chart] = mock().charts
    expect(chart!.chart.scales['right:0']!.mode).toBe(3)
    expect(chart!.series).toHaveLength(4)
    expect(chart!.series.every((s) => (s.definition as { type: string }).type === 'Line')).toBe(true)
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-preset')).toBe('compare')
  })

  it('candle: a candlestick series in the price pane plus a volume histogram in its own pane, 3:1 (A2)', () => {
    const { widget, frame } = fixture('A2')
    render(<ChartView widget={widget} frames={one(frame)} />)
    const [chart] = mock().charts
    expect(chart!.series.map((s) => [(s.definition as { type: string }).type, s.pane])).toEqual([
      ['Candlestick', 0],
      ['Histogram', 1],
    ])
    const candleOpts = chart!.series[0]!.options as { upColor: string; downColor: string }
    expect(candleOpts.upColor).toBe(UP)
    expect(candleOpts.downColor).toBe(DOWN)
    const volOpts = chart!.series[1]!.options as { priceFormat: { type: string }; lastValueVisible: boolean }
    expect(volOpts.priceFormat.type).toBe('volume')
    expect(volOpts.lastValueVisible).toBe(false)
    const candles = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { open: number; close: number }[]
    expect(candles.map((c) => c.close)).toEqual(frame.rows.map((r) => r[5]))
    const volData = chart!.series[1]!.stub.setData.mock.calls[0]![0] as { value: number; color: string }[]
    expect(volData.map((d) => d.value)).toEqual(frame.rows.map((r) => r[6]))
    expect(new Set(volData.map((d) => d.color)).size).toBeGreaterThan(1) // coloured by bar direction
    const panes = chart!.chart.panes()
    expect(panes[0]!.setStretchFactor).toHaveBeenCalledWith(3)
    expect(panes[1]!.setStretchFactor).toHaveBeenCalledWith(1)
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-panes')).toBe('2')
  })
})

describe('ChartView time handling', () => {
  it('daily bars use business days and the time scale hides the clock (A1)', () => {
    const { widget, frame } = fixture('A1')
    render(<ChartView widget={widget} frames={one(frame)} />)
    const [chart] = mock().charts
    const opts = chart!.options as { timeScale: { timeVisible: boolean; secondsVisible: boolean } }
    expect(opts.timeScale.timeVisible).toBe(false)
    expect(opts.timeScale.secondsVisible).toBe(false)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: unknown }[]
    expect(data[0]!.time).toEqual({ year: 2026, month: 10, day: 6 })
    const times = chart!.series.map((s) => JSON.stringify((s.stub.setData.mock.calls[0]![0] as { time: unknown }[]).map((d) => d.time)))
    expect(new Set(times).size).toBe(1) // every symbol shares the same x positions
  })

  it('intraday bars (detected from the data) use epoch seconds and show the clock (B1)', () => {
    const { widget, frame } = fixture('B1')
    expect(detectIntraday(one(frame), expandView(widget, one(frame)))).toBe(true)
    render(<ChartView widget={widget} frames={one(frame)} />)
    const [chart] = mock().charts
    expect((chart!.options as { timeScale: { timeVisible: boolean } }).timeScale.timeVisible).toBe(true)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: number }[]
    expect(data[0]!.time).toBe(Date.UTC(2026, 9, 16, 13, 30) / 1000)
    expect(data.every((d) => Number.isInteger(d.time))).toBe(true)
  })

  it('drops bars with a null close, keeps the last of duplicate times, sorts ascending', () => {
    const { widget, frame: base } = fixture('C4')
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
    const spec = buildChart(expandView(widget, one(frame)), one(frame), datasetsFor(widget, one(frame)))
    expect((spec.series[0]!.data as { value: number }[]).map((d) => d.value)).toEqual([2, 3])
    expect(toChartTime(Date.UTC(2026, 9, 6, 13, 30), false)).toEqual({ year: 2026, month: 10, day: 6 })
    expect(nearest([1, 5, 9], 6)).toBe(5)
    expect(nearest([1, 5, 9], 8)).toBe(9)
    expect(nearest([], 8)).toBeNull()
  })
})

describe('ChartView lifecycle', () => {
  it('disposes the chart on unmount and replaces series on data change', () => {
    const { widget, frame } = fixture('C4')
    const { rerender, unmount } = render(<ChartView widget={widget} frames={one(frame)} />)
    const [chart] = mock().charts
    expect(chart!.series).toHaveLength(2)
    const next: Frame = { ...frame, rows: frame.rows.filter((r) => r[0] === 'SPY') }
    rerender(<ChartView widget={widget} frames={one(next)} />)
    expect(mock().createChart).toHaveBeenCalledTimes(1)
    expect(chart!.chart.removeSeries).toHaveBeenCalledTimes(2)
    expect(chart!.series).toHaveLength(3) // two from the first load, one from the second
    expect(mock().fitContent).toHaveBeenCalledTimes(2)
    unmount()
    expect(chart!.chart.remove).toHaveBeenCalledTimes(1)
  })

  it('renders EmptyState for an empty frame and creates no chart', () => {
    const { widget, frame } = fixture('A1')
    render(<ChartView widget={widget} frames={one({ ...frame, rows: [] })} />)
    expect(screen.getByTestId('empty-state')).toBeTruthy()
    expect(mock().createChart).not.toHaveBeenCalled()
  })

  it('viewFor picks ChartView for the chart presets and chart widgets', () => {
    expect(viewFor({ preset: 'compare', normalize: true })).toBe(ChartView)
    expect(viewFor({ preset: 'price', candle: true })).toBe(ChartView)
    expect(viewFor({ preset: 'price' })).toBe(ChartView)
    expect(viewFor({ preset: 'curve' })).toBe(ChartView)
    expect(viewFor(fixture('A1').widget)).toBe(ChartView)
    expect(viewFor(fixture('v2-indicator').widget)).toBe(ChartView)
  })
})

describe('ChartView over macro frames', () => {
  it('groups by series (one macro dataset each) and plots value, one line per series in palette order, on business days, as a percent scale', () => {
    const { widget, frames, frame } = fixture('macro')
    render(<ChartView widget={widget} frames={frames} />)
    const [chart] = mock().charts
    expect(chart!.series.map((s) => (s.definition as { type: string }).type)).toEqual(['Line', 'Line', 'Line'])
    expect(chart!.series.map((s) => (s.options as { color: string }).color)).toEqual(['#4c8dff', '#ff9f43', '#2ecc71'])
    expect(chart!.chart.scales['right:0']!.mode).toBe(0)
    expect((chart!.options as { timeScale: { timeVisible: boolean } }).timeScale.timeVisible).toBe(false)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: unknown; value: number }[]
    expect(data[0]!.time).toEqual({ year: 2025, month: 10, day: 24 })
    expect(data.map((d) => d.value)).toEqual(frame.rows.map((r) => r[1]))
    expect((chart!.series[0]!.options as { priceFormat: { type: string } }).priceFormat.type).toBe('custom')
  })

  it('legend shows each series as a rate with the move in basis points, from preview stats', () => {
    const { widget, frames } = fixture('macro')
    render(<ChartView widget={widget} frames={frames} />)
    // one dataset per series: the legend keys each line by its label (10Y, 2Y, Fed funds), the stats come per frame
    const labels = ['10Y', '2Y', 'Fed funds']
    const columns = ['year_10', 'year_2', 'rate']
    const stats = Object.values(frames).map((f, i) => preview(f).stats['*']?.[columns[i]!] ?? Object.values(preview(f).stats)[0]![columns[i]!]!)
    const items = legendItems()
    expect(items.map((el) => el.getAttribute('data-symbol'))).toEqual(labels)
    expect(items.map((el) => el.querySelector('span:nth-child(2)')!.textContent)).toEqual(labels)
    for (const [i, item] of items.entries()) {
      const v = stats[i]!
      expect(item.querySelector('[data-field="last"]')!.textContent).toBe(`${v.last.toFixed(2)}%`)
      const bp = Math.round((v.last - v.first) * 100)
      expect(item.querySelector('[data-field="change"]')!.textContent).toBe(`${bp > 0 ? '+' : ''}${bp} bp`)
    }
    const ff = items[2]!.querySelector('[data-field="change"]') as HTMLElement
    expect(ff.style.color).toBe(hexToRgb(DOWN)) // the fed funds path fell
  })

  it('legendValues: percent units move in bp, compact amounts and prices in percent', () => {
    const base = { id: 'x', pane: 0, kind: 'line' as const, color: '', label: '', group: '', data: [], side: 'right' as const, precision: 2, width: 2, legend: true, lastValue: true, range: undefined, markers: [], priceLines: [], bands: [], byTime: new Map() }
    expect(legendValues({ ...base, format: 'compact', first: 21_000_000_000_000, last: 21_900_000_000_000, changePct: 4.29 }, false)).toEqual({ last: '21.90T', change: '+4.29%', changeValue: 4.29 })
    expect(legendValues({ ...base, format: 'percent', first: 3.3, last: 2.9, changePct: -12.12 }, true)).toEqual({ last: '2.90%', change: '-40 bp', changeValue: -40 })
    expect(legendValues({ ...base, format: 'price', first: 100, last: 110, changePct: 10 }, false)).toEqual({ last: '110.00', change: '+10.00%', changeValue: 10 })
    expect(legendValues({ ...base, format: 'price', first: null, last: null, changePct: null }, false)).toEqual({ last: '–', change: '–', changeValue: null })
  })

  it('renders the macro empty state', () => {
    const { widget, frame } = fixture('macro')
    render(<ChartView widget={widget} frames={one({ ...frame, rows: [] })} />)
    expect(screen.getByTestId('empty-state').textContent).toContain('No observations')
  })
})

describe('ChartView v2 presets', () => {
  it('price: volume pane, earnings markers with a letter, a level as a price line, a band primitive, marker chips in the legend', () => {
    const { widget, frames } = fixture('v2-price')
    render(<ChartView widget={widget} frames={frames} />)
    const [chart] = mock().charts
    expect(chart!.series.map((s) => [(s.definition as { type: string }).type, s.pane])).toEqual([
      ['Line', 0],
      ['Histogram', 1],
    ])
    expect(mock().markers).toHaveLength(1)
    const markers = mock().markers[0]!.markers as { text: string; position: string; color: string }[]
    expect(markers).toHaveLength(2)
    expect(markers.every((m) => m.text === 'E' && m.position === 'aboveBar')).toBe(true)
    expect(chart!.series[0]!.stub.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 200, axisLabelVisible: true }))
    expect(chart!.series[0]!.stub.attachPrimitive).toHaveBeenCalledTimes(1)
    const chip = document.querySelector('[data-marker-kind="earnings"]')!
    expect(chip.textContent).toContain('E')
    expect(chip.textContent).toContain('earnings')
    expect(legendItems().map((el) => el.getAttribute('data-symbol'))).toEqual(['NVDA'])
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-last-value')).toBe('1')
  })

  it('compare: legend labels from the view, indexed scale', () => {
    const { widget, frames } = fixture('v2-compare')
    render(<ChartView widget={widget} frames={frames} />)
    expect(legendItems().map((el) => el.querySelector('span:nth-child(2)')!.textContent)).toEqual(['Tech', 'Energy', 'Financials'])
    expect(mock().charts[0]!.chart.scales['right:0']!.mode).toBe(3)
  })

  it('curve: a numeric x goes through the yield-curve chart with maturities in months, one line per series', () => {
    const { widget, frames } = fixture('v2-curve')
    render(<ChartView widget={widget} frames={frames} />)
    expect(mock().createYieldCurveChart).toHaveBeenCalledTimes(1)
    expect(mock().createChart).not.toHaveBeenCalled()
    const [chart] = mock().charts
    expect(chart!.factory).toBe('months')
    expect(chart!.series).toHaveLength(2)
    const data = chart!.series[0]!.stub.setData.mock.calls[0]![0] as { time: number; value: number }[]
    expect(data.map((d) => d.time)).toEqual([1, 3, 6, 12, 24, 36, 60, 84, 120, 240, 360])
    expect(data[8]!.value).toBe(4.02)
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-x')).toBe('months')
    expect(legendItems().map((el) => el.getAttribute('data-symbol'))).toEqual(['today', 'a month ago'])
  })

  it('indicator: price with the SMA overlay, volume, RSI with 30/70 levels on a fixed 0..100 scale, MACD with a signed histogram', () => {
    const { widget, frames } = fixture('v2-indicator')
    render(<ChartView widget={widget} frames={frames} />)
    const [chart] = mock().charts
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-panes')).toBe('4')
    expect(Array.from(document.querySelectorAll('[data-pane-title]')).map((el) => el.textContent)).toEqual(['RSI 14', 'MACD'])
    const byPane = (p: number) => chart!.series.filter((s) => s.pane === p)
    expect(byPane(0).map((s) => (s.definition as { type: string }).type)).toEqual(['Line', 'Line'])
    expect(byPane(1).map((s) => (s.definition as { type: string }).type)).toEqual(['Histogram'])
    const rsi = byPane(2)[0]!
    expect((rsi.options as { autoscaleInfoProvider?: () => { priceRange: { minValue: number; maxValue: number } } }).autoscaleInfoProvider!()).toEqual({ priceRange: { minValue: 0, maxValue: 100 } })
    const levels = rsi.stub.createPriceLine.mock.calls.map((c) => (c[0] as { price: number }).price)
    expect(levels).toEqual([70, 30])
    const macd = byPane(3)
    expect(macd.map((s) => (s.definition as { type: string }).type)).toEqual(['Histogram', 'Line', 'Line'])
    const hist = macd[0]!.stub.setData.mock.calls[0]![0] as { value: number; color: string }[]
    expect(hist.every((d) => (d.value < 0 ? d.color === DOWN : d.color === UP))).toBe(true)
    expect(macd[0]!.stub.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 0 })) // the zero line under signed bars
    // the price pane carries the series chips; the indicator panes carry their title chip and their last value on the axis
    expect(legendItems().map((el) => el.getAttribute('data-symbol'))).toEqual(['AMD', 'SMA 50'])
    expect(Array.from(document.querySelectorAll('[data-legend] [data-symbol]')).map((el) => el.getAttribute('data-symbol'))).toEqual(['AMD', 'SMA 50'])
    expect(screen.getByRole('list', { name: 'RSI 14 legend' })).toBeTruthy()
    expect(document.querySelector('[data-view="chart"]')!.getAttribute('data-last-value')).toBe('5')
  })
})

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
