import { describe, expect, it } from 'vitest'
import { PaneSchema, WIDE_COLUMNS, WIDE_VALUE, controlFor, datasetFieldsFrom, expandPreset, isChartPreset, markerLayer, paneDatasets, parsePanes, primaryDataset, type DatasetsFieldConfig, type Frame, type FieldConfig } from '../src/index.js'

const frame = (columns: [string, Frame['columns'][number]['type']][], rows: unknown[][], fields: Record<string, FieldConfig> = {}): Frame => ({
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  meta: { connector: 'x', fetchedAt: 0, ttl: 0, fields },
})

const bars = frame(
  [['symbol', 'string'], ['time', 'time'], ['open', 'number'], ['high', 'number'], ['low', 'number'], ['close', 'number'], ['volume', 'number']],
  [['NVDA', 1, 1, 2, 0.5, 1.5, 100], ['NVDA', 2, 1, 2, 0.5, 1.7, 120], ['AMD', 1, 1, 2, 0.5, 1, 10], ['AMD', 2, 1, 2, 0.5, 1.2, 12]],
  { close: { unit: 'usd' } },
)
const oneBars = frame(bars.columns.map((c) => [c.name, c.type]), bars.rows.filter((r) => r[0] === 'NVDA'), { close: { unit: 'usd' } })
const events = frame([['symbol', 'string'], ['date', 'time'], ['eps_actual', 'number'], ['session', 'string']], [['NVDA', 1, 0.9, 'amc']])
const quotes = frame([['symbol', 'string'], ['last_price', 'number'], ['change_percent', 'number'], ['volume', 'number']], [['NVDA', 180, -5.6, 1e6], ['AMD', 150, 1.2, 2e6]], {
  last_price: { unit: 'usd', key: true, label: 'Last', priority: 1 },
  change_percent: { unit: 'percent', format: 'change', priority: 2 },
  volume: { unit: 'shares', priority: 3 },
})
const curve = frame([['maturity', 'string'], ['maturity_years', 'number'], ['rate', 'number']], [['1M', 0.08, 4.1], ['2Y', 2, 3.9], ['10Y', 10, 4.3]], { rate: { unit: 'percent' } })
const indicators = frame(
  [['symbol', 'string'], ['time', 'time'], ['close', 'number'], ['volume', 'number'], ['rsi', 'number'], ['macd', 'number'], ['macd_signal', 'number'], ['macd_hist', 'number'], ['sma_50', 'number']],
  [['AMD', 1, 1, 1, 50, 0.1, 0.05, 0.05, 1], ['AMD', 2, 1.1, 1, 55, 0.2, 0.1, 0.1, 1]],
)
const corr = frame([['symbol', 'string'], ['NVDA', 'number'], ['AMD', 'number']], [['NVDA', 1, 0.8], ['AMD', 0.8, 1]])
const chain = frame([['symbol', 'string'], ['expiration', 'string'], ['option_type', 'string'], ['strike', 'number'], ['bid', 'number']], [['TSLA', '2026-10-24', 'call', 400, 1], ['TSLA', '2026-10-24', 'put', 400, 2]])

const ds = (frames: Record<string, Frame>): DatasetsFieldConfig => Object.fromEntries(Object.entries(frames).map(([k, f]) => [k, datasetFieldsFrom(f)]))

