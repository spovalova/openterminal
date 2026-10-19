import { describe, expect, it } from 'vitest'
import { type AnyWidget, type Frame } from '@terminal/core'
import {
  datasetKind,
  draftFrom,
  emptyDraft,
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
} from '../editor-model'

const bars = { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }
const v1: AnyWidget = { id: 'w1', title: 'MU daily', size: 'md', data: { main: bars }, view: { preset: 'price', candle: true } }

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
  it('opens a one-dataset widget and saves it back unchanged', () => {
    const d = draftFrom(v1)
    expect(d.data).toEqual({ main: bars })
    expect(d.view).toEqual({ preset: 'price', candle: true })
    const w = toWidget({ ...d, title: 'MU candles' })
    expect(w).toEqual({ id: 'w1', title: 'MU candles', size: 'md', data: { main: bars }, view: { preset: 'price', candle: true } })
    expect(datasetKind(w.data.main!)).toBe('recipe')
  })

  it('opens a multi-dataset widget as it is, fields included', () => {
    const d = draftFrom(v2)
    expect(Object.keys(d.data)).toEqual(['price', 'eps', 'main'])
    expect(d.fields).toEqual({ pe: { label: 'P/E' } })
    expect(toWidget(d)).toEqual(v2)
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
    expect(nextDatasetName({ main: bars })).toBe('data2')
    expect(nextDatasetName({ main: bars, data2: bars }, 'data')).toBe('data3')
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
    const d = { data: { main: bars }, view: { preset: 'table' as const } }
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
