import { describe, expect, it } from 'vitest'
import { parseWidget, type AnyWidget, type Frame } from '@terminal/core'
import {
  asV1Widget,
  datasetKind,
  draftFrom,
  emptyDraft,
  legacyQueryOf,
  newTransform,
  nextDatasetName,
  optionValue,
  presetOptions,
  presetsAvailable,
  removeDataset,
  renameDataset,
  setViewOption,
  switchPreset,
  syncTransformInputs,
  toWidget,
  transformEdges,
  v1ViewFrom,
} from '../editor-model'

const v1 = parseWidget({ id: 'w1', title: 'MU daily', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, view: { type: 'series', candle: true } })

const v2: AnyWidget = {
  id: 'w2',
  title: 'P/E',
  size: 'lg',
  data: {
    price: { recipe: 'ohlcv', params: { symbols: ['NVDA'], range: '2y' } },
    eps: { recipe: 'eps_history', params: { symbols: ['NVDA'] } },
    main: { inputs: { price: { recipe: 'ohlcv', params: { symbols: ['NVDA'], range: '2y' } }, eps: { recipe: 'eps_history', params: { symbols: ['NVDA'] } } }, code: 'result = price' },
  },
  view: { preset: 'price', data: 'main' },
  fields: { pe: { label: 'P/E' } },
}

const quoteFrame: Frame = { columns: [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }, { name: 'change_pct', type: 'number' }], rows: [['NVDA', 180, 1.2]], meta: { connector: 'fake', fetchedAt: 1, ttl: 10 } }
const barsFrame: Frame = {
  columns: [{ name: 'symbol', type: 'string' }, { name: 'time', type: 'time' }, { name: 'close', type: 'number' }],
  rows: [['NVDA', 1, 10], ['NVDA', 2, 11]],
  meta: { connector: 'fake', fetchedAt: 1, ttl: 10 },
}

