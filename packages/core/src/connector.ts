import type { z } from 'zod'
import { parseParams, type Descriptor, type ValidatedParams } from './descriptor.js'
import type { Frame } from './frame.js'

/** Everything a connector's `call` gets besides the route and its params. */
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

/**
 * Answer one route with params already validated against its descriptor (`string[]` params arrive as arrays;
 * `provider` is present when the caller chose one). Return a Frame; `inferFrame` builds one from provider rows.
 */
export type CallHandler<C> = (route: string, params: ValidatedParams, ctx: Ctx<C>) => Promise<Frame>

export type ConnectorDef<C> = {
  /** Unique, lowercase, used in config.yml and frame.meta.connector. */
  name: string
  /** Zod schema for the connector's config (API keys and options). Use z.object({}) when none. */
  config: z.ZodType<C, any>
  /**
   * The routes this connector answers, as descriptors (PLAN.md section 17). OpenBB generates them from its OpenAPI
   * document; yahoo and finnhub ship a file. Called once per registration and cached by the registry, with the
   * connector's ctx (config, http, log) so a generator can reach its service; a connector that ships a file ignores
   * it, and a connector called without one falls back to its defaults.
   */
  descriptors: (ctx?: Ctx<C>) => Descriptor[] | Promise<Descriptor[]>
  /** Answer a route the descriptors list. */
  call: CallHandler<C>
  /**
   * Optional reachability probe for connectors that depend on a local service (an OpenBB API, a broker gateway).
   * Resolve with a short human-readable detail ("OpenBB Platform 4.4 at http://127.0.0.1:6900") or nothing;
   * throw with a message that tells the user how to fix it. Never called on the query path.
   */
  health?: (ctx: Ctx<C>) => Promise<string | void>
}

export type Connector<C = any> = Omit<ConnectorDef<C>, 'descriptors'> & {
  /** Every route the connector answers. The registry passes the connector's ctx. */
  descriptors(ctx?: Ctx<C>): Promise<Descriptor[]>
}

/**
 * The one helper contributors use. Fixed from day one; the loader behind it may change. A connector is a name, a
 * config schema, `descriptors()` and `call(route, params, ctx)`:
 *
 * export default defineConnector({ name, config, descriptors: () => parseDescriptors(file), call: (route, params, ctx) => … })
 * export default defineConnector({ name, config, descriptors: (ctx) => descriptorsFromOpenApi(doc, name), call })
 */
export function defineConnector<C>(def: ConnectorDef<C>): Connector<C> {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new Error(`connector name must be lowercase kebab-case: ${def.name}`)
  if (typeof def.descriptors !== 'function') throw new Error(`connector ${def.name} has no descriptors()`)
  if (typeof def.call !== 'function') throw new Error(`connector ${def.name} has no call(route, params, ctx)`)
  const rest: Omit<ConnectorDef<C>, 'descriptors' | 'call'> = { name: def.name, config: def.config }
  if (def.health) rest.health = def.health
  const own = def.descriptors
  return {
    ...rest,
    call: def.call,
    async descriptors(ctx) {
      return own(ctx)
    },
  }
}

/** Validate route params against a descriptor and call the connector. What the registry's route path does. */
export async function callRoute<C>(connector: Connector<C>, descriptor: Descriptor, params: Record<string, unknown>, ctx: Ctx<C>): Promise<Frame> {
  return connector.call(descriptor.route, parseParams(descriptor, params), ctx)
}
