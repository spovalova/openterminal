import { applyAnnotations, type AnnotationRule } from './annotations.js'
import type { Cache } from './cache.js'
import { Catalog } from './catalog.js'
import { createHttp, type Connector, type Ctx, type Http } from './connector.js'
import { parseParams, type Descriptor } from './descriptor.js'
import type { FieldConfig } from './fields.js'
import type { Frame, Lineage } from './frame.js'
import { MS } from './clock.js'
import { isRecipeQuery, isRouteQuery, isTransformQuery, QueryV2Schema, type AnyQueryInput, type RecipeQuery, type RouteQuery, type TransformQuery } from './query.js'
import { RECIPE_PARAMS_INPUT, expandRecipe, recipeMap, recipeParamsFrame, recipeUsable, recipeVersion, renameColumns, type Recipe, type RecipeRouteQuery } from './recipes.js'
import { checkTransformInputs, checkTransformOutput, isTransformError, type TransformEngine } from './transform.js'
import { globToRegExp } from './annotations.js'

/** `unreachable` is reported by health probes (see Registry.health), never by registration itself. */
export type ConnectorStatus = 'ok' | 'missing_config' | 'unreachable' | 'error'

export type RegisteredConnector = {
  name: string
  status: ConnectorStatus
  error?: string
  /** One line from the connector's health probe, when it has one and it passed. */
  detail?: string
}

export type HealthResult = { ok: true; detail?: string } | { ok: false; error: string }

export type RunOptions = { signal?: AbortSignal; bypassCache?: boolean }