describe('expandPreset', () => {
  it('price: a line on close with the group, a volume pane, markers and levels', () => {
    const panes = expandPreset({ preset: 'price', volume: true, events: 'events', levels: [100, 120] }, ds({ main: bars, events }))
    expect(panes).toHaveLength(2)
    expect(panes[0]!.layers[0]).toEqual({ mark: 'line', data: 'main', x: 'time', y: 'close', group: 'symbol' })
    expect(panes[0]!.layers.filter((l) => l.mark === 'level')).toHaveLength(2)
    expect(panes[0]!.layers.at(-1)).toMatchObject({ mark: 'marker', data: 'events', x: 'date', label: 'session', detail: 'eps_actual' })
    expect(panes[0]!.scales?.left).toEqual({ format: 'price' })
    expect(panes[0]!).toMatchObject({ height: 3, x: 'time', legend: true, lastValue: true })
    expect(panes[1]!.layers[0]).toMatchObject({ mark: 'histogram', y: 'volume', colorBy: 'close' })
    expect(panes.every((p) => PaneSchema.safeParse(p).success)).toBe(true)
  })
  it('price: candles when asked and the frame has ohlc; a level dataset; a band', () => {
    const panes = expandPreset({ preset: 'price', candle: true, levels: 'quotes', band: [1, 2] }, ds({ main: oneBars, quotes }))
    expect(panes[0]!.layers[0]).toEqual({ mark: 'candle', data: 'main', x: 'time', open: 'open', high: 'high', low: 'low', close: 'close' })
    expect(panes[0]!.layers).toContainEqual({ mark: 'level', data: 'quotes', y: 'last_price', style: 'dashed' })
    expect(panes[0]!.layers).toContainEqual({ mark: 'band', from: 1, to: 2 })
    expect(panes).toHaveLength(1)
    expect(expandPreset({ preset: 'price', candle: true }, ds({ main: curve }))).toEqual([])
  })
  it('compare: one line per group on an indexed scale by default', () => {
    const panes = expandPreset({ preset: 'compare' }, ds({ main: bars }))
    expect(panes).toEqual([{ height: 1, x: 'time', layers: [{ mark: 'line', data: 'main', x: 'time', y: 'close', group: 'symbol' }], scales: { left: { indexed: true } }, legend: true, lastValue: true }])
    expect(expandPreset({ preset: 'compare', normalize: false }, ds({ main: bars }))[0]!.scales?.left).toEqual({ format: 'price' })
  })
  it('compare: one line per time-series dataset when the widget holds several (a migrated multi-series macro widget)', () => {
    const series = (name: string, v: number) => frame([['series', 'string'], ['time', 'time'], ['value', 'number']], [[name, 1, v], [name, 2, v + 1]], { value: { unit: 'percent', label: name } })
    const panes = expandPreset({ preset: 'compare', normalize: false }, ds({ treasury_10y: series('treasury_10y', 4), fed_funds: series('fed_funds', 3.9), quotes }))
    expect(panes[0]!.layers).toEqual([
      { mark: 'line', data: 'treasury_10y', x: 'time', y: 'value', label: 'treasury_10y' },
      { mark: 'line', data: 'fed_funds', x: 'time', y: 'value', label: 'fed_funds' },
    ])
    expect(panes[0]!.scales?.left).toEqual({ format: 'percent' })
    expect(expandPreset({ preset: 'compare', data: 'fed_funds' }, ds({ treasury_10y: series('treasury_10y', 4), fed_funds: series('fed_funds', 3.9) }))[0]!.layers).toHaveLength(1)
  })
  it('curve: a numeric x-axis from the shape or the options', () => {
    const panes = expandPreset({ preset: 'curve' }, ds({ main: curve }))
    expect(panes[0]).toMatchObject({ x: 'number', layers: [{ mark: 'line', data: 'main', x: 'maturity_years', y: 'rate' }], scales: { left: { format: 'percent' } } })
    expect(expandPreset({ preset: 'curve', x: 'strike', y: ['bid'] }, ds({ main: chain }))[0]!.layers[0]).toMatchObject({ x: 'strike', y: 'bid' })
    expect(expandPreset({ preset: 'curve' }, ds({ main: quotes }))).toEqual([])
  })
  it('indicator: price pane with overlays, then volume, RSI with 30/70 levels, MACD with a signed histogram', () => {
    const panes = expandPreset({ preset: 'indicator', rsi: 14, macd: true, volume: true }, ds({ main: indicators }))
    expect(panes.map((p) => p.title ?? 'price')).toEqual(['price', 'price', 'RSI 14', 'MACD'])
    expect(panes[0]!.layers.map((l) => l.mark)).toEqual(['line', 'line'])
    expect(panes[0]!.layers[1]).toMatchObject({ y: 'sma_50', label: 'SMA 50' })
    expect(panes[2]!.layers.map((l) => l.mark)).toEqual(['line', 'level', 'level'])
    expect(panes[2]!.scales).toEqual({ left: { min: 0, max: 100 } })
    expect(panes[3]!.layers[0]).toMatchObject({ mark: 'histogram', y: 'macd_hist', signed: true })
    expect(expandPreset({ preset: 'indicator', rsi: 14, macd: true }, ds({ main: oneBars }))).toHaveLength(1) // no rsi/macd columns, no panes for them
  })
  it('heatmap: wide frames melt by the group column; long frames bind x, y, value', () => {
    const wide = expandPreset({ preset: 'heatmap' }, ds({ main: corr }))
    expect(wide).toEqual([{ height: 1, x: 'category', layers: [{ mark: 'cell', data: 'main', x: 'symbol', y: WIDE_COLUMNS, value: WIDE_VALUE, palette: 'diverging', text: true }] }])
    const long = expandPreset({ preset: 'heatmap', x: 'a', y: 'b', value: 'v', palette: 'sequential', text: false }, ds({ main: corr }))
    expect(long[0]!.layers[0]).toEqual({ mark: 'cell', data: 'main', x: 'a', y: 'b', value: 'v', palette: 'sequential', text: false })
  })
  it('non-chart presets expand to no panes; isChartPreset knows which is which', () => {
    for (const preset of ['table', 'stat', 'facts', 'chain'] as const) expect(expandPreset({ preset }, ds({ main: quotes }))).toEqual([])
    expect(isChartPreset('price')).toBe(true)
    expect(isChartPreset('table')).toBe(false)
  })
  it('picks the dataset: view.data, then main, then the first; nothing without datasets', () => {
    expect(primaryDataset({}, ds({ a: bars, main: quotes }))).toBe('main')
    expect(primaryDataset({ data: 'a' }, ds({ a: bars, main: quotes }))).toBe('a')
    expect(primaryDataset({}, ds({ a: bars }))).toBe('a')
    expect(expandPreset({ preset: 'price' }, {})).toEqual([])
  })
  it('paneDatasets lists every dataset a pane list reads', () => {
    const panes = expandPreset({ preset: 'price', events: 'events' }, ds({ main: bars, events }))
    expect(paneDatasets(panes)).toEqual(['main', 'events'])
  })
})

