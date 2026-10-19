import { describe, expect, it } from 'vitest'
import { frameKey, toFrame, type Widget, type WidgetV2 } from '@terminal/core'
import { dropWidgetFrames, errorFor, frameMatches, framesComplete, framesFor, hasAnyFrame, parseFrameKey, putFrame, putFrameError } from '../src/state/frames'

const v1: Widget = { id: 'w1', title: 'Quote', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }
const v2: WidgetV2 = {
  id: 'w1',
  title: 'Price',
  size: 'lg',
  data: { main: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } }, events: { recipe: 'eps_history', params: { symbols: ['NVDA'] } } },
  view: { preset: 'price', events: 'events' },
}
const quote = toFrame('quote', [{ symbol: 'MU', price: 100 }], { connector: 'yahoo' })
const bars = toFrame('ohlcv', [], { connector: 'yahoo' })

describe('frame keys (PLAN.md section 17, feature 8)', () => {
  it('keys by workspace, widget and dataset, with the v1 defaults, and parses back', () => {
    expect(frameKey({ widgetId: 'w1' })).toBe('/w1/main')
    expect(frameKey({ workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' })).toBe('ws1/w1/events')
    expect(parseFrameKey('ws1/w1/events')).toEqual({ workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' })
    expect(parseFrameKey('/w1/main')).toEqual({ workspaceId: undefined, widgetId: 'w1', dataset: 'main' })
  })

  it('a widget reads its own workspace\'s frame, not another workspace\'s widget with the same id', () => {
    let store = putFrame({}, {}, { workspaceId: 'ws2', widgetId: 'w1' }, bars).frames
    expect(framesFor(store, 'ws1', v1)).toEqual({})
    store = putFrame(store, {}, { workspaceId: 'ws1', widgetId: 'w1' }, quote).frames
    expect(framesFor(store, 'ws1', v1)).toEqual({ main: quote })
    expect(framesFor(store, 'ws2', v1)).toEqual({}) // ws2's frame is an ohlcv frame: frameMatches rejects it for a quote widget
  })

  it('falls back to the bare v1 key, guarded by frameMatches', () => {
    const store = putFrame({}, {}, { widgetId: 'w1' }, quote).frames
    expect(framesFor(store, 'ws1', v1)).toEqual({ main: quote })
    expect(frameMatches(v1, quote)).toBe(true)
    expect(frameMatches(v1, bars)).toBe(false)
    expect(frameMatches(v2, bars)).toBe(true)
    expect(hasAnyFrame(store, 'ws1', 'w1')).toBe(true)
    expect(hasAnyFrame(store, 'ws1', 'w2')).toBe(false)
  })

  it('collects one frame per dataset of a v2 widget and knows when the set is complete', () => {
    let store = putFrame({}, {}, { workspaceId: 'ws1', widgetId: 'w1', dataset: 'main' }, bars).frames
    expect(framesFor(store, 'ws1', v2)).toEqual({ main: bars })
    expect(framesComplete(v2, framesFor(store, 'ws1', v2))).toBe(false)
    store = putFrame(store, {}, { workspaceId: 'ws1', widgetId: 'w1', dataset: 'events' }, quote).frames
    expect(Object.keys(framesFor(store, 'ws1', v2))).toEqual(['main', 'events'])
    expect(framesComplete(v2, framesFor(store, 'ws1', v2))).toBe(true)
  })

  it('a frame clears the error for its key; errors read per widget with the same fallback', () => {
    let errors = putFrameError({}, { workspaceId: 'ws1', widgetId: 'w1' }, 'boom')
    expect(errorFor(errors, 'ws1', v1)).toBe('boom')
    expect(errorFor(errors, 'ws2', v1)).toBeUndefined()
    errors = putFrame({}, errors, { workspaceId: 'ws1', widgetId: 'w1' }, quote).frameErrors
    expect(errorFor(errors, 'ws1', v1)).toBeUndefined()
    errors = putFrameError({}, { widgetId: 'w1' }, 'v1 boom')
    expect(errorFor(errors, 'ws1', v1)).toBe('v1 boom')
  })

  it('drops a widget\'s frames under its workspace and the bare key, every dataset, and leaves other workspaces alone', () => {
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
