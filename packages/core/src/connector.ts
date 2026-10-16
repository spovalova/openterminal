import type { z } from 'zod'
import type { Frame, FrameMeta } from './frame.js'
import { KINDS, type Kind, type KindParams } from './kinds.js'

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

export type ConnectorDef<C> = {
  /** Unique, lowercase, used in config.yml and frame.meta.connector. */
  name: string
  /** Zod schema for the connector's config (API keys and options). Use z.object({}) when none. */
  config: z.ZodType<C, any>
  queries: { [K in Kind]?: Handler<KindParams<K>, C> }
}

export type Connector<C = any> = ConnectorDef<C> & {
  /** Kinds this connector answers, in catalog order. */
  kinds: Kind[]
}

/**
 * The one helper contributors use. Fixed from day one; the loader behind it may change.
 *
 * export default defineConnector({ name, config: z.object({ apiKey: z.string() }), queries: { quote: async (params, ctx) => toFrame('quote', rows) } })
 */
export function defineConnector<C>(def: ConnectorDef<C>): Connector<C> {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new Error(`connector name must be lowercase kebab-case: ${def.name}`)
  const kinds = (Object.keys(KINDS) as Kind[]).filter((k) => typeof def.queries[k] === 'function')
  if (kinds.length === 0) throw new Error(`connector ${def.name} answers no kinds`)
  return { ...def, kinds }
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
