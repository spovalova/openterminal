import { describe, expect, it } from 'vitest'
import { AnyWidgetSchema, ViewV2Schema, WidgetV2Schema, isWidgetV2, migrateView, migrateWidget, parseAnyWidget, widgetQueries } from '../src/index.js'

const ohlcv = (symbols: string[]) => ({ kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } })
/** A widget as the v1 store wrote it. */
const v1 = (query: unknown, view: unknown, size = 'md') => ({ id: 'w1', title: 'T', size, query, view })

describe('WidgetV2Schema', () => {
  it('accepts a single-node graph with a preset and field overrides', () => {
    const w = WidgetV2Schema.parse({
      id: 'w', title: 'NVDA', size: 'lg',
      data: { main: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } } },
      view: { preset: 'price', candle: true, volume: true },
      fields: { close: { label: 'Last', unit: 'usd' } },
    })
    expect(w.view).toEqual({ preset: 'price', candle: true, volume: true })
    expect(isWidgetV2(w)).toBe(true)
    expect(widgetQueries(w)).toEqual({ main: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } } })
  })
  it('accepts a multi-node graph with a transform and events, and checks dataset references', () => {
    const data = {
      price: { connector: 'openbb', route: 'equity/price/historical', params: { symbol: 'NVDA' } },
      eps: { recipe: 'eps_history', params: { symbols: ['NVDA'] } },
      pe: { inputs: { price: { connector: 'openbb', route: 'equity/price/historical', params: { symbol: 'NVDA' } }, eps: { recipe: 'eps_history', params: { symbols: ['NVDA'] } } }, code: 'result = price' },
      events: { recipe: 'earnings', params: { symbols: ['NVDA'], from: '2026-01-01', to: '2026-12-31' } },
    }
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', data: 'pe', events: 'events' } })).not.toThrow()
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', data: 'nope' } })).toThrow(/view\.data names dataset/)
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', events: 'ghost' } })).toThrow(/view\.events/)
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', levels: 'ghost' } })).toThrow(/view\.levels/)
  })
  it('rejects an empty graph, bad dataset names, unknown presets and a v1 kind query as a dataset', () => {
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: {}, view: { preset: 'table' } })).toThrow(/at least one dataset/)
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: { 'bad-name': { recipe: 'quote' } }, view: { preset: 'table' } })).toThrow()
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: { main: { recipe: 'quote' } }, view: { preset: 'gauge' } })).toThrow()
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: { main: { kind: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'table' } })).toThrow()
  })
  it('validates every preset’s options', () => {
    expect(ViewV2Schema.parse({ preset: 'compare', normalize: true, labels: { NVDA: 'Nvidia' } })).toEqual({ preset: 'compare', normalize: true, labels: { NVDA: 'Nvidia' } })
    expect(ViewV2Schema.parse({ preset: 'curve', x: 'maturity_years', y: ['rate'] })).toMatchObject({ preset: 'curve' })
    expect(ViewV2Schema.parse({ preset: 'indicator', rsi: 14, macd: true, volume: true })).toMatchObject({ rsi: 14 })
    expect(ViewV2Schema.parse({ preset: 'table', columns: ['symbol', 'pe'], sort: { column: 'pe' }, highlight: 'NVDA', extremes: true })).toMatchObject({ sort: { column: 'pe', dir: 'desc' } })
    expect(ViewV2Schema.parse({ preset: 'stat', column: 'pe' })).toEqual({ preset: 'stat', column: 'pe' })
    expect(ViewV2Schema.parse({ preset: 'facts', columns: ['name'] })).toMatchObject({ preset: 'facts' })
    expect(ViewV2Schema.parse({ preset: 'chain' })).toEqual({ preset: 'chain' })
    expect(ViewV2Schema.parse({ preset: 'heatmap', palette: 'diverging' })).toMatchObject({ palette: 'diverging' })
    expect(ViewV2Schema.parse({ preset: 'price', levels: [100, 120], band: [1, 2] })).toMatchObject({ levels: [100, 120] })
    expect(() => ViewV2Schema.parse({ preset: 'indicator', rsi: 1 })).toThrow()
    expect(() => ViewV2Schema.parse({ preset: 'table', columns: [] })).toThrow()
    expect(() => ViewV2Schema.parse({ preset: 'heatmap', palette: 'rainbow' })).toThrow()
  })
})