describe('editor draft', () => {
  it('opens a v1 widget with its kind query as main and the view as a preset; saves a v2 widget on the v1 path', () => {
    const d = draftFrom(v1)
    expect(d.data).toEqual({ main: v1.query })
    expect(d.view).toEqual({ preset: 'price', candle: true })
    expect(d.query).toBeUndefined()
    const w = toWidget({ ...d, title: 'MU candles' })
    expect(w.data.main).toEqual(v1.query)
    expect(w.view).toEqual({ preset: 'price', candle: true })
    expect(w.query).toBeUndefined()
    expect(datasetKind(w.data.main!)).toBe('kind')
  })

  it('opens a v2 widget as it is and keeps a migrated widget\'s v1 query only while main is untouched', () => {
    const d = draftFrom(v2)
    expect(Object.keys(d.data)).toEqual(['price', 'eps', 'main'])
    expect(d.fields).toEqual({ pe: { label: 'P/E' } })
    const migrated: AnyWidget = { id: 'm', title: 'Quote', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' }, query: { kind: 'quote', params: { symbols: ['MU'] } } }
    const same = toWidget(draftFrom(migrated))
    expect(same.query).toEqual(migrated.query)
    const changed = draftFrom(migrated)
    changed.data = { main: { recipe: 'quote', params: { symbols: ['MU', 'STX'] } } }
    expect(toWidget(changed).query).toBeUndefined()
  })

  it('emptyDraft is a quote stat; toWidget validates (a blank title throws)', () => {
    const d = emptyDraft()
    expect(datasetKind(d.data.main!)).toBe('recipe')
    expect(() => toWidget(d)).toThrow()
    expect(toWidget({ ...d, title: 'NVDA' }).view).toEqual({ preset: 'stat' })
  })

  it('transform inputs named after datasets follow those datasets; edges list them', () => {
    const d = draftFrom(v2)
    d.data.price = { recipe: 'ohlcv', params: { symbols: ['AMD'], range: '1y' } }
    const synced = syncTransformInputs(d.data)
    expect((synced.main as { inputs: Record<string, unknown> }).inputs.price).toEqual({ recipe: 'ohlcv', params: { symbols: ['AMD'], range: '1y' } })
    expect(transformEdges('main', d.data)).toEqual(['price', 'eps'])
    expect(transformEdges('price', d.data)).toEqual([])
    const t = newTransform(d.data, ['price', 'main', 'nope'])
    expect(Object.keys(t.inputs)).toEqual(['price'])
    expect(t.code).toMatch(/result/)
  })

  it('names, renames and removes datasets, following references in transforms and the view', () => {
    expect(nextDatasetName({})).toBe('main')
    expect(nextDatasetName({ main: v1.query })).toBe('data2')
    expect(nextDatasetName({ main: v1.query, data2: v1.query }, 'data')).toBe('data3')
    const d = draftFrom(v2)
    const renamed = renameDataset(d, 'price', 'bars')
    expect(Object.keys(renamed.data)).toEqual(['bars', 'eps', 'main'])
    expect(Object.keys((renamed.data.main as { inputs: object }).inputs)).toEqual(['bars', 'eps'])
    expect(renameDataset(d, 'price', 'eps')).toBe(d) // taken
    expect(renameDataset(d, 'price', '9x')).toBe(d) // not an identifier
    const viewRef = renameDataset({ ...d, view: { preset: 'price', data: 'main', events: 'eps' } }, 'eps', 'events')
    expect(viewRef.view).toEqual({ preset: 'price', data: 'main', events: 'events' })
    const removed = removeDataset(viewRef, 'events')
    expect(Object.keys(removed.data)).toEqual(['price', 'main'])
    expect(removed.view).toEqual({ preset: 'price', data: 'main' })
    expect(Object.keys((removed.data.main as { inputs: object }).inputs)).toEqual(['price'])
  })
})

describe('view tab helpers', () => {
  it('offers every preset without a frame and the shape\'s presets with one', () => {
    const d = { data: { main: v1.query }, view: { preset: 'table' as const } }
    expect(presetsAvailable(d, {})).toHaveLength(9)
    expect(presetsAvailable(d, { main: quoteFrame })).toEqual(['table', 'stat', 'facts', 'heatmap'])
    expect(presetsAvailable(d, { main: barsFrame })).toEqual(['price', 'compare', 'indicator', 'table'])
    // the current preset stays selectable even when the shape would not offer it
    expect(presetsAvailable({ ...d, view: { preset: 'price' } }, { main: quoteFrame })[0]).toBe('price')
  })

  it('reads the option fields off ViewV2Schema', () => {
    expect(presetOptions('table').map((o) => [o.name, o.input])).toEqual([
      ['data', 'dataset'],
      ['columns', 'list'],
      ['sort', 'json'],
      ['highlight', 'column'],
      ['colorize', 'list'],
      ['extremes', 'boolean'],
      ['limit', 'number'],
    ])
    expect(presetOptions('price').map((o) => o.name)).toEqual(['data', 'candle', 'volume', 'events', 'levels', 'band', 'labels'])
    expect(presetOptions('heatmap').find((o) => o.name === 'palette')).toMatchObject({ input: 'select', options: ['diverging', 'sequential'] })
    expect(presetOptions('indicator').find((o) => o.name === 'rsi')).toMatchObject({ input: 'number', integer: true, min: 2, max: 100 })
    expect(presetOptions('stat').map((o) => o.input)).toEqual(['dataset', 'column', 'column', 'json'])
  })

  it('parses option text and keeps the view valid', () => {
    const limit = presetOptions('table').find((o) => o.name === 'limit')!
    expect(optionValue(limit, '25')).toBe(25)
    expect(optionValue(limit, '')).toBeUndefined()
    const cols = presetOptions('table').find((o) => o.name === 'columns')!
    expect(optionValue(cols, 'symbol, pe,market_cap')).toEqual(['symbol', 'pe', 'market_cap'])
    const sort = presetOptions('table').find((o) => o.name === 'sort')!
    expect(optionValue(sort, '{"column":"pe","dir":"asc"}')).toEqual({ column: 'pe', dir: 'asc' })
    expect(optionValue(sort, '{oops')).toBeUndefined()
    let view = setViewOption({ preset: 'table' }, 'extremes', true)
    expect(view).toEqual({ preset: 'table', extremes: true })
    view = setViewOption(view, 'limit', 0) // below the minimum: unchanged
    expect(view).toEqual({ preset: 'table', extremes: true })
    view = setViewOption(view, 'extremes', undefined)
    expect(view).toEqual({ preset: 'table' })
    expect(switchPreset({ preset: 'price', candle: true, data: 'main', labels: { MU: 'Micron' } }, 'compare')).toEqual({ preset: 'compare', data: 'main', labels: { MU: 'Micron' } })
    expect(switchPreset({ preset: 'price', candle: true }, 'table')).toEqual({ preset: 'table' })
  })
})

describe('rendering v2 widgets through the v1 views', () => {
  it('maps presets back to v1 views and builds a v1 widget when the kind query allows it', () => {
    expect(v1ViewFrom({ preset: 'compare', normalize: true })).toEqual({ type: 'series', normalize: true })
    expect(v1ViewFrom({ preset: 'compare', normalize: false })).toEqual({ type: 'series' })
    expect(v1ViewFrom({ preset: 'stat', column: 'pe' })).toEqual({ type: 'stat', column: 'pe' })
    expect(v1ViewFrom({ preset: 'heatmap' })).toBeUndefined()
    const w = toWidget({ ...draftFrom(v1), title: 'MU' })
    expect(legacyQueryOf(w)).toEqual(v1.query)
    expect(asV1Widget(w)).toEqual({ id: 'w1', title: 'MU', size: 'md', query: v1.query, view: { type: 'series', candle: true } })
    // a stat over ohlcv is not a v1 view: falls back to a v1 table
    expect(asV1Widget({ ...w, view: { preset: 'stat' } })?.view).toEqual({ type: 'table' })
    // no kind query: nothing to render with the v1 views
    expect(asV1Widget(v2)).toBeUndefined()
    // a migrated widget keeps its query, and its recipe main is not a kind query
    const migrated: AnyWidget = { id: 'm', title: 'Quote', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' }, query: { kind: 'quote', params: { symbols: ['MU'] } } }
    expect(asV1Widget(migrated)?.view).toEqual({ type: 'stat' })
  })
})
