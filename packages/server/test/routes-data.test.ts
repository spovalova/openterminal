import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorRegistry, MemoryCache, isWidgetV2, type Recipe } from '@terminal/core'
import { builtinRecipes } from '@terminal/core/node'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { exportDocument, recipeNamesIn, recipesPath } from '../src/routes-data.js'
import { SqliteStore } from '../src/store/index.js'
import { createStubAgentRunner, stubWidgets } from '../src/stub-agent.js'
import { fakeConnector } from './fake-connector.js'

let home: string
let app: ReturnType<typeof createApp>['app']
let registry: ConnectorRegistry
let store: SqliteStore
let probe: ((opts: { connector?: string }) => Promise<{ probed: number; alive: number; dead: number; ms: number }>) | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-data-routes-'))
  loadConfig({ home, env: {} })
  registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: builtinRecipes() })
  registry.register(fakeConnector(), {})
  store = new SqliteStore(':memory:')
  probe = undefined
  app = createApp({
    registry,
    store,
    agent: createStubAgentRunner(),
    home,
    llm: false,
    webDist: join(home, 'no-dist'),
    builtinRecipes,
    probe: (opts) => (probe ? probe(opts) : Promise.reject(new Error('no probe'))),
    storeInfo: () => ({ kind: 'sqlite' }),
  }).app
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const body = async (res: Response): Promise<any> => res.json()
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const userRecipe: Recipe = {
  name: 'fake_quote',
  title: '{symbols} quote',
  summary: 'A quote from the fake connector',
  params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['symbols'] },
  view: { preset: 'stat', column: 'price' },
  routes: [{ connector: 'fake', route: 'quote', params: { symbols: '{symbols}' } }],
}

describe('catalog routes', () => {
  it('GET /api/catalog searches the fake connector\'s kind routes and reports stats', async () => {
    const empty = await body(await app.request('/api/catalog'))
    expect(empty.hits).toEqual([])
    expect(empty.stats.fake).toMatchObject({ routes: 5, alive: 0, dead: 0, unknown: 5 })
    expect(empty.connectors).toEqual(['fake'])
    expect(empty.recipes).toBeGreaterThan(20)
    const res = await body(await app.request('/api/catalog?q=price%20bars&limit=3'))
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0]).toMatchObject({ connector: 'fake', route: 'ohlcv' })
    expect(res.hits[0].requiredParams).toContain('symbols')
  })

  it('GET /api/catalog/:connector lists descriptors with liveness from the store; unknown connector is 404', async () => {
    store.setLiveness([
      { connector: 'fake', route: 'quote', checkedAt: 7, ok: true, rows: 4, ms: 3 },
      { connector: 'fake', route: 'news', checkedAt: 7, ok: false, error: 'boom' },
    ])
    const res = await app.request('/api/catalog/fake')
    expect(res.status).toBe(200)
    const data = await body(res)
    expect(data.connector).toBe('fake')
    expect(data.descriptors.map((d: { route: string }) => d.route)).toEqual(['earnings', 'news', 'ohlcv', 'quote', 'search'])
    expect(data.descriptors.find((d: { route: string }) => d.route === 'quote').liveness).toEqual({ checkedAt: 7, ok: true, rows: 4, ms: 3 })
    expect(data.stats).toMatchObject({ routes: 5, alive: 1, dead: 1, unknown: 3 })
    // dead routes drop out of search unless asked for
    expect((await body(await app.request('/api/catalog?q=headlines'))).hits.map((h: { route: string }) => h.route)).not.toContain('news')
    expect((await body(await app.request('/api/catalog?q=headlines&includeDead=1'))).hits.map((h: { route: string }) => h.route)).toContain('news')
    expect((await app.request('/api/catalog/nope')).status).toBe(404)
  })

  it('POST /api/catalog/probe runs the probe when wired, 501 otherwise', async () => {
    const without = createApp({ registry, store, agent: createStubAgentRunner(), home, llm: false, webDist: join(home, 'no-dist'), builtinRecipes }).app
    const res = await without.request('/api/catalog/probe', json({}))
    expect(res.status).toBe(501)
    expect((await body(res)).error).toMatch(/probe/)
    let asked: { connector?: string } | undefined
    probe = async (opts) => {
      asked = opts
      store.setLiveness({ connector: 'fake', route: 'quote', checkedAt: 1, ok: true })
      return { probed: 1, alive: 1, dead: 0, ms: 5 }
    }
    const ok = await app.request('/api/catalog/probe', json({ connector: 'fake' }))
    expect(ok.status).toBe(200)
    expect(await body(ok)).toEqual({ probed: 1, alive: 1, dead: 0, ms: 5 })
    expect(asked).toEqual({ connector: 'fake' })
  })

  it('PUT /api/liveness records rows the catalog then reflects', async () => {
    const res = await app.request('/api/liveness', json([{ connector: 'fake', route: 'ohlcv', checkedAt: 3, ok: false, error: 'down' }], 'PUT'))
    expect(res.status).toBe(200)
    expect((await body(await app.request('/api/liveness?connector=fake'))).rows).toHaveLength(1)
    expect((await body(await app.request('/api/catalog?q=price%20bars'))).hits.map((h: { route: string }) => h.route)).not.toContain('ohlcv')
  })
})

