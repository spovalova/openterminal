import { describe, expect, it } from 'vitest'
import { createWorkspace, toFrame, type ServerMsg, type Widget } from '@terminal/core'
import { initialState, layoutFor, reducer, workspaceState, type Action, type AppState } from '../src/state'

const widget: Widget = {
  id: 'w1',
  title: 'Memory names, 3 months rebased',
  size: 'lg',
  query: { kind: 'ohlcv', params: { symbols: ['MU', 'SNDK'], interval: '1d', range: '3mo' } },
  view: { type: 'series', normalize: true },
}
const widget2: Widget = { id: 'w2', title: 'Basket snapshot', size: 'md', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }

function boot(): AppState {
  const ws = createWorkspace({ id: 'ws1', now: 1000 })
  let s = reducer(initialState, { type: 'workspaces', workspaces: [ws] })
  s = reducer(s, { type: 'activate', id: 'ws1' })
  return s
}

const server = (msg: ServerMsg, now = 5000): Action => ({ type: 'server', msg, now })

describe('reducer: prompt message sequence', () => {
  it('walks started → step → widgets → frame → delta → done', () => {
    let s = boot()
    expect(workspaceState(s, 'ws1').status).toBe('empty')
    expect(layoutFor(s.workspaces[0], workspaceState(s, 'ws1'))).toBe('empty')

    s = reducer(s, { type: 'promptSent', workspaceId: 'ws1', text: "What's happening with memory?" })
    expect(workspaceState(s, 'ws1').sending).toBe(true)
    expect(workspaceState(s, 'ws1').status).toBe('empty')

    s = reducer(s, server({ t: 'started', workspaceId: 'ws1' }, 1000))
    expect(workspaceState(s, 'ws1').status).toBe('streaming')
    expect(workspaceState(s, 'ws1').sending).toBe(false)
    expect(layoutFor(s.workspaces[0], workspaceState(s, 'ws1'))).toBe('active')

    const step = { tool: 'query' as const, args: { kind: 'ohlcv' }, summary: 'ohlcv MU, SNDK 1d 3mo · 126 rows', ms: 420 }
    s = reducer(s, server({ t: 'step', workspaceId: 'ws1', step }))
    expect(workspaceState(s, 'ws1').steps).toEqual([step])

    s = reducer(s, server({ t: 'widgets', workspaceId: 'ws1', widgets: [widget, widget2], name: 'Memory' }))
    expect(s.workspaces[0]!.widgets.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(s.workspaces[0]!.name).toBe('Memory')
    expect(s.frames).toEqual({})

    const frame = toFrame('quote', [{ symbol: 'MU', price: 100 }], { connector: 'yahoo' })
    s = reducer(s, server({ t: 'frame', widgetId: 'w2', frame }))
    expect(s.frames.w2).toBe(frame)
    s = reducer(s, server({ t: 'frameError', widgetId: 'w1', error: 'boom' }))
    expect(s.frameErrors.w1).toBe('boom')

    s = reducer(s, server({ t: 'delta', workspaceId: 'ws1', text: 'Over three months ' }))
    s = reducer(s, server({ t: 'delta', workspaceId: 'ws1', text: 'MU is up 12%. [[widget:w1]]' }))
    expect(workspaceState(s, 'ws1').streamingText).toBe('Over three months MU is up 12%. [[widget:w1]]')

    const message = { role: 'agent' as const, text: 'Over three months MU is up 12%. [[widget:w1]]', steps: [step] }
    s = reducer(s, server({ t: 'done', workspaceId: 'ws1', message }, 13_000))
    const ws = workspaceState(s, 'ws1')
    expect(ws.status).toBe('active')
    expect(ws.streamingText).toBe('')
    expect(ws.steps).toEqual([])
    expect(ws.prompt).toBeNull()
    expect(ws.lastRunMs).toBe(12_000)
    const messages = s.workspaces[0]!.messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(messages[0]!.text).toBe("What's happening with memory?")
    expect(messages[1]!.text).toBe(message.text)
  })

  it('a later widgets message overwrites the set and drops stale frames', () => {
    let s = boot()
    s = reducer(s, server({ t: 'widgets', workspaceId: 'ws1', widgets: [widget, widget2] }))
    s = reducer(s, server({ t: 'frame', widgetId: 'w1', frame: toFrame('ohlcv', []) }))
    s = reducer(s, server({ t: 'frame', widgetId: 'w2', frame: toFrame('quote', []) }))
    const w3: Widget = { ...widget2, id: 'w3' }
    s = reducer(s, server({ t: 'widgets', workspaceId: 'ws1', widgets: [widget2, w3] }))
    expect(s.workspaces[0]!.widgets.map((w) => w.id)).toEqual(['w2', 'w3'])
    expect(Object.keys(s.frames)).toEqual(['w2'])
  })

  it('failed moves to error, keeps the prompt for retry, and promptSent clears it', () => {
    let s = boot()
    s = reducer(s, { type: 'promptSent', workspaceId: 'ws1', text: 'MU' })
    s = reducer(s, server({ t: 'started', workspaceId: 'ws1' }))
    s = reducer(s, server({ t: 'failed', workspaceId: 'ws1', error: 'no connector answers kind "news"' }))
    let ws = workspaceState(s, 'ws1')
    expect(ws.status).toBe('error')
    expect(ws.lastError).toBe('no connector answers kind "news"')
    expect(ws.prompt).toBe('MU')
    expect(layoutFor(s.workspaces[0], ws)).toBe('empty')

    s = reducer(s, { type: 'promptSent', workspaceId: 'ws1', text: 'MU' })
    ws = workspaceState(s, 'ws1')
    expect(ws.status).toBe('empty')
    expect(ws.lastError).toBeNull()
    expect(ws.sending).toBe(true)
  })

  it('restores status from a persisted workspace and removes frames with a deleted workspace', () => {
    const ws = { ...createWorkspace({ id: 'ws2', name: 'Morning' }), widgets: [widget2] }
    let s = reducer(initialState, { type: 'workspaces', workspaces: [ws] })
    expect(workspaceState(s, 'ws2').status).toBe('active')
    expect(s.activeId).toBe('ws2')
    s = reducer(s, { type: 'frameLoaded', widgetId: 'w2', frame: toFrame('quote', []) })
    s = reducer(s, { type: 'removeWorkspace', id: 'ws2' })
    expect(s.workspaces).toEqual([])
    expect(s.frames).toEqual({})
    expect(s.activeId).toBeNull()
  })
})
