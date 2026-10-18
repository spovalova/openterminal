import { describe, expect, it } from 'vitest'
import { AnyWidgetSchema, ViewV2Schema, WidgetSchema, WidgetV2Schema, isWidgetV2, migrateView, migrateWidget, parseAnyWidget, parseWidget, widgetQueries } from '../src/index.js'

const ohlcv = (symbols: string[]) => ({ kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } })
const v1 = (query: unknown, view: unknown, size = 'md') => parseWidget({ id: 'w1', title: 'T', size, query, view })

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
      events: { kind: 'earnings', params: { symbols: ['NVDA'], from: '2026-01-01', to: '2026-12-31' } },
    }
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', data: 'pe', events: 'events' } })).not.toThrow()
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', data: 'nope' } })).toThrow(/view\.data names dataset/)
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', events: 'ghost' } })).toThrow(/view\.events/)
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'P/E', size: 'lg', data, view: { preset: 'price', levels: 'ghost' } })).toThrow(/view\.levels/)
  })
  it('rejects an empty graph, bad dataset names and unknown presets', () => {
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: {}, view: { preset: 'table' } })).toThrow(/at least one dataset/)
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: { 'bad-name': { recipe: 'quote' } }, view: { preset: 'table' } })).toThrow()
    expect(() => WidgetV2Schema.parse({ id: 'w', title: 'x', size: 'sm', data: { main: { recipe: 'quote' } }, view: { preset: 'gauge' } })).toThrow()
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

describe('migrateWidget', () => {
  it('maps the v1 views to presets', () => {
    expect(migrateView({ type: 'table' }, v1(ohlcv(['MU']), { type: 'table' }).query)).toEqual({ preset: 'table' })
    expect(migrateView({ type: 'chain' }, v1({ kind: 'options', params: { symbol: 'MU' } }, { type: 'chain' }).query)).toEqual({ preset: 'chain' })
    expect(migrateView({ type: 'stat', column: 'pe' }, v1({ kind: 'metrics', params: { symbols: ['MU'] } }, { type: 'stat' }).query)).toEqual({ preset: 'stat', column: 'pe' })
    expect(migrateView({ type: 'series', candle: true }, v1(ohlcv(['MU']), { type: 'table' }).query)).toEqual({ preset: 'price', candle: true })
    expect(migrateView({ type: 'series', normalize: true, labels: { MU: 'Micron' } }, v1(ohlcv(['MU', 'WDC']), { type: 'table' }).query)).toEqual({ preset: 'compare', normalize: true, labels: { MU: 'Micron' } })
    expect(migrateView({ type: 'series' }, v1(ohlcv(['MU']), { type: 'table' }).query)).toEqual({ preset: 'price' })
    expect(migrateView({ type: 'series' }, v1(ohlcv(['MU', 'WDC']), { type: 'table' }).query)).toEqual({ preset: 'compare', normalize: false })
  })
  it('moves the query under data.main as the recipe of the same name and keeps the v1 query readable', () => {
    const w = migrateWidget(v1(ohlcv(['MU', 'SNDK']), { type: 'series', normalize: true }, 'lg'))
    expect(w).toEqual({
      id: 'w1', title: 'T', size: 'lg',
      data: { main: { recipe: 'ohlcv', params: { symbols: ['MU', 'SNDK'], interval: '1d', range: '3mo' } } },
      view: { preset: 'compare', normalize: true },
      query: { kind: 'ohlcv', params: { symbols: ['MU', 'SNDK'], interval: '1d', range: '3mo' } },
    })
    expect(() => WidgetV2Schema.parse(w)).not.toThrow()
  })
  it('splits a multi-series macro query into one dataset per series', () => {
    const w = migrateWidget(v1({ kind: 'macro', params: { series: ['treasury_10y', 'fed_funds'], range: '1y' } }, { type: 'series' }))
    expect(w.data).toEqual({ treasury_10y: { recipe: 'macro', params: { series: 'treasury_10y', range: '1y' } }, fed_funds: { recipe: 'macro', params: { series: 'fed_funds', range: '1y' } } })
    expect(w.view).toEqual({ preset: 'compare', normalize: false })
    const one = migrateWidget(v1({ kind: 'macro', params: { series: ['sofr'] } }, { type: 'series' }))
    expect(one.data).toEqual({ main: { recipe: 'macro', params: { series: 'sofr', range: '1y' } } })
  })
  it('parseAnyWidget accepts v1 and v2 and returns v2; v1 keeps validating as before', () => {
    const v2 = parseAnyWidget({ id: 'w', title: 'x', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' } })
    expect(isWidgetV2(v2)).toBe(true)
    const migrated = parseAnyWidget({ id: 'w', title: 'x', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } })
    expect(migrated.data.main).toEqual({ recipe: 'quote', params: { symbols: ['MU'] } })
    expect(() => parseAnyWidget({ id: 'w', title: 'x', size: 'sm', query: ohlcv(['MU', 'WDC']), view: { type: 'series', candle: true } })).toThrow(/exactly one symbol/)
    expect(AnyWidgetSchema.safeParse({ id: 'w', title: 'x', size: 'sm', query: ohlcv(['MU']), view: { type: 'table' } }).success).toBe(true)
    expect(WidgetSchema.safeParse({ id: 'w', title: 'x', size: 'sm', data: {}, view: { preset: 'table' } }).success).toBe(false)
    expect(widgetQueries(v1(ohlcv(['MU']), { type: 'table' }))).toEqual({ main: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } } })
  })
})
