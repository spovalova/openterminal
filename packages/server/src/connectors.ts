// Built-in connector map and registry wiring. Config order is routing priority.
import { ConnectorRegistry, MemoryCache, type Cache, type Connector, type Kind, type RegisteredConnector } from '@terminal/core'
import yahoo from '@terminal/connector-yahoo'
import finnhub from '@terminal/connector-finnhub'
import type { Config } from './config.js'

/** Name in config.yml → connector module. The only thing the server assumes about a module is that its default export is a Connector. */
export const BUILTIN_CONNECTORS: Record<string, Connector> = { yahoo, finnhub }

export function builtinConnector(name: string): Connector | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_CONNECTORS, name) ? BUILTIN_CONNECTORS[name] : undefined
}

/** True when the connector's config schema rejects an empty object, i.e. it needs a key to work. */
export function connectorNeedsKey(c: Connector): boolean {
  return !c.config.safeParse({}).success
}

export type BuildRegistryOptions = { cache?: Cache; log?: (msg: string) => void }

/** Register every configured connector, in config order. Unknown names are logged and skipped. */
export function buildRegistry(config: Config, opts: BuildRegistryOptions = {}): ConnectorRegistry {
  const log = opts.log ?? (() => {})
  const registry = new ConnectorRegistry({ cache: opts.cache ?? new MemoryCache(), log })
  for (const entry of config.connectors) {
    const connector = builtinConnector(entry.name)
    if (!connector) {
      log(`connector "${entry.name}" is not built in (known: ${Object.keys(BUILTIN_CONNECTORS).join(', ')}); skipped`)
      continue
    }
    const info = registry.register(connector, entry.config ?? {})
    log(`connector ${info.name}: ${info.status}${info.error ? ` (${info.error})` : ''} · ${info.kinds.join(', ')}`)
  }
  return registry
}

/** What GET /api/connectors returns: every built-in connector, configured or not. */
export type ConnectorInfo = {
  name: string
  kinds: Kind[]
  status: RegisteredConnector['status']
  /** True when the connector's config schema requires a key. */
  needsKey: boolean
  /** True when the connector is listed in config.yml. */
  configured: boolean
  error?: string
}

export function describeConnectors(registered: RegisteredConnector[]): ConnectorInfo[] {
  const byName = new Map(registered.map((r) => [r.name, r]))
  const out: ConnectorInfo[] = []
  // Configured connectors first, in priority order; then the built-ins that are not configured.
  for (const r of registered) {
    const c = builtinConnector(r.name)
    out.push({ name: r.name, kinds: r.kinds, status: r.status, needsKey: c ? connectorNeedsKey(c) : false, configured: true, ...(r.error ? { error: r.error } : {}) })
  }
  for (const [name, c] of Object.entries(BUILTIN_CONNECTORS)) {
    if (byName.has(name)) continue
    out.push({ name, kinds: c.kinds, status: 'missing_config', needsKey: connectorNeedsKey(c), configured: false })
  }
  return out
}
