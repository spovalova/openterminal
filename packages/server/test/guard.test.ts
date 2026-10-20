import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ConnectorRegistry, MemoryCache, type AgentRunner } from '@openterminal/core'
import { createApp } from '../src/app.js'
import { configPath, loadConfig, workspacesDir } from '../src/config.js'
import { allowedOriginsFromEnv, checkRequest } from '../src/guard.js'
import { startServer, type RunningServer } from '../src/main.js'
import { WorkspaceStore } from '../src/store/index.js'
import { createStubAgentRunner } from '../src/stub-agent.js'
import { fakeConnector, fakeRecipes } from './fake-connector.js'

describe('checkRequest', () => {
  const at = 'http://127.0.0.1:4242/api/workspaces'
  it('takes loopback hosts and refuses any other name (DNS rebinding)', () => {
    for (const url of [at, 'http://localhost:4242/', 'http://[::1]:4242/x', 'http://LOCALHOST:1/']) expect(checkRequest({ method: 'GET', url })).toBe(true)
    expect(checkRequest({ method: 'GET', url: 'http://evil.example:4242/api/workspaces' })).toMatch(/host evil.example is not this machine/)
    expect(checkRequest({ method: 'GET', url: 'http://192.168.1.5:4242/' })).toMatch(/not this machine/)
    expect(checkRequest({ method: 'GET', url: 'http://192.168.1.5:4242/' }, { hosts: ['192.168.1.5'] })).toBe(true)
  })

  it('lets only the server’s own origin (or none) change anything', () => {
    expect(checkRequest({ method: 'POST', url: at, origin: 'http://127.0.0.1:4242' })).toBe(true)
    expect(checkRequest({ method: 'POST', url: at })).toBe(true)
    expect(checkRequest({ method: 'GET', url: at, origin: 'https://evil.example' })).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(checkRequest({ method, url: at, origin: 'https://evil.example' })).toMatch(/origin https:\/\/evil.example/)
    // Another local port is another origin.
    expect(checkRequest({ method: 'PUT', url: at, origin: 'http://127.0.0.1:5173' })).toMatch(/may not change/)
    expect(checkRequest({ method: 'PUT', url: at, origin: 'http://localhost:4242' })).toMatch(/may not change/)
    expect(checkRequest({ method: 'PUT', url: at, origin: 'http://localhost:5173' }, { origins: ['http://localhost:5173/'] })).toBe(true)
    // The WebSocket upgrade is a GET that sends prompts: it counts as state-changing.
    expect(checkRequest({ method: 'GET', url: 'http://127.0.0.1:4242/ws', origin: 'https://evil.example', upgrade: 'websocket' })).toMatch(/may not change/)
    expect(checkRequest({ method: 'GET', url: 'http://127.0.0.1:4242/ws', origin: 'http://127.0.0.1:4242', upgrade: 'websocket' })).toBe(true)
    // The Host header wins over a placeholder URL (how the WebSocket upgrade arrives).
    expect(checkRequest({ method: 'GET', url: 'http://localhost/ws', host: '127.0.0.1:4242', origin: 'http://127.0.0.1:4242', upgrade: 'websocket' })).toBe(true)
    expect(checkRequest({ method: 'GET', url: 'http://localhost/ws', host: 'evil.example:4242', upgrade: 'websocket' })).toMatch(/not this machine/)
  })

  it('reads extra origins from OPENTERMINAL_ALLOWED_ORIGINS', () => {
    expect(allowedOriginsFromEnv({ OPENTERMINAL_ALLOWED_ORIGINS: ' http://localhost:5173, http://127.0.0.1:5173 ,' })).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
    expect(allowedOriginsFromEnv({})).toEqual([])
  })
})

describe('the app behind the guard, and the LLM key route', () => {
  let home: string
  let app: ReturnType<typeof createApp>['app']
  const made: { provider: string; model: string; apiKey: string }[] = []
  const realAgent: AgentRunner = { run: async () => ({ text: 'real agent' }) } as unknown as AgentRunner

  beforeEach(() => {
    made.length = 0
    home = mkdtempSync(join(tmpdir(), 'openterminal-guard-'))
    loadConfig({ home, env: {} })
    const registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: fakeRecipes() })
    registry.register(fakeConnector(), {})
    const store = new WorkspaceStore(workspacesDir(home))
    app = createApp({
      registry,
      store,
      agent: createStubAgentRunner(),
      home,
      llm: false,
      webDist: join(home, 'no-dist'),
      makeAgent: (llm) => {
        made.push(llm)
        return realAgent
      },
    }).app
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const put = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('http://127.0.0.1:4242/api/llm', { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4242', ...headers }, body: JSON.stringify(body) })

  it('refuses a foreign Host or Origin with 403', async () => {
    expect((await app.request('http://evil.example:4242/api/health')).status).toBe(403)
    const cross = await app.request('http://127.0.0.1:4242/api/workspaces', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ error: 'forbidden: origin https://evil.example may not change anything here' })
    expect((await put({ provider: 'anthropic', apiKey: 'sk-ant-x' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect(readFileSync(configPath(home), 'utf8')).not.toContain('sk-ant-x')
    expect((await app.request('http://127.0.0.1:4242/api/workspaces', { method: 'POST', headers: { origin: 'http://127.0.0.1:4242' }, body: '{}' })).status).toBe(201)
  })

  it('saves a key to config.yml (mode 600), never answers with it, and switches the agent on without a restart', async () => {
    expect(await (await app.request('/api/llm')).json()).toEqual({ configured: false, providers: ['anthropic', 'openai'] })
    expect((await put({ provider: 'anthropic' })).status).toBe(400)
    expect((await put({ provider: 'mistral', apiKey: 'k' })).status).toBe(400)

    const res = await put({ provider: 'anthropic', apiKey: '  sk-ant-dummy-123  ' })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('sk-ant-dummy-123')
    expect(JSON.parse(text)).toEqual({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(made).toEqual([{ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-dummy-123' }])
    expect(readFileSync(configPath(home), 'utf8')).toMatch(/^ {2}apiKey: sk-ant-dummy-123$/m)
    if (process.platform !== 'win32') expect(statSync(configPath(home)).mode & 0o777).toBe(0o600)

    expect(((await (await app.request('/api/health')).json()) as { llm: boolean }).llm).toBe(true)
    const info = await (await app.request('/api/llm')).text()
    expect(info).not.toContain('sk-ant')
    expect(JSON.parse(info)).toEqual({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5', providers: ['anthropic', 'openai'] })
  })
})

describe('the WebSocket behind the guard', () => {
  let home: string
  let running: RunningServer
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openterminal-guard-ws-'))
    const registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: fakeRecipes() })
    registry.register(fakeConnector(), {})
    running = await startServer({ home, port: 0, env: {}, registry, agent: createStubAgentRunner(), webDist: false, log: () => {} })
  })
  afterAll(async () => {
    await running.close()
    rmSync(home, { recursive: true, force: true })
  })

  const connect = (origin?: string) =>
    new Promise<'open' | number>((resolve) => {
      const ws = new WebSocket(running.url.replace('http', 'ws') + '/ws', origin ? { origin } : {})
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(0))
    })

  it('accepts its own origin or none, refuses a foreign page', async () => {
    expect(await connect()).toBe('open')
    expect(await connect(running.url)).toBe('open')
    expect(await connect('https://evil.example')).toBe(403)
  })
})