describe('controlFor', () => {
  it('table: columns by priority, formats and labels from field config, percent columns colorized, sort and highlight', () => {
    const c = controlFor({ preset: 'table', sort: { column: 'change_percent', dir: 'desc' }, highlight: 'AMD' }, ds({ main: quotes }))
    expect(c).toEqual({
      kind: 'table',
      data: 'main',
      columns: ['last_price', 'change_percent', 'volume', 'symbol'],
      formats: { last_price: 'price', change_percent: 'change', volume: 'compact', symbol: 'text' },
      labels: { last_price: 'Last' },
      sort: { column: 'change_percent', dir: 'desc' },
      highlight: { column: 'symbol', value: 'AMD' },
      colorize: ['change_percent'],
      extremes: false,
    })
    expect(controlFor({ preset: 'table', columns: ['symbol', 'nope', 'last_price'] }, ds({ main: quotes }))).toMatchObject({ columns: ['symbol', 'last_price'] })
  })
  it('stat: the key field, its change column and format', () => {
    expect(controlFor({ preset: 'stat' }, ds({ main: quotes }))).toEqual({ kind: 'stat', data: 'main', column: 'last_price', group: 'symbol', change: 'change_percent', format: 'price', label: 'Last', unit: 'usd' })
    expect(controlFor({ preset: 'stat', column: 'volume' }, ds({ main: quotes }))).toMatchObject({ column: 'volume', format: 'compact', change: 'change_percent' })
    expect(controlFor({ preset: 'stat' }, ds({ main: frame([['name', 'string']], [['x']]) }))).toBeUndefined()
  })
  it('facts and chain and chart', () => {
    expect(controlFor({ preset: 'facts', columns: ['symbol', 'last_price'] }, ds({ main: quotes }))).toMatchObject({ kind: 'facts', columns: ['symbol', 'last_price'], formats: { last_price: 'price' } })
    expect(controlFor({ preset: 'chain' }, ds({ main: chain }))).toEqual({ kind: 'chain', data: 'main' })
    const chart = controlFor({ preset: 'compare' }, ds({ main: bars }))
    expect(chart?.kind).toBe('chart')
    expect(chart && 'panes' in chart && chart.panes).toHaveLength(1)
  })
})

describe('layers', () => {
  it('parses every mark and rejects malformed levels and bands', () => {
    const panes = parsePanes([
      { layers: [
        { mark: 'line', data: 'a', x: 'time', y: 'close' },
        { mark: 'area', data: 'a', x: 'time', y: 'close', scale: 'right' },
        { mark: 'bar', data: 'a', x: 'time', y: 'ret', signed: true },
        { mark: 'histogram', data: 'a', x: 'time', y: 'volume' },
        { mark: 'candle', data: 'a', x: 'time', open: 'o', high: 'h', low: 'l', close: 'c' },
        { mark: 'marker', data: 'e', x: 'time', label: 'label', kind: 'kind' },
        { mark: 'level', value: 70, style: 'dotted' },
        { mark: 'band', data: 'a', x: 'time', when: 'negative' },
        { mark: 'cell', data: 'm', x: 'a', y: 'b', value: 'v' },
        { mark: 'profile', data: 'a', y: 'close', value: 'volume', side: 'right' },
      ] },
    ])
    expect(panes[0]!.layers).toHaveLength(10)
    expect(panes[0]).toMatchObject({ height: 1, x: 'time' })
    expect(() => parsePanes([{ layers: [{ mark: 'level' }] }])).toThrow()
    expect(() => parsePanes([{ layers: [{ mark: 'band' }] }])).toThrow()
    expect(() => parsePanes([{ layers: [{ mark: 'spline', data: 'a', x: 'x', y: 'y' }] }])).toThrow()
    expect(() => parsePanes([{ layers: [] }])).toThrow()
  })
  it('markerLayer finds the time and label columns of an events frame', () => {
    const news = datasetFieldsFrom(frame([['time', 'time'], ['headline', 'string'], ['source', 'string'], ['url', 'string'], ['symbol', 'string']], [[1, 'h', 's', 'u', 'NVDA']]))
    expect(markerLayer('news', news)).toEqual({ mark: 'marker', data: 'news', x: 'time', label: 'headline', kind: 'source' })
    expect(markerLayer('q', datasetFieldsFrom(quotes))).toBeUndefined()
  })
})
