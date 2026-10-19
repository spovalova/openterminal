import { applyAnnotations, type AnnotationRule } from './annotations.js'
import type { Cache } from './cache.js'
import { Catalog } from './catalog.js'
import { createHttp, type Connector, type Ctx, type Http } from './connector.js'
import { parseParams, type Descriptor } from './descriptor.js'
import type { FieldConfig } from './fields.js'
import type { Frame, Lineage } from './frame.js'
import { KINDS, KIND_NAMES, MS, parseQuery, ttlFor, type Kind, type Query, type QueryInput } from './kinds.js'
import { isLegacyQuery, isRecipeQuery, isRouteQuery, isTransformQuery, QueryV2Schema, type AnyQueryInput, type RecipeQuery, type RouteQuery, type TransformQuery } from './query.js'
import { expandRecipe, recipeMap, type Recipe } from './recipes.js'
import { checkTransformInputs, checkTransformOutput, isTransformError, type TransformEngine } from './transform.js'
import { globToRegExp } from './annotations.js'

/** `unreachable` is reported by health probes (see Registry.health), never by registration itself. */
export type ConnectorStatus = 'ok' | 'missing_config' | 'unreachable' | 'error'

export type RegisteredConnector = {
  name: string
  kinds: Kind[]
  status: ConnectorStatus
  error?: string
  /** One line from the connector's health probe, when it has one and it passed. */
  detail?: string
  /** v2: how the connector was defined (kinds, routes, or both). */
  mode?: Connector['mode']
}

export type HealthResult = { ok: true; detail?: string } | { ok: false; error: string }

export type RunOptions = { signal?: AbortSignal; bypassCache?: boolean }

export interface Registry {
  /** Register a connector with its raw config. Registration order is routing priority. */
  register(c: Connector, config: unknown): RegisteredConnector
  /** Kinds currently answerable by at least one healthy connector. */
  kinds(): Kind[]
  connectors(): RegisteredConnector[]
  /**
   * Run a query: a v1 `{ kind, params }` exactly as before (validate, cache, connectors in order, validate the frame),
   * or a v2 route, recipe or transform (PLAN.md section 17).
   */
  run(q: AnyQueryInput, opts?: RunOptions): Promise<Frame>
  /** Run a registered connector's health probe (ok when it has none). Unknown or unconfigured connectors are not ok. */
  health?(name: string, opts?: { timeoutMs?: number }): Promise<HealthResult>
  /** v2: the catalog of every healthy connector's descriptors. */
  catalog?(): Promise<Catalog>
  /** v2: the recipes the registry resolves. */
  recipes?(): Recipe[]
}

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly causes: { connector: string; error: string }[] = [],
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** A transform that failed inside the engine; `traceback` is what the agent sees to fix its script. */
export class TransformFailed extends Error {
  constructor(
    message: string,
    public readonly traceback?: string,
  ) {
    super(message)
    this.name = 'TransformFailed'
  }
}

type Entry = { connector: Connector; ctx: Ctx<unknown>; info: RegisteredConnector; descriptors?: Promise<Descriptor[]> }

export type RegistryOptions = {
  cache?: Cache
  http?: Http
  log?: (msg: string) => void
  /** v2: recipes to resolve `{ recipe, params }` queries with. */
  recipes?: readonly Recipe[]
  /** v2: annotation rules applied to every route frame. */
  annotations?: readonly AnnotationRule[]
  /** v2: the engine that runs transform queries; without one they fail with a clear error. */
  transform?: TransformEngine
  now?: () => number
}

/**
 * Cache TTL by route pattern (PLAN.md section 17): quotes 10 s, historical bars 1 min intraday else 10 min,
 * news 5 min, calendars 1 h, fundamentals and ownership 1 day, default 10 min. First match wins.
 */