describe('migrateWidget (the v1 JSON shape → a recipe widget)', () => {
  const q = (kind: string, params: Record<string, unknown>) => ({ kind, params })
  it('maps the v1 views to presets; a candle chart keeps its volume pane', () => {
    expect(migrateView({ type: 'table' }, q('ohlcv', {}))).toEqual({ preset: 'table' })
    expect(migrateView({ type: 'chain' }, q('options', { symbol: 'MU' }))).toEqual({ preset: 'chain' })
    expect(migrateView({ type: 'stat', column: 'pe' }, q('metrics', { symbols: ['MU'] }))).toEqual({ preset: 'stat', column: 'pe' })
    expect(migrateView({ type: 'stat' }, q('quote', { symbols: ['MU'] }))).toEqual({ preset: 'stat' })
    expect(migrateView({ type: 'series', candle: true }, q('ohlcv', { symbols: ['MU'] }))).toEqual({ preset: 'price', candle: true, volume: true })
    expect(migrateView({ type: 'series', normalize: true, labels: { MU: 'Micron' } }, q('ohlcv', { symbols: ['MU', 'WDC'] }))).toEqual({ preset: 'compare', normalize: true, labels: { MU: 'Micron' } })
    expect(migrateView({ type: 'series' }, q('ohlcv', { symbols: ['MU'] }))).toEqual({ preset: 'price' })
    expect(migrateView({ type: 'series' }, q('ohlcv', { symbols: ['MU', 'WDC'] }))).toEqual({ preset: 'compare', normalize: false })
    expect(migrateView({ type: 'series' }, q('macro', { series: ['sofr'] }))).toEqual({ preset: 'compare', normalize: false })
  })
  it('moves the query under data.main as the recipe of the same name, params untouched', () => {
    const w = migrateWidget(v1(ohlcv(['MU', 'SNDK']), { type: 'series', normalize: true }, 'lg'))
    expect(w).toEqual({
      id: 'w1', title: 'T', size: 'lg',
      data: { main: { recipe: 'ohlcv', params: { symbols: ['MU', 'SNDK'], interval: '1d', range: '3mo' } } },
      view: { preset: 'compare', normalize: true },
    })
    expect(() => WidgetV2Schema.parse(w)).not.toThrow()
    // params are not validated here: the recipe does that when the widget runs
    expect(migrateWidget(v1(q('quote', { symbols: [] }), { type: 'table' })).data.main).toEqual({ recipe: 'quote', params: { symbols: [] } })
  })
  it('splits a multi-series macro query into one dataset per series', () => {
    const w = migrateWidget(v1(q('macro', { series: ['treasury_10y', 'fed_funds'], range: '1y' }), { type: 'series' }))
    expect(w.data).toEqual({ treasury_10y: { recipe: 'macro', params: { series: 'treasury_10y', range: '1y' } }, fed_funds: { recipe: 'macro', params: { series: 'fed_funds', range: '1y' } } })
    expect(w.view).toEqual({ preset: 'compare', normalize: false })
    const one = migrateWidget(v1(q('macro', { series: ['sofr'] }), { type: 'series' }))
    expect(one.data).toEqual({ main: { recipe: 'macro', params: { series: 'sofr' } } })
  })
  it('parseAnyWidget and AnyWidgetSchema read both shapes and return a v2 widget', () => {
    const v2 = parseAnyWidget({ id: 'w', title: 'x', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' } })
    expect(isWidgetV2(v2)).toBe(true)
    const migrated = parseAnyWidget({ id: 'w', title: 'x', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } })
    expect(migrated.data.main).toEqual({ recipe: 'quote', params: { symbols: ['MU'] } })
    const stored = v1(ohlcv(['MU']), { type: 'table' }, 'sm')
    expect(AnyWidgetSchema.parse(stored)).toEqual(migrateWidget(stored))
    expect(AnyWidgetSchema.safeParse({ id: 'w', title: 'x', size: 'sm', view: { preset: 'table' } }).success).toBe(false)
    expect(() => parseAnyWidget({ id: 'w', title: 'x', size: 'sm', query: { kind: 'quote' }, view: { type: 'nope' } })).toThrow()
  })
})
