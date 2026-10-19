import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ConnectorRegistry, MemoryCache, type ServerMsg } from '@openterminal/core'
import { startServer, type RunningServer } from '../src/main.js'
import { createStubAgentRunner } from '../src/stub-agent.js'
import { fakeConnector, fakeRecipes, type Call } from './fake-connector.js'

let home: string
let running: RunningServer
const calls: Call[] = []

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'terminal-ws-'))
  const registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: fakeRecipes() })
  registry.register(fakeConnector({ calls }), {})
  running = await startServer({ home, port: 0, env: {}, registry, agent: createStubAgentRunner(), webDist: false, log: () => {} })
})
afterAll(async () => {
  await running.close()
  rmSync(home, { recursive: true, force: true })
})

function connect(): Promise<{ ws: WebSocket; received: ServerMsg[]; next: (pred: (m: ServerMsg) => boolean) => Promise<ServerMsg> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(running.url.replace('http', 'ws') + '/ws')
    const received: ServerMsg[] = []
    const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMsg
      received.push(m)
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(m)
        }
      }
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        ws,
        received,
        next: (pred) =>
          new Promise((res, rej) => {
            const hit = received.find(pred)
            if (hit) return res(hit)
            waiters.push({ pred, resolve: res })
            setTimeout(() => rej(new Error('timed out waiting for message')), 5000).unref()
          }),
      }),
    )
  })
}

