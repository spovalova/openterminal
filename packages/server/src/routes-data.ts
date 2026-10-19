// The data routes (PLAN.md section 17, phase 1 (e)): the catalog with search, liveness and the probe; user recipes;
// workspace export and import; ad-hoc queries for the editor's previews and the ticker strip; settings; the run log.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { z } from 'zod'
import {
  AnyQuerySchema,
  AnyWidgetSchema,
  MessageSchema,
  RecipeSchema,
  TransformFailed,
  isRecipeQuery,
  isTransformQuery,
  parseRecipes,
  widgetQueries,
  type AnyQuery,
  type AnyWidget,
  type Catalog,
  type CatalogHit,
  type Descriptor,
  type Recipe,
  type Registry,
  type ConnectorRegistry,
} from '@terminal/core'
import { PROVIDER_OVERRIDES_KEY, errorMessage, withProviderOverrides, type ProviderOverrides } from './executor.js'
import type { LivenessRow, Store } from './store/index.js'

/** What (a)'s probe looks like when it is wired in: probe every (or one connector's) route, write liveness rows, report. */
export type ProbeFn = (opts: { connector?: string; concurrency?: number; signal?: AbortSignal }) => Promise<{ probed: number; alive: number; dead: number; ms: number }>

export type DataRouteDeps = {
  registry: Registry & Partial<Pick<ConnectorRegistry, 'setRecipes' | 'descriptorsOf'>>
  store: Store
  /** TERMINAL_HOME: user recipes are mirrored to `<home>/recipes.yml`. */
  home: string
  builtinRecipes: () => Recipe[]
  probe?: ProbeFn
  storeInfo?: () => Record<string, unknown>
  log?: (msg: string) => void
  now?: () => number
}

export const EXPORT_FORMAT = 'openterminal-workspace'
export const EXPORT_VERSION = 1

export const WorkspaceExportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().min(1).max(EXPORT_VERSION),
  exportedAt: z.number().optional(),
  name: z.string().trim().min(1).max(60),
  widgets: z.array(AnyWidgetSchema),
  messages: z.array(MessageSchema).optional(),
  /** User recipes the widgets reference, carried along so the import renders. */
  recipes: z.array(RecipeSchema).optional(),
})
export type WorkspaceExport = z.infer<typeof WorkspaceExportSchema>

/** Setting keys the web may read and write. */
export const SETTING_KEYS = ['ticker', PROVIDER_OVERRIDES_KEY] as const
export const TickerSettingSchema = z.array(z.string().trim().min(1).max(16)).min(1).max(12)
export const ProvidersSettingSchema = z.record(z.string(), z.string().min(1))

export const TICKER_DEFAULT = ['^GSPC', '^NDX', '^TNX', '^VIX', 'CL=F', 'GC=F']

export function recipesPath(home: string): string {
  return join(home, 'recipes.yml')
}

/** Recipe names a workspace's widgets refer to (recipe datasets at any depth of a transform). */
export function recipeNamesIn(widgets: AnyWidget[]): Set<string> {
  const out = new Set<string>()
  const walk = (q: AnyQuery) => {
    if (isRecipeQuery(q)) out.add(q.recipe)
    else if (isTransformQuery(q)) Object.values(q.inputs).forEach(walk)
  }
  for (const w of widgets) Object.values(widgetQueries(w)).forEach(walk)
  return out
}

/** Build the export document for a workspace. */
export function exportDocument(ws: { name: string; widgets: AnyWidget[]; messages?: unknown[] }, userRecipes: Recipe[], now: number): WorkspaceExport {
  const names = recipeNamesIn(ws.widgets)
  const recipes = userRecipes.filter((r) => names.has(r.name))
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now, name: ws.name, widgets: ws.widgets, ...(recipes.length ? { recipes } : {}) }
}