describe('recipes routes', () => {
  it('GET lists built-in and user recipes; PUT validates, rejects built-in names, writes recipes.yml and the registry', async () => {
    const before = await body(await app.request('/api/recipes'))
    expect(before.builtin.map((r: Recipe) => r.name)).toContain('quote')
    expect(before.user).toEqual([])

    expect((await app.request('/api/recipes', json({ recipes: [{ name: 'quote', title: 'x' }] }, 'PUT'))).status).toBe(400)
    const clash = await app.request('/api/recipes', json({ recipes: [{ ...userRecipe, name: 'quote' }] }, 'PUT'))
    expect(clash.status).toBe(400)
    expect((await body(clash)).error).toMatch(/built-in/)

    const res = await app.request('/api/recipes', json({ recipes: [userRecipe] }, 'PUT'))
    expect(res.status).toBe(200)
    expect((await body(res)).user[0]).toMatchObject({ name: 'fake_quote', user: true })
    expect(existsSync(recipesPath(home))).toBe(true)
    expect(readFileSync(recipesPath(home), 'utf8')).toMatch(/name: fake_quote/)
    expect(registry.recipes().map((r) => r.name)).toContain('fake_quote')

    // the recipe now answers through the registry
    const q = await app.request('/api/query', json({ query: { recipe: 'fake_quote', params: { symbols: ['MU', 'STX'] } } }))
    expect(q.status).toBe(200)
    const { frame } = await body(q)
    expect(frame.rows).toHaveLength(2)
    expect(frame.meta.lineage).toMatchObject({ connector: 'fake', route: 'quote', recipe: 'fake_quote' })

    // removing it
    await app.request('/api/recipes', json({ recipes: [] }, 'PUT'))
    expect((await body(await app.request('/api/recipes'))).user).toEqual([])
    expect(registry.recipes().map((r) => r.name)).not.toContain('fake_quote')
  })
})

describe('query, settings, runs, store', () => {
  it('POST /api/query runs route and kind queries, 400 on an invalid body, 422 on a failure', async () => {
    const route = await app.request('/api/query', json({ query: { connector: 'fake', route: 'quote', params: { symbols: ['MU'] } } }))
    expect(route.status).toBe(200)
    expect((await body(route)).frame.rows).toHaveLength(1)
    const kind = await app.request('/api/query', json({ query: { kind: 'quote', params: { symbols: ['MU'] } } }))
    expect(kind.status).toBe(200)
    expect((await app.request('/api/query', json({ query: { nope: 1 } }))).status).toBe(400)
    const failed = await app.request('/api/query', json({ query: { connector: 'fake', route: 'missing', params: {} } }))
    expect(failed.status).toBe(422)
    expect((await body(failed)).error).toMatch(/no route "missing"/)
    const transform = await app.request('/api/query', json({ query: { inputs: { q: { kind: 'quote', params: { symbols: ['MU'] } } }, code: 'result = q' } }))
    expect(transform.status).toBe(422)
    expect((await body(transform)).error).toMatch(/transform/)
  })

  it('settings: ticker defaults and validates; provider overrides apply to route queries', async () => {
    expect((await body(await app.request('/api/settings/ticker'))).value).toEqual(['^GSPC', '^NDX', '^TNX', '^VIX', 'CL=F', 'GC=F'])
    expect((await app.request('/api/settings/ticker', json({ value: [] }, 'PUT'))).status).toBe(400)
    expect((await body(await app.request('/api/settings/ticker', json({ value: ['spy', 'qqq'] }, 'PUT')))).value).toEqual(['SPY', 'QQQ'])
    expect((await body(await app.request('/api/settings/ticker'))).value).toEqual(['SPY', 'QQQ'])
    expect((await app.request('/api/settings/nope')).status).toBe(404)
    expect((await body(await app.request('/api/settings/providers'))).value).toEqual({})
    const put = await app.request('/api/settings/providers', json({ value: { 'fake:quote': 'nasdaq' } }, 'PUT'))
    expect(put.status).toBe(200)
    // the fake connector's kind routes have no providers, so the override makes the route query fail validation: it was applied
    const q = await app.request('/api/query', json({ query: { connector: 'fake', route: 'quote', params: { symbols: ['MU'] } } }))
    expect(q.status).toBe(422)
    expect((await body(q)).error).toMatch(/no providers/)
  })

  it('GET /api/runs and /api/store', async () => {
    store.appendRun({ id: 'r1', workspaceId: 'w', startedAt: 1, ms: 2, model: 'm', steps: [] })
    expect((await body(await app.request('/api/runs?workspaceId=w'))).runs).toHaveLength(1)
    expect((await body(await app.request('/api/runs?workspaceId=x'))).runs).toHaveLength(0)
    expect(await body(await app.request('/api/store'))).toMatchObject({ location: ':memory:', frames: 0, kind: 'sqlite' })
  })
})