async function createWorkspace(name = 'Untitled') {
  const res = await fetch(`${running.url}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
  return (await res.json()) as { id: string }
}

describe('websocket', () => {
  it('prompt: started → step → widgets → frame… → done, and persists the workspace', async () => {
    const { ws, received, next } = await connect()
    const { id } = await createWorkspace()
    ws.send(JSON.stringify({ t: 'focus', workspaceId: id }))
    ws.send(JSON.stringify({ t: 'prompt', workspaceId: id, text: "What's happening with memory?" }))
    const done = await next((m) => m.t === 'done')
    const order = received.map((m) => m.t)
    expect(order[0]).toBe('started')
    expect(order.filter((t) => t === 'step')).toHaveLength(2)
    expect(order.indexOf('step')).toBeLessThan(order.indexOf('widgets'))
    expect(order.indexOf('widgets')).toBeLessThan(order.indexOf('frame'))
    // Five live frames, then (taste round 2, change 5) the same five again marked as the reply's held snapshot.
    const frames = received.filter((m): m is Extract<ServerMsg, { t: 'frame' }> => m.t === 'frame')
    expect(frames.filter((m) => m.frame.meta.heldAt === undefined)).toHaveLength(5)
    expect(frames.filter((m) => m.frame.meta.heldAt !== undefined)).toHaveLength(5)
    expect(order.filter((t) => t === 'frameError')).toHaveLength(0)
    expect(order.at(-1)).toBe('done')
    if (done.t !== 'done') throw new Error('unreachable')
    expect(done.message.role).toBe('agent')
    expect(done.message.text).toContain('[[widget:memory-3mo]]')
    expect(done.message.steps).toHaveLength(2)

    const widgetsMsg = received.find((m) => m.t === 'widgets')
    expect(widgetsMsg && widgetsMsg.t === 'widgets' && widgetsMsg.name).toBe('Memory')

    const saved = (await (await fetch(`${running.url}/api/workspaces/${id}`)).json()) as { name: string; widgets: unknown[]; messages: { role: string }[] }
    expect(saved.name).toBe('Memory')
    expect(saved.widgets).toHaveLength(5)
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'agent'])
    ws.close()
  })

  it('refresh re-runs one widget bypassing the cache', async () => {
    const { ws, next } = await connect()
    const { id } = await createWorkspace()
    ws.send(JSON.stringify({ t: 'prompt', workspaceId: id, text: 'memory' }))
    await next((m) => m.t === 'done')
    const before = calls.filter((c) => c.route === 'quote').length
    ws.send(JSON.stringify({ t: 'refresh', widgetId: 'memory-snapshot' }))
    const frame = await next((m) => m.t === 'frame' && m.widgetId === 'memory-snapshot' && calls.filter((c) => c.route === 'quote').length > before)
    expect(frame.t).toBe('frame')
    expect(calls.filter((c) => c.route === 'quote').length).toBe(before + 1)
    ws.send(JSON.stringify({ t: 'refresh', widgetId: 'does-not-exist' }))
    const err = await next((m) => m.t === 'frameError' && m.widgetId === 'does-not-exist')
    expect(err.t === 'frameError' && err.error).toMatch(/not found/)
    ws.close()
  })

  it('focus runs the focused workspace widgets; unknown workspace fails', async () => {
    const { ws, next, received } = await connect()
    const { id } = await createWorkspace()
    ws.send(JSON.stringify({ t: 'prompt', workspaceId: id, text: 'memory' }))
    await next((m) => m.t === 'done')
    received.length = 0
    ws.send(JSON.stringify({ t: 'focus', workspaceId: id }))
    await next((m) => m.t === 'frame' && m.widgetId === 'memory-news')
    expect(received.filter((m) => m.t === 'frame').length).toBeGreaterThanOrEqual(1)
    ws.send(JSON.stringify({ t: 'focus', workspaceId: 'missing' }))
    const failed = await next((m) => m.t === 'failed')
    expect(failed.t === 'failed' && failed.error).toMatch(/not found/)
    ws.close()
  })

  it('one snapshot (taste round 2, change 5): a returning client sees the reply\'s held frames without a fetch until it asks for live data', async () => {
    const first = await connect()
    const { id } = await createWorkspace()
    first.ws.send(JSON.stringify({ t: 'prompt', workspaceId: id, text: 'memory' }))
    const done = await first.next((m) => m.t === 'done')
    first.ws.close()
    const at = done.t === 'done' ? done.message.at : undefined
    // A new socket focusing the workspace gets the held frames, as of the reply, and fetches nothing.
    const before = calls.length
    const second = await connect()
    second.ws.send(JSON.stringify({ t: 'focus', workspaceId: id }))
    const held = await second.next((m) => m.t === 'frame' && m.widgetId === 'memory-snapshot')
    expect(held.t === 'frame' && held.frame.meta.heldAt).toBe(at)
    await second.next((m) => m.t === 'frame' && m.widgetId === 'memory-news')
    expect(calls.length).toBe(before)
    // The HTTP fallback a page uses before its socket opens serves the held frame too, never a live one over it.
    const viaHttp = (await (await fetch(`${running.url}/api/widgets/memory-snapshot/frame?workspace=${id}`)).json()) as { meta: { heldAt?: number } }
    expect(viaHttp.meta.heldAt).toBe(at)
    // "Live data" releases every widget: fresh frames, not held.
    second.ws.send(JSON.stringify({ t: 'live', workspaceId: id }))
    const live = await second.next((m) => m.t === 'frame' && m.widgetId === 'memory-snapshot' && m.frame.meta.heldAt === undefined)
    expect(live.t).toBe('frame')
    // and the release is stored: the next focus is live from the start
    second.received.length = 0
    second.ws.send(JSON.stringify({ t: 'focus', workspaceId: id }))
    const again = await second.next((m) => m.t === 'frame' && m.widgetId === 'memory-snapshot')
    expect(again.t === 'frame' && again.frame.meta.heldAt).toBeUndefined()
    second.ws.close()
  })

  it('prompt on a missing workspace fails and invalid messages are ignored', async () => {
    const { ws, next } = await connect()
    ws.send('not json')
    ws.send(JSON.stringify({ t: 'bogus' }))
    ws.send(JSON.stringify({ t: 'prompt', workspaceId: 'missing', text: 'x' }))
    const failed = await next((m) => m.t === 'failed')
    expect(failed.t === 'failed' && failed.error).toMatch(/not found/)
    ws.close()
  })
})
