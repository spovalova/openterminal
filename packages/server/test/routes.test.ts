import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorRegistry, MemoryCache } from '@terminal/core'
import { createApp } from '../src/app.js'
import { loadConfig, workspacesDir } from '../src/config.js'
import { WorkspaceStore } from '../src/store.js'
import { createStubAgentRunner, stubWidgets } from '../src/stub-agent.js'
import { fakeConnector } from './fake-connector.js'

let home: string
let app: ReturnType<typeof createApp>['app']
let registry: ConnectorRegistry

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-routes-'))
  loadConfig({ home, env: {} })
  registry = new ConnectorRegistry({ cache: new MemoryCache() })
  registry.register(fakeConnector(), {})
  const store = new WorkspaceStore(workspacesDir(home))
  app = createApp({ registry, store, agent: createStubAgentRunner(), home, llm: false, webDist: join(home, 'no-dist') }).app
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const body = async (res: Response): Promise<any> => res.json()
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('routes', () => {
  it('GET /api/health', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, kinds: ['search', 'quote', 'ohlcv', 'news', 'earnings'], llm: false })
  })

  it('workspaces CRUD', async () => {
    expect(await body(await app.request('/api/workspaces'))).toEqual([])
    const created = await app.request('/api/workspaces', json({ name: 'Memory' }))
    expect(created.status).toBe(201)
    const ws = await body(created)
    expect(ws.name).toBe('Memory')
    expect(ws.widgets).toEqual([])

    expect((await app.request(`/api/workspaces/${ws.id}`)).status).toBe(200)
    expect((await app.request('/api/workspaces/nope')).status).toBe(404)

    const widgets = stubWidgets()
    const patched = await app.request(`/api/workspaces/${ws.id}`, json({ widgets, name: 'Memory 2' }, 'PATCH'))
    expect(patched.status).toBe(200)
    expect((await body(patched)).widgets).toHaveLength(5)

    const bad = await app.request(`/api/workspaces/${ws.id}`, json({ name: '' }, 'PATCH'))
    expect(bad.status).toBe(400)
    const notJson = await app.request('/api/workspaces', { method: 'POST', body: '{oops' })
    expect(notJson.status).toBe(400)

    expect((await app.request('/api/workspaces')).ok).toBe(true)
    expect(await body(await app.request('/api/workspaces'))).toHaveLength(1)

    expect((await app.request(`/api/workspaces/${ws.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(`/api/workspaces/${ws.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('GET /api/widgets/:id/frame runs the widget query', async () => {
    const ws = await body(await app.request('/api/workspaces', json({ name: 'Memory', widgets: stubWidgets() })))
    expect(ws.widgets).toHaveLength(5)
    const res = await app.request('/api/widgets/memory-snapshot/frame')
    expect(res.status).toBe(200)
    const frame = await body(res)
    expect(frame.columns.map((c: { name: string }) => c.name)).toEqual(['symbol', 'price', 'change_pct', 'volume', 'market_state', 'extended_price', 'extended_change_pct'])
    expect(frame.rows).toHaveLength(4)
    expect(frame.meta.connector).toBe('fake')
    expect((await app.request('/api/widgets/missing/frame')).status).toBe(404)
  })

  it('GET /api/connectors lists built-ins with status and key requirement', async () => {
    const list = await body(await app.request('/api/connectors'))
    const names = list.map((c: { name: string }) => c.name)
    expect(names).toEqual(['fake', 'yahoo', 'finnhub'])
    const finnhub = list.find((c: { name: string }) => c.name === 'finnhub')
    expect(finnhub.configured).toBe(false)
    expect(finnhub.status).toBe('missing_config')
    expect(typeof finnhub.needsKey).toBe('boolean')
  })

  it('PUT /api/connectors/:name/config writes config.yml and registers live', async () => {
    expect((await app.request('/api/connectors/nope/config', json({}, 'PUT'))).status).toBe(404)
    expect((await app.request('/api/connectors/yahoo/config', json([], 'PUT'))).status).toBe(400)
    const res = await app.request('/api/connectors/yahoo/config', json({}, 'PUT'))
    expect(res.status).toBe(200)
    const info = await body(res)
    expect(info).toMatchObject({ name: 'yahoo', configured: true })
    expect(loadConfig({ home, env: {} }).connectors.map((c) => c.name)).toEqual(['yahoo'])
    expect(registry.connectors().map((c) => c.name)).toEqual(['fake', 'yahoo'])
  })

  it('unknown /api routes are 404 JSON', async () => {
    const res = await app.request('/api/nothing')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})