export interface Registry {
  /** Register a connector with its raw config. Registration order is routing priority. */
  register(c: Connector, config: unknown): RegisteredConnector
  connectors(): RegisteredConnector[]
  /** Run a route, recipe or transform query (PLAN.md section 17). */
  run(q: AnyQueryInput, opts?: RunOptions): Promise<Frame>
  /** Run a registered connector's health probe (ok when it has none). Unknown or unconfigured connectors are not ok. */
  health?(name: string, opts?: { timeoutMs?: number }): Promise<HealthResult>
  /** The catalog of every healthy connector's descriptors. */
  catalog?(): Promise<Catalog>
  /** The recipes the registry resolves. */
  recipes?(): Recipe[]
  /** The recipes that can run now: each has a route on a registered, healthy connector whose catalog lists it. What the agent is offered. */
  usableRecipes?(): Promise<Recipe[]>
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
  /** Recipes to resolve `{ recipe, params }` queries with. */
  recipes?: readonly Recipe[]
  /** Annotation rules applied to every route frame. */
  annotations?: readonly AnnotationRule[]
  /** The engine that runs transform queries; without one they fail with a clear error. */
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
  private readonly recipeVersions = new Map<string, string>()
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
    const info: RegisteredConnector = parsed.success ? { name: c.name, status: 'ok' } : { name: c.name, status: 'missing_config', error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
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

  connectors(): RegisteredConnector[] {
    return this.entries.map((e) => ({ ...e.info }))
  }

  recipes(): Recipe[] {
    return [...this.recipeList]
  }

  /**
   * The recipes with a callable route in every route dataset (`recipeUsable`): a route is callable when its connector
   * is registered and healthy (the catalog holds only those) and lists it. A recipe whose routes all point at OpenBB
   * when OpenBB is not configured or not answering is left out, so the agent is not offered a query that can only fail.
   */
  async usableRecipes(): Promise<Recipe[]> {
    const catalog = await this.catalog()
    return this.recipeList.filter((r) => recipeUsable(r, (connector, route) => catalog.get(connector, route) !== undefined))
  }

  /** Replace the recipe list (after a user promotes a widget to a recipe). */
  setRecipes(recipes: readonly Recipe[]): void {
    this.recipeList = [...recipes]
    this.recipeIndex = recipeMap(this.recipeList)
    this.recipeVersions.clear()
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

  // ------------------------------------------------------------------------------------ catalog

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
    const q = QueryV2Schema.parse(input)
    if (!opts.bypassCache) {
      const hit = this.cache?.get(q)
      // A recipe frame cached under an older recipe definition (the persistent cache outlives recipes.yml edits) is a miss.
      const stale = hit && isRecipeQuery(q) && hit.meta.lineage?.recipeVersion !== this.recipeVersionOf(q.recipe)
      if (hit && !stale) return hit
    }
    let frame: Frame
    if (isTransformQuery(q)) frame = await this.runTransform(q, opts)
    else if (isRecipeQuery(q)) frame = await this.runRecipe(q, opts)
    else if (isRouteQuery(q)) frame = await this.runRoute(q, opts)
    else throw new RegistryError('unrecognised query shape')
    // An empty frame is not cached: a provider hiccup (yfinance consensus answering [] once) would otherwise stand for
    // the route's whole TTL, and an empty window (no earnings this week) is cheap to ask again.
    if (frame.rows.length > 0) this.cache?.set(q, frame)
    return frame
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
    const ttl = ttlForRoute(q.route, params)
    const lineage: Lineage = { connector: q.connector, route: q.route, params: { ...params } }
    if (typeof params.provider === 'string') lineage.provider = params.provider
    const stamped: Frame = { ...raw, meta: { ...raw.meta, connector: e.connector.name, fetchedAt: raw.meta?.fetchedAt ?? this.now(), ttl, lineage } }
    return applyAnnotations(stamped, { connector: q.connector, route: q.route }, this.annotationRules)
  }

  /** A recipe: every dataset's route alternatives in order with fallback, transforms after their inputs, `main` returned. */
  private async runRecipe(q: RecipeQuery, opts: RunOptions): Promise<Frame> {
    const recipe = this.recipeIndex.get(q.recipe)
    if (!recipe) throw new RegistryError(`unknown recipe "${q.recipe}"${this.recipeList.length ? ` (known: ${this.recipeList.map((r) => r.name).join(', ')})` : ''}`)
    const expanded = expandRecipe(recipe, q.params ?? {}, { now: this.now() })
    // `params` is bound for the recipe's transforms as a one-row frame of the validated params.
    const frames: Record<string, Frame> = { [RECIPE_PARAMS_INPUT]: recipeParamsFrame(expanded.params, this.now()) }
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
    return { ...main, meta: { ...main.meta, ttl, fields, lineage: { ...(main.meta.lineage ?? {}), recipe: recipe.name, recipeVersion: this.recipeVersionOf(recipe.name) } } }
  }

  /** `recipeVersion` of a loaded recipe, memoised until `setRecipes`; undefined for an unknown name. */
  private recipeVersionOf(name: string): string | undefined {
    const r = this.recipeIndex.get(name)
    if (!r) return undefined
    let v = this.recipeVersions.get(name)
    if (!v) {
      v = recipeVersion(r)
      this.recipeVersions.set(name, v)
    }
    return v
  }

  /** The first alternative that answers; a RegistryError with every cause when none does. */
  private async firstOf(routes: RecipeRouteQuery[], opts: RunOptions, what: string): Promise<Frame> {
    if (routes.length === 0) throw new RegistryError(`${what}: no route matches these params`)
    const causes: { connector: string; error: string }[] = []
    let empty: Frame | undefined
    for (const r of routes) {
      try {
        const { rename, ...query } = r
        // The recipe's renames (`date` → `time` on the price routes) keep the kind's column names on every alternative.
        const frame = renameColumns(await this.run(query, opts), rename)
        // An empty frame is not an answer when another alternative is left (yfinance's consensus answers [] for some
        // symbols that yahoo's quoteSummary has); it is returned only when every alternative is empty.
        if (frame.rows.length === 0 && r !== routes[routes.length - 1]) {
          empty ??= frame
          this.log(`[${r.connector}] ${r.route} answered no rows; trying the next alternative`)
          continue
        }
        return frame
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        causes.push({ connector: r.connector, error: msg })
        this.log(`[${r.connector}] ${r.route} failed: ${msg}`)
        if (opts.signal?.aborted) break
      }
    }
    if (empty) return empty
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
