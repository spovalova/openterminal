// The contract every native provider implements: one handler per OpenBB route, returning the rows OpenBB's API
// would put in `results` (same field names, same JSON values: dates as "YYYY-MM-DD", datetimes as ISO strings,
// numbers as numbers). The openbb connector turns them into a Frame exactly as it does an API response.
import type { NativeHttp } from './http.js'

export type Row = Record<string, unknown>

/** Params as the openbb connector sends them: validated against the route's descriptor, `provider` removed. */
export type NativeParams = Record<string, string | number | boolean | string[]>

export type NativeCtx = {
  http: NativeHttp
  /** A credential by OpenBB's name (`fred_api_key`, `eia_api_key`, …), or undefined when the user has none. */
  credential(name: string): string | undefined
  /** The current time. Handlers use this, never `Date.now()` or `new Date()`, so recorded fixtures replay. */
  now(): Date
  /**
   * Memoise a slow, rarely changing download (a symbol directory) for `ttlMs`. Shared across calls in production;
   * the parity harness gives every case its own, so a recording holds everything its replay needs.
   */
  cache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>
  log(msg: string): void
  signal?: AbortSignal
}

/** Answer one route for one provider. A single object is one row; null or undefined is no rows. */
export type NativeHandler = (params: NativeParams, ctx: NativeCtx) => Promise<Row[] | Row | null | undefined>

export type ProviderDef = {
  /** OpenBB's provider name, as in `?provider=` (`cboe`, `federal_reserve`, `us_treasury`, …). */
  name: string
  /** OpenBB credential names the provider reads, e.g. `["fred_api_key"]`; empty for keyless providers. */
  credentials: string[]
  /**
   * `todo` while routes are still being ported. `ported` switches on the completeness test: every route the
   * catalog lists for this provider must be in `routes` or in `skipped`.
   */
  status: 'todo' | 'ported'
  /** Route (`equity/price/quote`) → handler. */
  routes: Record<string, NativeHandler>
  /** Routes deliberately left to the OpenBB API, with the reason. */
  skipped?: Record<string, string>
}

export function defineProvider(def: ProviderDef): ProviderDef {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`provider name must be OpenBB's lowercase name: ${def.name}`)
  for (const route of Object.keys(def.routes)) {
    if (route.startsWith('/') || route.includes('?')) throw new Error(`${def.name}: route must look like "equity/price/quote": ${route}`)
    if (def.skipped && route in def.skipped) throw new Error(`${def.name}: ${route} is both ported and skipped`)
  }
  return def
}

/** Thrown when a handler cannot answer these params (an unsupported option); the connector may fall back to the API. */
export class NativeUnsupported extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeUnsupported'
  }
}

/** Thrown when a provider needs a credential the user has not configured. */
export class MissingCredential extends Error {
  constructor(
    public readonly provider: string,
    public readonly credential: string,
  ) {
    super(`${provider} needs ${credential}: add it under connectors → openbb → credentials in config.yml`)
    this.name = 'MissingCredential'
  }
}
