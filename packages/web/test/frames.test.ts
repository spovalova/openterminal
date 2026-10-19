import { describe, expect, it } from 'vitest'
import { frameKey, type Frame, type WidgetV2 } from '@openterminal/core'
import { dropWidgetFrames, errorFor, framesComplete, framesFor, hasAnyFrame, parseFrameKey, putFrame, putFrameError } from '../src/state/frames'

const one: WidgetV2 = { id: 'w1', title: 'Quote', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'table' } }
const two: WidgetV2 = {
  id: 'w1',
  title: 'Price',
  size: 'lg',
  data: { main: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } }, events: { recipe: 'eps_history', params: { symbols: ['NVDA'] } } },
  view: { preset: 'price', events: 'events' },
}
const frame = (connector: string, rows: unknown[][] = []): Frame => ({ columns: [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }], rows, meta: { connector, fetchedAt: 0, ttl: 10_000 } })
const quote = frame('yahoo', [['MU', 100]])
const bars = frame('openbb')

describe('frame keys (PLAN.md section 17, feature 8)', () => {
  it('keys by workspace, widget and dataset, with the defaults, and parses back', () => {
    expect(frameKey({ widgetId: 'w1' })).toBe('/w1/main')
    expect(frameKey({ workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' })).toBe('ws1/w1/events')
    expect(parseFrameKey('ws1/w1/events')).toEqual({ workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' })
    expect(parseFrameKey('/w1/main')).toEqual({ workspaceId: undefined, widgetId: 'w1', dataset: 'main' })
  })

  it("a widget reads its own workspace's frame, not another workspace's widget with the same id", () => {
    let store = putFrame({}, {}, { workspaceId: 'ws2', widgetId: 'w1' }, bars).frames
    expect(framesFor(store, 'ws1', one)).toEqual({})
    store = putFrame(store, {}, { workspaceId: 'ws1', widgetId: 'w1' }, quote).frames
    expect(framesFor(store, 'ws1', one)).toEqual({ main: quote })
    expect(framesFor(store, 'ws2', one)).toEqual({ main: bars })
  })

  it('falls back to the bare key when a frame arrived without a workspace', () => {
    const store = putFrame({}, {}, { widgetId: 'w1' }, quote).frames
    expect(framesFor(store, 'ws1', one)).toEqual({ main: quote })
    expect(hasAnyFrame(store, 'ws1', 'w1')).toBe(true)
    expect(hasAnyFrame(store, 'ws1', 'w2')).toBe(false)
  })

  it('collects one frame per dataset of a multi-dataset widget and knows when the set is complete', () => {
    let store = putFrame({}, {}, { workspaceId: 'ws1', widgetId: 'w1', dataset: 'main' }, bars).frames
    expect(framesFor(store, 'ws1', two)).toEqual({ main: bars })
    expect(framesComplete(two, framesFor(store, 'ws1', two))).toBe(false)
    store = putFrame(store, {}, { workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' }, quote).frames
    expect(Object.keys(framesFor(store, 'ws1', two))).toEqual(['main', 'events'])
    expect(framesComplete(two, framesFor(store, 'ws1', two))).toBe(true)
  })

  it('a frame clears the error for its key; errors read per widget with the same fallback', () => {
    let errors = putFrameError({}, { workspaceId: 'ws1', widgetId: 'w1' }, 'boom')
    expect(errorFor(errors, 'ws1', one)).toBe('boom')
    expect(errorFor(errors, 'ws2', one)).toBeUndefined()
    errors = putFrame({}, errors, { workspaceId: 'ws1', widgetId: 'w1' }, quote).frameErrors
    expect(errorFor(errors, 'ws1', one)).toBeUndefined()
    errors = putFrameError({}, { widgetId: 'w1' }, 'bare boom')
    expect(errorFor(errors, 'ws1', one)).toBe('bare boom')
  })

  it("drops a widget's frames under its workspace and the bare key, every dataset, and leaves other workspaces alone", () => {
    let store = putFrame({}, {}, { workspaceId: 'ws1', widgetId: 'w1', dataset: 'main' }, bars).frames
    store = putFrame(store, {}, { workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' }, quote).frames
    store = putFrame(store, {}, { widgetId: 'w1' }, quote).frames
    store = putFrame(store, {}, { workspaceId: 'ws2', widgetId: 'w1' }, quote).frames
    store = putFrame(store, {}, { workspaceId: 'ws1', widgetId: 'w2' }, quote).frames
    const next = dropWidgetFrames(store, 'ws1', 'w1')
    expect(Object.keys(next).sort()).toEqual(['ws1/w2/main', 'ws2/w1/main'])
    expect(dropWidgetFrames(next, 'ws1', 'nope')).toBe(next)
  })
})