describe('export and import', () => {
  it('round-trips a workspace with its user recipes through the export document', async () => {
    await app.request('/api/recipes', json({ recipes: [userRecipe] }, 'PUT'))
    const v2 = { id: 'w9', title: 'MU quote', size: 'sm', data: { main: { recipe: 'fake_quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' } }
    const ws = await body(await app.request('/api/workspaces', json({ name: 'Memory', widgets: [...stubWidgets(), v2] })))
    const res = await app.request(`/api/workspaces/${ws.id}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Memory.openterminal.json"')
    const doc = await body(res)
    expect(doc).toMatchObject({ format: 'openterminal-workspace', version: 1, name: 'Memory' })
    expect(doc.widgets).toHaveLength(6)
    expect(doc.recipes.map((r: Recipe) => r.name)).toEqual(['fake_quote'])
    expect(doc.messages).toBeUndefined()

    // import into a server that lacks the recipe: the workspace is new, the recipe is added
    const other = new SqliteStore(':memory:')
    const otherHome = mkdtempSync(join(tmpdir(), 'terminal-import-'))
    loadConfig({ home: otherHome, env: {} })
    const reg2 = new ConnectorRegistry({ cache: new MemoryCache(), recipes: builtinRecipes() })
    reg2.register(fakeConnector(), {})
    const app2 = createApp({ registry: reg2, store: other, agent: createStubAgentRunner(), home: otherHome, llm: false, webDist: join(otherHome, 'no-dist'), builtinRecipes }).app
    const imported = await app2.request('/api/workspaces/import', json(doc))
    expect(imported.status).toBe(201)
    const out = await body(imported)
    expect(out.recipesAdded).toEqual(['fake_quote'])
    expect(out.workspace.id).not.toBe(ws.id)
    expect(out.workspace.name).toBe('Memory')
    expect(out.workspace.widgets).toEqual(doc.widgets)
    expect(reg2.recipes().map((r) => r.name)).toContain('fake_quote')
    expect((await other.list()).length).toBe(1)
    expect(isWidgetV2((await other.list())[0]!.widgets[5]!)).toBe(true)

    // a second import of the same document adds no recipe twice
    expect((await body(await app2.request('/api/workspaces/import', json(doc)))).recipesAdded).toEqual([])
    expect((await app2.request('/api/workspaces/import', json({ format: 'other' }))).status).toBe(400)
    other.close()
    rmSync(otherHome, { recursive: true, force: true })
    expect((await app.request('/api/workspaces/nope/export')).status).toBe(404)
  })

  it('exportDocument and recipeNamesIn only carry the recipes the widgets use', () => {
    const widgets = [
      { id: 'a', title: 'a', size: 'sm' as const, data: { main: { recipe: 'r1', params: {} } }, view: { preset: 'table' as const } },
      { id: 'b', title: 'b', size: 'sm' as const, data: { main: { inputs: { x: { recipe: 'r2', params: {} }, y: { kind: 'quote' as const, params: { symbols: ['MU'] } } }, code: 'result = x' } }, view: { preset: 'table' as const } },
    ]
    expect([...recipeNamesIn(widgets)]).toEqual(['r1', 'r2'])
    const r = (name: string): Recipe => ({ ...userRecipe, name })
    const doc = exportDocument({ name: 'X', widgets }, [r('r1'), r('r3')], 9)
    expect(doc.recipes?.map((x) => x.name)).toEqual(['r1'])
    expect(exportDocument({ name: 'X', widgets: [] }, [r('r1')], 9).recipes).toBeUndefined()
  })
})