export const ROUTE_TTLS: ReadonlyArray<{ pattern: string; ttl: number | ((params: Record<string, unknown>) => number) }> = [
  { pattern: '*/price/quote', ttl: 10 * MS.second },
  { pattern: '*quote*', ttl: 10 * MS.second },
  { pattern: '*historical*', ttl: (p) => (isIntradayParams(p) ? MS.minute : 10 * MS.minute) },
  { pattern: 'chart', ttl: (p) => (isIntradayParams(p) ? MS.minute : 10 * MS.minute) },
  { pattern: 'news/*', ttl: 5 * MS.minute },
  { pattern: '*news*', ttl: 5 * MS.minute },
  { pattern: '*calendar*', ttl: MS.hour },
  { pattern: '*/options/*', ttl: MS.minute },
  { pattern: 'options', ttl: MS.minute },
  { pattern: '*screener*', ttl: MS.minute },
  { pattern: '*movers*', ttl: MS.minute },
  { pattern: '*/fundamental/*', ttl: MS.day },
  { pattern: '*/ownership/*', ttl: MS.day },
  { pattern: '*/estimates/*', ttl: MS.day },
  { pattern: '*/profile', ttl: MS.day },
  { pattern: '*/shorts/*', ttl: MS.day },
  { pattern: '*/holdings', ttl: MS.day },
  { pattern: '*search*', ttl: MS.day },
]
export const DEFAULT_ROUTE_TTL = 10 * MS.minute

function isIntradayParams(p: Record<string, unknown>): boolean {
  const i = p.interval
  return typeof i === 'string' && /^\d+(m|min|h|hour)$/i.test(i)
}

/** The cache TTL for a route and its params. */
export function ttlForRoute(route: string, params: Record<string, unknown> = {}): number {
  for (const { pattern, ttl } of ROUTE_TTLS) {
    if (pattern === route || globToRegExp(pattern).test(route)) return typeof ttl === 'function' ? ttl(params) : ttl
  }
  return DEFAULT_ROUTE_TTL
}

export class ConnectorRegistry implements Registry {
  private entries: Entry[] = []
  private readonly cache?: Cache
  private readonly http: Http
  private readonly log: (msg: string) => void
  private recipeList: Recipe[]
  private recipeIndex: Map<string, Recipe>
  private annotationRules: readonly AnnotationRule[]
  private transformEngine?: TransformEngine
  private readonly now: () => number
  private catalogMemo?: Promise<Catalog>

  constructor(opts: RegistryOptions = {}) {
    this.cache = opts.cache
    this.http = opts.http ?? createHttp()
    this.log = opts.log ?? (() => {})
    this.recipeList = [...(opts.recipes ?? [])]
    this.recipeIndex = recipeMap(this.recipeList)
    this.annotationRules = opts.annotations ?? []
    this.transformEngine = opts.transform
    this.now = opts.now ?? Date.now
  }