export function createDataRoutes(deps: DataRouteDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const { registry, store } = deps
  const app = new Hono()
  const seeded = new WeakSet<Catalog>()

  /** The catalog with the store's liveness rows applied once per catalog instance. */
  const catalog = async (): Promise<Catalog | undefined> => {
    if (!registry.catalog) return undefined
    const c = await registry.catalog()
    if (!seeded.has(c)) {
      for (const row of store.getLiveness()) c.setLiveness(row, row)
      seeded.add(c)
    }
    return c
  }

  const allRecipes = () => [...deps.builtinRecipes(), ...store.listRecipes()]

  /** Persist the user recipe list: the store, the YAML file beside config.yml, the registry. */
  const saveUserRecipes = (recipes: Recipe[]) => {
    store.setRecipes(recipes)
    const file = recipesPath(deps.home)
    mkdirSync(deps.home, { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `# User recipes (PLAN.md section 17). Promoted from widgets on the Data page; the agent sees them beside the built-in ones.\n${toYaml({ recipes })}`, 'utf8')
    renameSync(tmp, file)
    registry.setRecipes?.(allRecipes())
  }

  // ---- catalog ----
  app.get('/api/catalog', async (c) => {
    const cat = await catalog()
    if (!cat) return c.json({ error: 'this registry has no catalog' }, 501)
    const q = c.req.query('q')?.trim() ?? ''
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 200)
    const namespaces = c.req.query('namespaces')?.split(',').map((s) => s.trim()).filter(Boolean)
    const connectors = c.req.query('connectors')?.split(',').map((s) => s.trim()).filter(Boolean)
    const includeDead = c.req.query('includeDead') === '1'
    const hits: CatalogHit[] = q ? cat.find(q, { limit, ...(namespaces?.length ? { namespaces } : {}), ...(connectors?.length ? { connectors } : {}), includeDead }) : []
    return c.json({ query: q, hits, stats: cat.stats(), connectors: cat.connectors(), recipes: allRecipes().length })
  })

  app.post('/api/catalog/probe', async (c) => {
    if (!deps.probe) return c.json({ error: 'the probe is not wired in yet: scripts/probe-catalog.ts (workstream (a)) is not available on this server' }, 501)
    const body = (await jsonBody(c.req.raw)) as { connector?: unknown; concurrency?: unknown }
    const connector = typeof body?.connector === 'string' ? body.connector : undefined
    const concurrency = typeof body?.concurrency === 'number' ? body.concurrency : undefined
    const t0 = now()
    const result = await deps.probe({ ...(connector ? { connector } : {}), ...(concurrency ? { concurrency } : {}) })
    log(`probe${connector ? ` ${connector}` : ''}: ${result.alive} alive, ${result.dead} dead of ${result.probed} in ${now() - t0} ms`)
    return c.json(result)
  })

  app.get('/api/catalog/:connector', async (c) => {
    const name = c.req.param('connector')
    const cat = await catalog()
    if (!cat) return c.json({ error: 'this registry has no catalog' }, 501)
    const registered = registry.connectors().find((r) => r.name === name)
    if (!registered) return c.json({ error: `connector "${name}" is not registered` }, 404)
    const liveness = new Map(store.getLiveness(name).map((r) => [r.route, r]))
    const descriptors: Descriptor[] = cat
      .all()
      .filter((d) => d.connector === name)
      .map((d) => {
        const l = liveness.get(d.route)
        if (!l) return d
        const rest: Record<string, unknown> = { ...l }
        delete rest.connector
        delete rest.route
        return { ...d, liveness: rest as Descriptor['liveness'] }
      })
      .sort((a, b) => a.route.localeCompare(b.route))
    const stats = cat.stats()[name] ?? { routes: 0, alive: 0, dead: 0, unknown: 0 }
    return c.json({ connector: name, status: registered.status, mode: registered.mode ?? 'kinds', descriptors, stats })
  })

  // ---- liveness (written by (a)'s probe; readable for the Data page) ----
  app.get('/api/liveness', (c) => c.json({ rows: store.getLiveness(c.req.query('connector') || undefined) }))
  app.put('/api/liveness', async (c) => {
    const rows = z.array(z.object({ connector: z.string(), route: z.string(), checkedAt: z.number(), ok: z.boolean(), rows: z.number().optional(), ms: z.number().optional(), error: z.string().optional(), sampleColumns: z.array(z.string()).optional() })).parse(await jsonBody(c.req.raw)) as LivenessRow[]
    store.setLiveness(rows)
    const cat = await catalog()
    for (const r of rows) cat?.setLiveness(r, r)
    return c.json({ ok: true, rows: rows.length })
  })

  // ---- recipes ----
  app.get('/api/recipes', (c) => c.json({ builtin: deps.builtinRecipes(), user: store.listRecipes() }))

  app.put('/api/recipes', async (c) => {
    const body = (await jsonBody(c.req.raw)) as { recipes?: unknown }
    let recipes: Recipe[]
    try {
      recipes = parseRecipes(body?.recipes ?? body)
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400)
    }
    const builtin = new Set(deps.builtinRecipes().map((r) => r.name))
    const clash = recipes.find((r) => builtin.has(r.name))
    if (clash) return c.json({ error: `"${clash.name}" is a built-in recipe; pick another name` }, 400)
    saveUserRecipes(recipes.map((r) => ({ ...r, user: true })))
    log(`recipes: ${recipes.length} user recipes saved`)
    return c.json({ user: store.listRecipes() })
  })

  // ---- export and import ----
  app.get('/api/workspaces/:id/export', async (c) => {
    const ws = await store.get(c.req.param('id'))
    if (!ws) return c.json({ error: 'workspace not found' }, 404)
    const doc = exportDocument(ws, store.listRecipes(), now())
    const filename = `${ws.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'}.openterminal.json`
    c.header('content-disposition', `attachment; filename="${filename}"`)
    return c.json(doc)
  })

  app.post('/api/workspaces/import', async (c) => {
    const parsed = WorkspaceExportSchema.safeParse(await jsonBody(c.req.raw))
    if (!parsed.success) return c.json({ error: 'not a workspace export', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400)
    const doc = parsed.data
    const known = new Set(allRecipes().map((r) => r.name))
    const added = (doc.recipes ?? []).filter((r) => !known.has(r.name))
    if (added.length > 0) saveUserRecipes([...store.listRecipes(), ...added.map((r) => ({ ...r, user: true }))])
    const ws = await store.importWorkspace({ name: doc.name, widgets: doc.widgets, ...(doc.messages ? { messages: doc.messages } : {}) })
    log(`imported workspace "${ws.name}" (${ws.widgets.length} widgets${added.length ? `, ${added.length} recipes` : ''})`)
    return c.json({ workspace: ws, recipesAdded: added.map((r) => r.name) }, 201)
  })

  // ---- ad-hoc queries (editor previews, the ticker strip) ----
  app.post('/api/query', async (c) => {
    const body = (await jsonBody(c.req.raw)) as { query?: unknown; refresh?: unknown }
    const parsed = AnyQuerySchema.safeParse(body?.query ?? body)
    if (!parsed.success) return c.json({ error: 'invalid query', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400)
    const q = withProviderOverrides(parsed.data, store.getSetting<ProviderOverrides>(PROVIDER_OVERRIDES_KEY))
    try {
      const frame = await registry.run(q, body?.refresh === true ? { bypassCache: true } : {})
      return c.json({ frame })
    } catch (err) {
      const traceback = err instanceof TransformFailed ? err.traceback : undefined
      return c.json({ error: errorMessage(err), ...(traceback ? { traceback } : {}) }, 422)
    }
  })

  // ---- settings ----
  app.get('/api/settings/:key', (c) => {
    const key = c.req.param('key')
    if (!(SETTING_KEYS as readonly string[]).includes(key)) return c.json({ error: `unknown setting "${key}"` }, 404)
    const value = store.getSetting(key)
    return c.json({ key, value: value ?? (key === 'ticker' ? TICKER_DEFAULT : key === PROVIDER_OVERRIDES_KEY ? {} : null) })
  })

  app.put('/api/settings/:key', async (c) => {
    const key = c.req.param('key')
    const body = (await jsonBody(c.req.raw)) as { value?: unknown }
    const raw = body && typeof body === 'object' && 'value' in body ? body.value : body
    const schema = key === 'ticker' ? TickerSettingSchema : key === PROVIDER_OVERRIDES_KEY ? ProvidersSettingSchema : undefined
    if (!schema) return c.json({ error: `unknown setting "${key}"` }, 404)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid value', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400)
    const value = key === 'ticker' ? (parsed.data as string[]).map((s) => s.toUpperCase()) : parsed.data
    store.setSetting(key, value)
    return c.json({ key, value })
  })

  // ---- run log and store info ----
  app.get('/api/runs', (c) => {
    const workspaceId = c.req.query('workspaceId') || undefined
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500)
    return c.json({ runs: store.listRuns({ ...(workspaceId ? { workspaceId } : {}), limit }) })
  })

  app.get('/api/store', (c) => c.json({ location: store.location, frames: store.countFrames(), ...(deps.storeInfo?.() ?? {}) }))

  return app
}

/** Read `~/.terminal/recipes.yml` when it exists: the user's recipes, validated; `[]` otherwise. */
export function loadUserRecipes(home: string, log: (msg: string) => void = () => {}): Recipe[] {
  const file = recipesPath(home)
  if (!existsSync(file)) return []
  try {
    const recipes = parseRecipes(parseYaml(readFileSync(file, 'utf8')))
    return recipes.map((r) => ({ ...r, user: true }))
  } catch (err) {
    log(`recipes.yml: ${errorMessage(err)}; user recipes ignored`)
    return []
  }
}

async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.trim().length === 0) return {}
  return JSON.parse(text) as unknown
}
