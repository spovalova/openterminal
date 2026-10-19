import type { z } from 'zod'
import { parseParams, type Descriptor, type ValidatedParams } from './descriptor.js'
import type { Frame, FrameMeta } from './frame.js'
import { jsonSchemaToParams, zodToJsonSchemaObject } from './json-schema.js'
import { KINDS, KIND_NAMES, parseQuery, type Kind, type KindParams } from './kinds.js'

/** Everything a connector handler gets besides its params. */
export type Ctx<C> = {
  http: Http
  config: C
  log(msg: string): void
  signal?: AbortSignal
}

export type Http = {
  /** GET a URL and parse JSON (or return text when the body is not JSON). Throws HttpError on non-2xx. */
  get(url: string, init?: RequestInit): Promise<unknown>
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`)
    this.name = 'HttpError'
  }
}

export function createHttp(fetchImpl: typeof fetch = fetch): Http {
  return {
    async get(url, init) {
      const res = await fetchImpl(url, { ...init, method: 'GET' })
      const text = await res.text()
      if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500))
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    },
  }
}

export type Handler<P, C> = (params: P, ctx: Ctx<C>) => Promise<Frame>
export type Queries<C> = { [K in Kind]?: Handler<KindParams<K>, C> }

/**
 * v2: answer one route with params already validated against its descriptor (`string[]` params arrive as arrays;
 * `provider` is present when the caller chose one). Return a Frame; `inferFrame` builds one from provider rows.
 */
export type CallHandler<C> = (route: string, params: ValidatedParams, ctx: Ctx<C>) => Promise<Frame>

export type ConnectorDef<C> = {
  /** Unique, lowercase, used in config.yml and frame.meta.connector. */
  name: string
  /** Zod schema for the connector's config (API keys and options). Use z.object({}) when none. */
  config: z.ZodType<C, any>
  /** v1: a handler per kind. Either this or `descriptors` + `call` (or both). */
  queries?: Queries<C>
  /**
   * v2: the routes this connector answers, as descriptors (PLAN.md section 17). OpenBB generates them from its
   * OpenAPI document; yahoo and finnhub ship a file. Called once per registration and cached by the registry,
   * with the connector's ctx (config, http, log) so a generator can reach its service; a connector that ships a
   * file ignores it, and a connector called without one falls back to its defaults.
   */
  descriptors?: (ctx?: Ctx<C>) => Descriptor[] | Promise<Descriptor[]>
  /** v2: answer a route. Required with `descriptors`. */
  call?: CallHandler<C>
  /**
   * Optional reachability probe for connectors that depend on a local service (an OpenBB API, a broker gateway).
   * Resolve with a short human-readable detail ("OpenBB Platform 4.4 at http://127.0.0.1:6900") or nothing;
   * throw with a message that tells the user how to fix it. Never called on the query path.
   */
  health?: (ctx: Ctx<C>) => Promise<string | void>
}

export type Connector<C = any> = Omit<ConnectorDef<C>, 'queries' | 'descriptors' | 'call'> & {
  /** Kinds this connector answers, in catalog order ([] for a routes-only connector). */
  kinds: Kind[]
  /** v1 handlers ({} for a routes-only connector). */
  queries: Queries<C>
  /** Every route the connector answers: its own descriptors, plus one per kind derived from the catalog. The registry passes the connector's ctx. */
  descriptors(ctx?: Ctx<C>): Promise<Descriptor[]>
  /** Answer a route: the connector's own `call` when its descriptors list the route, else the kind handler of that name. */
  call: CallHandler<C>
  /**
   * The routes the connector's own `call` answers (its own descriptors' routes; empty for a kinds-only connector).
   * A connector in `both` mode may name a route after a kind (yahoo `quote`, finnhub `quote`): the route then
   * belongs to `call`, with the descriptor's params and columns, and the kind handler keeps the v1 path only.
   */
  ownRoutes(ctx?: Ctx<C>): Promise<Set<string>>
  /** How the connector was defined. */
  mode: 'kinds' | 'routes' | 'both'
}

/**
 * The one helper contributors use. Fixed from day one; the loader behind it may change. Accepts the v1 form
 * (`queries`) or the v2 form (`descriptors` + `call`); a v1 connector appears in the catalog with one route per
 * kind, named after the kind, so existing connectors need no change.
 *
 * export default defineConnector({ name, config: z.object({ apiKey: z.string() }), queries: { quote: async (params, ctx) => toFrame('quote', rows) } })
 * export default defineConnector({ name, config, descriptors: () => descriptorsFromOpenApi(doc, name), call: (route, params, ctx) => … })
 */
export function defineConnector<C>(def: ConnectorDef<C>): Connector<C> {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new Error(`connector name must be lowercase kebab-case: ${def.name}`)
  const queries: Queries<C> = def.queries ?? {}
  const kinds = KIND_NAMES.filter((k) => typeof queries[k] === 'function')
  const hasRoutes = typeof def.descriptors === 'function'
  if (hasRoutes && typeof def.call !== 'function') throw new Error(`connector ${def.name} has descriptors but no call(route, params, ctx)`)
  if (!hasRoutes && typeof def.call === 'function') throw new Error(`connector ${def.name} has call but no descriptors()`)
  if (kinds.length === 0 && !hasRoutes) throw new Error(`connector ${def.name} answers no kinds and has no descriptors`)
  const ownDescriptors = def.descriptors
  const ownCall = def.call
  const mode: Connector['mode'] = hasRoutes && kinds.length > 0 ? 'both' : hasRoutes ? 'routes' : 'kinds'
  const rest: Omit<ConnectorDef<C>, 'queries' | 'descriptors' | 'call'> = { name: def.name, config: def.config }
  if (def.health) rest.health = def.health
  const ownRoutes = async (ctx?: Ctx<C>): Promise<Set<string>> => new Set(ownDescriptors ? (await ownDescriptors(ctx)).map((d) => d.route) : [])
  return {
    ...rest,
    kinds,
    queries,
    mode,
    async descriptors(ctx) {
      const own = ownDescriptors ? await ownDescriptors(ctx) : []
      const fromKinds = kinds.filter((k) => !own.some((d) => d.route === k)).map((k) => descriptorFromKind(def.name, k))
      return [...own, ...fromKinds]
    },
    ownRoutes,
    async call(route, params, ctx) {
      const handler = queries[route as Kind] as Handler<unknown, C> | undefined
      const own = ownCall && (await ownRoutes(ctx)).has(route)
      if (!own && handler && (kinds as string[]).includes(route)) {
        const q = parseQuery({ kind: route, params })
        return handler(q.params, ctx)
      }
      if (ownCall) return ownCall(route, params, ctx)
      throw new Error(`connector ${def.name} does not answer route "${route}"`)
    },
  }
}

/** A kind of the v1 catalog as a descriptor of `connector`: route named after the kind, params from its Zod schema, fields from its columns. */
export function descriptorFromKind(connector: string, kind: Kind): Descriptor {
  const def = KINDS[kind]
  const params = jsonSchemaToParams(zodToJsonSchemaObject(def.params))
  const summary = def.description.split(/(?<=\.)\s/)[0] ?? def.description
  const d: Descriptor = { connector, route: kind, summary, params, providers: [], fields: def.columns.map((c) => ({ name: c.name, type: c.type })) }
  if (def.description !== summary) d.description = def.description
  return d
}

/** Validate route params against a descriptor and call the connector. What the registry's route path does. */
export async function callRoute<C>(connector: Connector<C>, descriptor: Descriptor, params: Record<string, unknown>, ctx: Ctx<C>): Promise<Frame> {
  return connector.call(descriptor.route, parseParams(descriptor, params), ctx)
}

/**
 * Build a Frame for a kind from row objects. Columns come from the catalog in catalog order;
 * missing fields become null. Extra fields are dropped.
 */
export function toFrame(kind: Kind, rows: Record<string, unknown>[], meta: Partial<FrameMeta> = {}): Frame {
  const columns = KINDS[kind].columns
  const ttl = typeof KINDS[kind].ttl === 'number' ? (KINDS[kind].ttl as number) : 0
  return {
    columns: columns.map((c) => ({ ...c })),
    rows: rows.map((r) => columns.map((c) => (r[c.name] === undefined ? null : r[c.name]))),
    meta: { connector: meta.connector ?? 'unknown', fetchedAt: meta.fetchedAt ?? Date.now(), ttl: meta.ttl ?? ttl },
  }
}