  register(c: Connector, config: unknown): RegisteredConnector {
    const parsed = c.config.safeParse(config ?? {})
    const info: RegisteredConnector = parsed.success
      ? { name: c.name, kinds: c.kinds, status: 'ok', mode: c.mode ?? 'kinds' }
      : { name: c.name, kinds: c.kinds, status: 'missing_config', error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), mode: c.mode ?? 'kinds' }
    const ctx: Ctx<unknown> = {
      http: this.http,
      config: parsed.success ? parsed.data : undefined,
      log: (msg) => this.log(`[${c.name}] ${msg}`),
    }
    // Re-registering (for example after a key is saved) keeps the connector's routing priority.
    const existing = this.entries.findIndex((e) => e.connector.name === c.name)
    if (existing >= 0) this.entries[existing] = { connector: c, ctx, info }
    else this.entries.push({ connector: c, ctx, info })
    this.catalogMemo = undefined
    return info
  }

  kinds(): Kind[] {
    const set = new Set<Kind>()
    for (const e of this.entries) if (e.info.status === 'ok') e.connector.kinds.forEach((k) => set.add(k))
    return KIND_NAMES.filter((k) => set.has(k))
  }

  connectors(): RegisteredConnector[] {
    return this.entries.map((e) => ({ ...e.info }))
  }

  recipes(): Recipe[] {
    return [...this.recipeList]
  }

  /** Replace the recipe list (after a user promotes a widget to a recipe). */
  setRecipes(recipes: readonly Recipe[]): void {
    this.recipeList = [...recipes]
    this.recipeIndex = recipeMap(this.recipeList)
  }

  setAnnotations(rules: readonly AnnotationRule[]): void {
    this.annotationRules = rules
  }

  setTransformEngine(engine: TransformEngine | undefined): void {
    this.transformEngine = engine
  }

  async health(name: string, opts: { timeoutMs?: number } = {}): Promise<HealthResult> {
    const e = this.entries.find((x) => x.connector.name === name)
    if (!e) return { ok: false, error: `connector "${name}" is not registered` }
    if (e.info.status !== 'ok') return { ok: false, error: e.info.error ?? e.info.status }
    const probe = e.connector.health
    if (!probe) return { ok: true }
    const ac = new AbortController()
    const timeoutMs = opts.timeoutMs ?? 2_000
    const timer = setTimeout(() => ac.abort(new Error(`health probe timed out after ${timeoutMs} ms`)), timeoutMs)
    try {
      const detail = await probe({ ...e.ctx, signal: ac.signal })
      return typeof detail === 'string' && detail ? { ok: true, detail } : { ok: true }
    } catch (err) {
      const reason = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err
      return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
    } finally {
      clearTimeout(timer)
    }
  }

  // ------------------------------------------------------------------------------------ v2: catalog

  /** A connector's descriptors, loaded once per registration (a failure is logged and leaves the connector with none). */
  async descriptorsOf(name: string): Promise<Descriptor[]> {
    const e = this.entries.find((x) => x.connector.name === name)
    if (!e) return []
    if (!e.descriptors) {
      e.descriptors = e.connector.descriptors(e.ctx).catch((err: unknown) => {
        this.log(`[${name}] descriptors failed: ${err instanceof Error ? err.message : String(err)}`)
        return []
      })
    }
    return e.descriptors
  }

  async descriptorFor(connector: string, route: string): Promise<Descriptor | undefined> {
    return (await this.descriptorsOf(connector)).find((d) => d.route === route)
  }

  /** The catalog over every healthy connector's descriptors. Memoized until the next `register`; `setLiveness` on it persists. */
  catalog(): Promise<Catalog> {
    if (!this.catalogMemo) {
      this.catalogMemo = (async () => {
        const all: Descriptor[] = []
        for (const e of this.entries) if (e.info.status === 'ok') all.push(...(await this.descriptorsOf(e.connector.name)))
        return new Catalog(all)
      })()
    }
    return this.catalogMemo
  }

  // ------------------------------------------------------------------------------------ run

  async run(input: AnyQueryInput, opts: RunOptions = {}): Promise<Frame> {
    if (isLegacyQuery(input)) return this.runLegacy(input as QueryInput, opts)
    const q = QueryV2Schema.parse(input)
    if (!opts.bypassCache) {
      const hit = this.cache?.get(q)
      if (hit) return hit
    }
    let frame: Frame
    if (isTransformQuery(q)) frame = await this.runTransform(q, opts)
    else if (isRecipeQuery(q)) frame = await this.runRecipe(q, opts)
    else if (isRouteQuery(q)) frame = await this.runRoute(q, opts)
    else throw new RegistryError('unrecognised query shape')
    this.cache?.set(q, frame)
    return frame
  }

  /** The v1 kind path, unchanged: validate, cache, try connectors in order, validate the frame's columns against the catalog. */
  private async runLegacy(input: QueryInput, opts: RunOptions): Promise<Frame> {
    const q = parseQuery(input)
    if (!opts.bypassCache) {
      const hit = this.cache?.get(q)
      if (hit) return hit
    }
    const candidates = this.entries.filter((e) => e.info.status === 'ok' && e.connector.kinds.includes(q.kind))
    if (candidates.length === 0) throw new RegistryError(`no connector answers kind "${q.kind}"`)

    const causes: { connector: string; error: string }[] = []
    for (const e of candidates) {
      const handler = e.connector.queries[q.kind] as ((p: unknown, ctx: Ctx<unknown>) => Promise<Frame>) | undefined
      if (!handler) continue
      try {
        const raw = await handler(q.params, { ...e.ctx, signal: opts.signal })
        const frame = validateFrame(q, raw, e.connector.name)
        this.cache?.set(q, frame)
        return frame
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        causes.push({ connector: e.connector.name, error: msg })
        this.log(`[${e.connector.name}] ${q.kind} failed: ${msg}`)
        if (opts.signal?.aborted) break
      }
    }
    throw new RegistryError(`${q.kind} failed on every connector: ${causes.map((c) => `${c.connector}: ${c.error}`).join(' | ')}`, causes)
  }

  /** One route on one connector: params validated against the descriptor, the frame annotated, TTL and lineage stamped. */
  private async runRoute(q: RouteQuery, opts: RunOptions): Promise<Frame> {
    const e = this.entries.find((x) => x.connector.name === q.connector)
    if (!e) throw new RegistryError(`connector "${q.connector}" is not registered`)
    if (e.info.status !== 'ok') throw new RegistryError(`connector "${q.connector}" is ${e.info.status}${e.info.error ? ` (${e.info.error})` : ''}`)
    const descriptor = await this.descriptorFor(q.connector, q.route)
    if (!descriptor) throw new RegistryError(`connector "${q.connector}" has no route "${q.route}"`)
    const params = parseParams(descriptor, q.params)
    const raw = await e.connector.call(q.route, params, { ...e.ctx, signal: opts.signal })
    // A kind route (a v1 connector's `quote`) is validated against the kind's columns and keeps the kind's TTL; a
    // connector's own route of the same name is a v2 route like any other.
    const isKind = (e.connector.kinds as string[]).includes(q.route) && !(await e.connector.ownRoutes(e.ctx)).has(q.route)
    const checked = isKind ? validateFrame({ kind: q.route as Kind, params: q.params } as Query, raw, e.connector.name) : raw
    const ttl = isKind ? checked.meta.ttl : ttlForRoute(q.route, params)
    const lineage: Lineage = { connector: q.connector, route: q.route, params: { ...params } }
    if (typeof params.provider === 'string') lineage.provider = params.provider
    const stamped: Frame = { ...checked, meta: { ...checked.meta, connector: e.connector.name, fetchedAt: checked.meta?.fetchedAt ?? this.now(), ttl, lineage } }
    return applyAnnotations(stamped, { connector: q.connector, route: q.route }, this.annotationRules)
  }

  /** A recipe: every dataset's route alternatives in order with fallback, transforms after their inputs, `main` returned. */
  private async runRecipe(q: RecipeQuery, opts: RunOptions): Promise<Frame> {
    const recipe = this.recipeIndex.get(q.recipe)
    if (!recipe) throw new RegistryError(`unknown recipe "${q.recipe}"${this.recipeList.length ? ` (known: ${this.recipeList.map((r) => r.name).join(', ')})` : ''}`)
    const expanded = expandRecipe(recipe, q.params ?? {}, { now: this.now() })
    const frames: Record<string, Frame> = {}
    const pending = new Set(Object.keys(expanded.data))
    // Datasets resolve in dependency order: routes first, then transforms whose inputs are ready.
    while (pending.size > 0) {
      const ready = [...pending].filter((name) => {
        const ds = expanded.data[name]!
        return 'routes' in ds || ds.transform.inputs.every((i) => i in frames)
      })
      if (ready.length === 0) throw new RegistryError(`recipe "${recipe.name}": circular or missing transform inputs (${[...pending].join(', ')})`)
      await Promise.all(
        ready.map(async (name) => {
          const ds = expanded.data[name]!
          pending.delete(name)
          if ('routes' in ds) frames[name] = await this.firstOf(ds.routes, opts, `recipe "${recipe.name}" (${name})`)
          else {
            const inputs: Record<string, Frame> = {}
            for (const i of ds.transform.inputs) inputs[i] = frames[i]!
            frames[name] = await this.runTransformFrames(inputs, ds.transform.code, ds.transform.columns, opts)
          }
        }),
      )
    }
    const main = frames.main
    if (!main) throw new RegistryError(`recipe "${recipe.name}" produced no main dataset`)
    const fields: Record<string, FieldConfig> = { ...(main.meta.fields ?? {}) }
    for (const [name, cfg] of Object.entries(recipe.fields ?? {})) fields[name] = { ...(fields[name] ?? {}), ...cfg }
    const ttl = recipe.ttl ?? main.meta.ttl
    return { ...main, meta: { ...main.meta, ttl, fields, lineage: { ...(main.meta.lineage ?? {}), recipe: recipe.name } } }
  }

  /** The first alternative that answers; a RegistryError with every cause when none does. */
  private async firstOf(routes: RouteQuery[], opts: RunOptions, what: string): Promise<Frame> {
    if (routes.length === 0) throw new RegistryError(`${what}: no route matches these params`)
    const causes: { connector: string; error: string }[] = []
    for (const r of routes) {
      try {
        return await this.run(r, opts)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        causes.push({ connector: r.connector, error: msg })
        this.log(`[${r.connector}] ${r.route} failed: ${msg}`)
        if (opts.signal?.aborted) break
      }
    }
    throw new RegistryError(`${what} failed on every route: ${causes.map((c) => `${c.connector}: ${c.error}`).join(' | ')}`, causes)
  }

  /** A transform: inputs run in parallel (cache hits when fresh), then the engine. */
  private async runTransform(q: TransformQuery, opts: RunOptions): Promise<Frame> {
    const names = Object.keys(q.inputs)
    const settled = await Promise.all(names.map((n) => this.run(q.inputs[n]!, { signal: opts.signal, bypassCache: opts.bypassCache })))
    const inputs: Record<string, Frame> = {}
    names.forEach((n, i) => (inputs[n] = settled[i]!))
    return this.runTransformFrames(inputs, q.code, q.columns, opts)
  }

  private async runTransformFrames(inputs: Record<string, Frame>, code: string, columns: Record<string, FieldConfig> | undefined, opts: RunOptions): Promise<Frame> {
    if (!this.transformEngine) throw new RegistryError('transforms are not available: no transform engine is configured')
    const inputIssue = checkTransformInputs(inputs)
    if (inputIssue) throw new TransformFailed(inputIssue)
    const result = await this.transformEngine.run(inputs, code, columns, { signal: opts.signal })
    if (isTransformError(result)) throw new TransformFailed(result.error, result.traceback)
    const outputIssue = checkTransformOutput(result)
    if (outputIssue) throw new TransformFailed(outputIssue)
    // Field config: columns that keep an input's name keep its config; the script's `columns` block overrides.
    const fields: Record<string, FieldConfig> = {}
    for (const f of Object.values(inputs)) for (const [name, cfg] of Object.entries(f.meta.fields ?? {})) if (result.columns.some((c) => c.name === name) && !fields[name]) fields[name] = { ...cfg }
    for (const [name, cfg] of Object.entries(columns ?? {})) fields[name] = { ...(fields[name] ?? {}), ...cfg }
    const ttls = Object.values(inputs).map((f) => f.meta.ttl).filter((t) => t > 0)
    const lineageInputs: Record<string, unknown> = {}
    for (const [n, f] of Object.entries(inputs)) lineageInputs[n] = f.meta.lineage ?? { connector: f.meta.connector }
    return {
      ...result,
      meta: { ...result.meta, connector: 'transform', fetchedAt: this.now(), ttl: ttls.length ? Math.min(...ttls) : 0, fields, lineage: { code, inputs: lineageInputs } },
    }
  }
}

