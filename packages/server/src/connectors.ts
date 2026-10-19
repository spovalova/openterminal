// Built-in connector map and registry wiring. Config order is routing priority.
import { ConnectorRegistry, MemoryCache, type AnnotationRule, type Cache, type Connector, type Recipe, type RegisteredConnector, type Registry, type TransformEngine } from '@terminal/core'
import { builtinAnnotations, builtinRecipes } from '@terminal/core/node'
import openbb from '@terminal/connector-openbb'
import yahoo from '@terminal/connector-yahoo'
import finnhub from '@terminal/connector-finnhub'
import type { Config } from './config.js'

/** Name in config.yml → connector module. The only thing the server assumes about a module is that its default export is a Connector. */
export const BUILTIN_CONNECTORS: Record<string, Connector> = { openbb, yahoo, finnhub }

export function builtinConnector(name: string): Connector | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_CONNECTORS, name) ? BUILTIN_CONNECTORS[name] : undefined
}

/** True when the connector's config schema rejects an empty object, i.e. it needs a key to work. */
export function connectorNeedsKey(c: Connector): boolean {
  return !c.config.safeParse({}).success
}

export type BuildRegistryOptions = {
  cache?: Cache
  log?: (msg: string) => void
  /** v2: the recipes (built-in plus user) the registry resolves `{ recipe, params }` with; the built-in ones when omitted. */
  recipes?: readonly Recipe[]
  /** v2: annotation rules applied to every route frame; the built-in ones when omitted. */
  annotations?: readonly AnnotationRule[]
  /** v2: the transform engine (workstream (b)); transforms fail with a clear error without one. */
  transform?: TransformEngine
}

/**
 * Register every configured connector, in config order. Unknown names are logged and skipped. The registry resolves
 * the built-in recipes and applies the built-in annotations (v2); user recipes are (e)'s store, layered on later.
 */
export function buildRegistry(config: Config, opts: BuildRegistryOptions = {}): ConnectorRegistry {
  const log = opts.log ?? (() => {})
  const registry = new ConnectorRegistry({
    cache: opts.cache ?? new MemoryCache(),
    log,
    recipes: opts.recipes ?? builtinRecipes(),
    annotations: opts.annotations ?? builtinAnnotations(),
    ...(opts.transform ? { transform: opts.transform } : {}),
  })
  for (const entry of config.connectors) {
    const connector = builtinConnector(entry.name)
    if (!connector) {
      log(`connector "${entry.name}" is not built in (known: ${Object.keys(BUILTIN_CONNECTORS).join(', ')}); skipped`)
      continue
    }
    const info = registry.register(connector, entry.config ?? {})
    log(`connector ${info.name}: ${info.status}${info.error ? ` (${info.error})` : ''}`)
  }
  return registry
}

/** What GET /api/connectors returns: every built-in connector, configured or not. */
export type ConnectorInfo = {
  name: string
  /** Routes in the catalog, for a registered connector whose descriptors loaded. */
  routes?: number
  status: RegisteredConnector['status']
  /** True when the connector's config schema requires a key. */
  needsKey: boolean
  /** True when the connector is listed in config.yml. */
  configured: boolean
  error?: string
  /** One line from the health probe, e.g. the service version and URL. */
  detail?: string
}

/**
 * Every built-in connector, configured or not. Configured ones come first in priority order and carry the result of
 * their health probe (a connector without a probe is simply `ok`); the rest are `missing_config`.
 */
export async function describeConnectors(registry: Registry, opts: { timeoutMs?: number } = {}): Promise<ConnectorInfo[]> {
  const registered = registry.connectors()
  const byName = new Map(registered.map((r) => [r.name, r]))
  const out: ConnectorInfo[] = []
  for (const r of registered) {
    const c = builtinConnector(r.name)
    const info: ConnectorInfo = { name: r.name, status: r.status, needsKey: c ? connectorNeedsKey(c) : false, configured: true, ...(r.error ? { error: r.error } : {}) }
    if (r.status === 'ok' && registry.catalog) info.routes = (await registry.catalog()).all().filter((d) => d.connector === r.name).length
    if (r.status === 'ok' && registry.health) {
      const h = await registry.health(r.name, opts)
      if (h.ok) {
        if (h.detail) info.detail = h.detail
      } else {
        info.status = 'unreachable'
        info.error = h.error
      }
    }
    out.push(info)
  }
  for (const [name, c] of Object.entries(BUILTIN_CONNECTORS)) {
    if (byName.has(name)) continue
    out.push({ name, status: 'missing_config', needsKey: connectorNeedsKey(c), configured: false })
  }
  return out
}
