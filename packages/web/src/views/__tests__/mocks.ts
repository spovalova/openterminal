/**
 * Shared mock factories. Each test file still calls `vi.mock` itself (vi.mock is hoisted per file),
 * importing these factories so the stubs stay identical across files.
 */
import { createElement, type FC } from 'react'
import { vi } from 'vitest'

export type SeriesStub = { setData: ReturnType<typeof vi.fn>; applyOptions: ReturnType<typeof vi.fn>; priceScale: () => { applyOptions: ReturnType<typeof vi.fn> } }
export type ChartStub = {
  addSeries: ReturnType<typeof vi.fn>
  removeSeries: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  applyOptions: ReturnType<typeof vi.fn>
  timeScale: () => { fitContent: ReturnType<typeof vi.fn>; applyOptions: ReturnType<typeof vi.fn> }
  priceScale: () => { applyOptions: ReturnType<typeof vi.fn> }
  subscribeCrosshairMove: ReturnType<typeof vi.fn>
  unsubscribeCrosshairMove: ReturnType<typeof vi.fn>
}

export function makeChartsMock() {
  const charts: { options: unknown; chart: ChartStub; series: { definition: unknown; options: unknown; stub: SeriesStub }[] }[] = []
  const fitContent = vi.fn()
  const createChart = vi.fn((_el: HTMLElement, options: unknown) => {
    const series: (typeof charts)[number]['series'] = []
    const chart: ChartStub = {
      addSeries: vi.fn((definition: unknown, options: unknown) => {
        const stub: SeriesStub = { setData: vi.fn(), applyOptions: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) }
        series.push({ definition, options, stub })
        return stub
      }),
      removeSeries: vi.fn(),
      remove: vi.fn(),
      applyOptions: vi.fn(),
      timeScale: () => ({ fitContent, applyOptions: vi.fn() }),
      priceScale: () => ({ applyOptions: vi.fn() }),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    }
    charts.push({ options, chart, series })
    return chart
  })
  const module = {
    createChart,
    LineSeries: { type: 'Line' },
    CandlestickSeries: { type: 'Candlestick' },
    HistogramSeries: { type: 'Histogram' },
    PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
  }
  return { module, charts, createChart, fitContent }
}

export const PALETTE = ['#4c8dff', '#ff9f43', '#2ecc71', '#e056a0', '#9b7bff', '#1abc9c']
export const UP = '#22c55e'
export const DOWN = '#ef4444'

/** A `@terminal/ui` stand-in that renders enough DOM to assert on props. */
export function makeUiMock() {
  const DataTable: FC<{
    columns: { name: string; type: string }[]
    rows: unknown[][]
    formats?: Record<string, string>
    sort?: { column: string; dir: 'asc' | 'desc' }
    onSort?: (column: string) => void
  }> = ({ columns, rows, formats, sort, onSort }) =>
    createElement(
      'table',
      { 'data-testid': 'data-table', 'data-formats': JSON.stringify(formats ?? {}), 'data-sort': JSON.stringify(sort ?? null) },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          ...columns.map((c) => createElement('th', { key: c.name }, createElement('button', { type: 'button', onClick: () => onSort?.(c.name) }, c.name))),
        ),
      ),
      createElement(
        'tbody',
        null,
        ...rows.map((row, i) => createElement('tr', { key: i, 'data-row': JSON.stringify(row) }, ...row.map((cell, j) => createElement('td', { key: j }, cell == null ? '' : String(cell))))),
      ),
    )
  const EmptyState: FC<{ title: string; hint?: unknown }> = ({ title, hint }) =>
    createElement('div', { 'data-testid': 'empty-state' }, createElement('strong', null, title), hint ? createElement('span', null, String(hint)) : null)
  const WidgetFrame: FC<{ title: string; children?: unknown }> = ({ title, children }) =>
    createElement('section', { 'data-testid': 'widget-frame', 'data-title': title }, children as never)
  return {
    DataTable,
    EmptyState,
    WidgetFrame,
    chartTheme: { layout: { background: { type: 'solid', color: '#0b0d12' }, textColor: '#a0a6b3' }, rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } } },
    seriesPalette: PALETTE,
    UP_COLOR: UP,
    DOWN_COLOR: DOWN,
    tokens: {},
  }
}
