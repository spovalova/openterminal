import { describe, expect, it } from 'vitest'
import { ClientMsgSchema, DEFAULT_DATASET, ServerMsgSchema, StepSchema, frameDataset, frameKey, type Frame } from '../src/index.js'

const frame: Frame = { columns: [{ name: 'x', type: 'number' }], rows: [[1]], meta: { connector: 'c', fetchedAt: 0, ttl: 0 } }

describe('widgets message', () => {
  it('carries v2 widgets (data graph and preset) beside v1 ones (phase 2 integration: the agent emits WidgetV2[])', () => {
    const v2 = { id: 'w1', title: 'NVDA', size: 'lg', data: { main: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } } }, view: { preset: 'price', candle: true } }
    const v1 = { id: 'w2', title: 'Quotes', size: 'sm', query: { kind: 'quote', params: { symbols: ['NVDA'] } }, view: { type: 'table' } }
    const m = ServerMsgSchema.parse({ t: 'widgets', workspaceId: 'ws', widgets: [v2, v1], name: 'NVDA' })
    if (m.t !== 'widgets') throw new Error()
    expect(m.widgets).toHaveLength(2)
    expect('data' in m.widgets[0]! && m.widgets[0].view).toMatchObject({ preset: 'price' })
    expect(() => ServerMsgSchema.parse({ t: 'widgets', workspaceId: 'ws', widgets: [{ id: 'w1', title: 'x', size: 'lg', view: { preset: 'price' } }] })).toThrow()
  })
})

describe('frame messages', () => {
  it('reads the v1 frame message and defaults the dataset to main', () => {
    const m = ServerMsgSchema.parse({ t: 'frame', widgetId: 'w1', frame })
    expect(m.t).toBe('frame')
    if (m.t !== 'frame') throw new Error()
    expect(m.workspaceId).toBeUndefined()
    expect(frameDataset(m)).toBe(DEFAULT_DATASET)
    expect(frameKey(m)).toBe('/w1/main')
  })
  it('carries workspaceId and dataset on v2 frame and frameError messages', () => {
    const m = ServerMsgSchema.parse({ t: 'frame', workspaceId: 'ws', widgetId: 'w1', dataset: 'eps', frame })
    if (m.t !== 'frame') throw new Error()
    expect(frameKey(m)).toBe('ws/w1/eps')
    const e = ServerMsgSchema.parse({ t: 'frameError', workspaceId: 'ws', widgetId: 'w1', dataset: 'price', error: 'boom' })
    if (e.t !== 'frameError') throw new Error()
    expect(frameDataset(e)).toBe('price')
    expect(frameKey({ workspaceId: 'ws', widgetId: 'w1' })).toBe('ws/w1/main')
  })
  it('accepts a dataset on refresh and the new tool names on steps', () => {
    expect(ClientMsgSchema.parse({ t: 'refresh', widgetId: 'w1', workspaceId: 'ws', dataset: 'eps' })).toMatchObject({ dataset: 'eps' })
    expect(ClientMsgSchema.parse({ t: 'refresh', widgetId: 'w1' })).toEqual({ t: 'refresh', widgetId: 'w1' })
    expect(StepSchema.parse({ tool: 'find_route', args: { query: 'bond yields' }, summary: 'find_route bond yields', ms: 3 }).tool).toBe('find_route')
    expect(StepSchema.parse({ tool: 'transform', args: {}, summary: 't', ms: 3 }).tool).toBe('transform')
    expect(() => StepSchema.parse({ tool: 'nope', args: {}, summary: 't', ms: 3 })).toThrow()
  })
  it('carries frames with v2 meta (fields and lineage) and without', () => {
    const v2: Frame = { ...frame, meta: { ...frame.meta, fields: { x: { unit: 'usd', label: 'X' } }, lineage: { connector: 'c', route: 'r', params: { a: 1 } } } }
    const m = ServerMsgSchema.parse({ t: 'frame', widgetId: 'w1', frame: v2 })
    if (m.t !== 'frame') throw new Error()
    expect(m.frame.meta.fields).toEqual({ x: { unit: 'usd', label: 'X' } })
    expect(m.frame.meta.lineage).toEqual({ connector: 'c', route: 'r', params: { a: 1 } })
    expect(() => ServerMsgSchema.parse({ t: 'frame', widgetId: 'w1', frame: { ...frame, meta: { ...frame.meta, fields: { x: { unit: 'parsecs' } } } } })).toThrow()
  })
})
