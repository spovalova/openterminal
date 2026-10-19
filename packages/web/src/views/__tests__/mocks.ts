/**
 * Shared mock factories. Each test file still calls `vi.mock` itself (vi.mock is hoisted per file),
 * importing these factories so the stubs stay identical across files.
 */
import { createElement, type FC } from 'react'
import { vi } from 'vitest'

export type SeriesStub = {
  setData: ReturnType<typeof vi.fn>
  applyOptions: ReturnType<typeof vi.fn>
  priceScale: () => { applyOptions: ReturnType<typeof vi.fn> }
  createPriceLine: ReturnType<typeof vi.fn>
  attachPrimitive: ReturnType<typeof vi.fn>
  detachPrimitive: ReturnType<typeof vi.fn>
  priceToCoordinate: ReturnType<typeof vi.fn>
}
export type PaneStub = { setStretchFactor: ReturnType<typeof vi.fn>; getSeries: () => SeriesStub[]; paneIndex: () => number }
export type ChartStub = {
  addSeries: ReturnType<typeof vi.fn>
  removeSeries: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  applyOptions: ReturnType<typeof vi.fn>
  timeScale: () => { fitContent: ReturnType<typeof vi.fn>; applyOptions: ReturnType<typeof vi.fn>; timeToCoordinate: ReturnType<typeof vi.fn>; width: () => number }
  /** Options applied per (scale id, pane index), e.g. `scales['right:0'].mode`. */
  scales: Record<string, Record<string, unknown>>
  priceScale: (id?: string, pane?: number) => { applyOptions: (o: Record<string, unknown>) => void }
  panes: () => PaneStub[]
  addPane: ReturnType<typeof vi.fn>
  removePane: ReturnType<typeof vi.fn>
  paneSize: (i: number) => { width: number; height: number }
  subscribeCrosshairMove: ReturnType<typeof vi.fn>
  unsubscribeCrosshairMove: ReturnType<typeof vi.fn>
}
export type MarkerCall = { series: SeriesStub; markers: unknown[]; detach: ReturnType<typeof vi.fn> }

export function makeChartsMock() {
  const charts: { options: unknown; chart: ChartStub; series: { definition: unknown; options: unknown; pane: number; stub: SeriesStub }[]; factory: string }[] = []
  const markers: MarkerCall[] = []
  const fitContent = vi.fn()
  const make = (factory: string) =>
    vi.fn((_el: HTMLElement, options: unknown) => {
      const series: (typeof charts)[number]['series'] = []
      const panes: PaneStub[] = []
      const ensurePane = (i: number) => {
        while (panes.length <= i) {
          const index = panes.length
          panes.push({ setStretchFactor: vi.fn(), getSeries: () => series.filter((s) => s.pane === index).map((s) => s.stub), paneIndex: () => index })
        }
        return panes[i]!
      }
      ensurePane(0)
      const scales: ChartStub['scales'] = {}
      const chart: ChartStub = {
        addSeries: vi.fn((definition: unknown, options: unknown, pane = 0) => {
          ensurePane(pane)
          const stub: SeriesStub = {
            setData: vi.fn(),
            applyOptions: vi.fn(),
            priceScale: () => ({ applyOptions: vi.fn() }),
            createPriceLine: vi.fn(),
            attachPrimitive: vi.fn(),
            detachPrimitive: vi.fn(),
            priceToCoordinate: vi.fn((p: number) => p),
          }
          series.push({ definition, options, pane, stub })
          return stub
        }),
        removeSeries: vi.fn(),
        remove: vi.fn(),
        applyOptions: vi.fn(),
        timeScale: () => ({ fitContent, applyOptions: vi.fn(), timeToCoordinate: vi.fn(() => 0), width: () => 300 }),
        scales,
        priceScale: (id = 'right', pane = 0) => ({
          applyOptions: (o: Record<string, unknown>) => {
            scales[`${id}:${pane}`] = { ...(scales[`${id}:${pane}`] ?? {}), ...o }
          },
        }),
        panes: () => panes,
        addPane: vi.fn(() => ensurePane(panes.length)),
        removePane: vi.fn((i: number) => {
          panes.splice(i, 1)
        }),
        paneSize: () => ({ width: 300, height: 200 }),
        subscribeCrosshairMove: vi.fn(),
        unsubscribeCrosshairMove: vi.fn(),
      }
      charts.push({ options, chart, series, factory })
      return chart
    })
  const createChart = make('time')
  const createOptionsChart = make('number')
  const createYieldCurveChart = make('months')
  const createSeriesMarkers = vi.fn((series: SeriesStub, list: unknown[]) => {
    const call: MarkerCall = { series, markers: list, detach: vi.fn() }
    markers.push(call)
    return call
  })
  const module = {
    createChart,
    createOptionsChart,
    createYieldCurveChart,
    createSeriesMarkers,
    LineSeries: { type: 'Line' },
    AreaSeries: { type: 'Area' },
    CandlestickSeries: { type: 'Candlestick' },
    HistogramSeries: { type: 'Histogram' },
    PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
    // enums the real @openterminal/ui chart theme reads at import time
    ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
    CrosshairMode: { Normal: 0, Magnet: 1, Hidden: 2 },
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
  }
  return { module, charts, markers, createChart, createOptionsChart, createYieldCurveChart, createSeriesMarkers, fitContent }
}