/** Validates columns against the catalog exactly (names, types, order), checks every non-null cell's type, and stamps meta. */
export function validateFrame(q: Query, frame: Frame, connector: string): Frame {
  const expected = KINDS[q.kind].columns
  const got = frame.columns
  const same = got.length === expected.length && got.every((c, i) => c.name === expected[i]!.name && c.type === expected[i]!.type)
  if (!same) {
    throw new Error(
      `frame columns for ${q.kind} do not match catalog. expected [${expected.map((c) => c.name).join(', ')}] got [${got.map((c) => c.name).join(', ')}]`,
    )
  }
  frame.rows.forEach((row, r) => {
    if (row.length !== expected.length) throw new Error(`row ${r} has ${row.length} cells, expected ${expected.length}`)
    row.forEach((cell, i) => {
      if (cell === null || cell === undefined) return
      const want = expected[i]!.type
      const ok =
        want === 'string' ? typeof cell === 'string'
        : want === 'boolean' ? typeof cell === 'boolean'
        : typeof cell === 'number' && Number.isFinite(cell) // number and time (epoch ms)
      if (!ok) throw new Error(`row ${r} column ${expected[i]!.name}: expected ${want}, got ${cell instanceof Date ? 'Date' : typeof cell}`)
    })
  })
  return { ...frame, meta: { connector, fetchedAt: frame.meta?.fetchedAt ?? Date.now(), ttl: ttlFor(q) } }
}