export const PALETTE = ['#4c8dff', '#ff9f43', '#2ecc71', '#e056a0', '#9b7bff', '#1abc9c']
export const UP = '#22c55e'
export const DOWN = '#ef4444'

/**
 * A `@openterminal/ui` stand-in that renders enough DOM to assert on props. The real module is spread
 * underneath so pure helpers (formatCell, formatCompact, EMPTY_CELL) keep working; the stubs override
 * the components, palette and theme the tests assert on.
 */
export async function makeUiMock() {
  const actual = await vi.importActual<typeof import('@openterminal/ui')>('@openterminal/ui')
  const DataTable: FC<{
    columns: { name: string; type: string }[]
    rows: unknown[][]
    formats?: Record<string, string>
    labels?: Record<string, string>
    sort?: { column: string; dir: 'asc' | 'desc' }
    onSort?: (column: string) => void
    highlightRow?: (row: unknown[]) => boolean
    cellMark?: (row: unknown[], column: string) => 'best' | 'worst' | undefined
  }> = ({ columns, rows, formats, labels, sort, onSort, highlightRow, cellMark }) => {
    // Marks and the highlight keyed by the row's first cell, so tests can assert on them without the real table.
    const marks: Record<string, Record<string, string>> = {}
    let highlight: string | null = null
    for (const row of rows) {
      const key = String(row[0])
      if (highlightRow?.(row)) highlight = key
      for (const c of columns) {
        const m = cellMark?.(row, c.name)
        if (m) marks[key] = { ...(marks[key] ?? {}), [c.name]: m }
      }
    }
    return createElement(
      'table',
      {
        'data-testid': 'data-table',
        'data-formats': JSON.stringify(formats ?? {}),
        'data-labels': JSON.stringify(labels ?? {}),
        'data-sort': JSON.stringify(sort ?? null),
        'data-highlight': highlight,
        'data-marks': JSON.stringify(marks),
      },
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
  }
  const EmptyState: FC<{ title: string; hint?: unknown }> = ({ title, hint }) =>
    createElement('div', { 'data-testid': 'empty-state' }, createElement('strong', null, title), hint ? createElement('span', null, String(hint)) : null)
  const WidgetFrame: FC<{ title: string; children?: unknown }> = ({ title, children }) =>
    createElement('section', { 'data-testid': 'widget-frame', 'data-title': title }, children as never)
  return {
    ...actual,
    DataTable,
    EmptyState,
    WidgetFrame,
    chartTheme: { layout: { background: { type: 'solid', color: '#0b0d12' }, textColor: '#a0a6b3' }, rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } } },
    seriesPalette: PALETTE,
    UP_COLOR: UP,
    DOWN_COLOR: DOWN,
  }
}
