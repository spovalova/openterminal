// M0 check: `pnpm query ohlcv AAPL 1d 3mo` prints a frame.
// Usage: pnpm query search micron sandisk | quote MU SNDK | ohlcv MU 1d 3mo | news NVDA [limit] | earnings MU 2026-10-16 2026-12-15
// Connectors come from ~/.terminal/config.yml (TERMINAL_HOME overrides the directory) when it exists, else yahoo only.
import { existsSync } from 'node:fs'
import { ConnectorRegistry, MemoryCache, type QueryInput } from '@terminal/core'
import yahoo from '@terminal/connector-yahoo'
import { configPath, loadConfig, terminalHome } from '../packages/server/src/config.js'
import { buildRegistry } from '../packages/server/src/connectors.js'

const [kind, ...rest] = process.argv.slice(2)
if (!kind) {
  console.error('usage: pnpm query <search|quote|ohlcv|news|earnings> …')
  process.exit(2)
}

function toQuery(): QueryInput {
  switch (kind) {
    case 'search':
      return { kind, params: { q: rest } }
    case 'quote':
      return { kind, params: { symbols: rest } }
    case 'ohlcv': {
      const [symbols, interval = '1d', range = '3mo'] = [rest.slice(0, -2), rest.at(-2), rest.at(-1)] as const
      return { kind, params: { symbols: symbols.length ? symbols : rest, interval: interval as any, range: range as any } }
    }
    case 'news': {
      const limit = Number(rest.at(-1))
      return { kind, params: Number.isFinite(limit) ? { symbols: rest.slice(0, -1), limit } : { symbols: rest } }
    }
    case 'earnings':
      return { kind, params: { symbols: rest.slice(0, -2), from: rest.at(-2)!, to: rest.at(-1)! } }
    default:
      throw new Error(`unknown kind ${kind}`)
  }
}

const log = (m: string) => console.error(m)
const home = terminalHome()
let registry: ConnectorRegistry
if (existsSync(configPath(home))) {
  log(`connectors from ${configPath(home)}`)
  registry = buildRegistry(loadConfig({ home }), { cache: new MemoryCache(), log })
} else {
  log('no config.yml; using yahoo only')
  registry = new ConnectorRegistry({ cache: new MemoryCache(), log })
  registry.register(yahoo, {})
}

const frame = await registry.run(toQuery())
console.error(`${frame.rows.length} rows from ${frame.meta.connector} (ttl ${frame.meta.ttl}ms)`)
console.log(frame.columns.map((c) => c.name).join('\t'))
for (const row of frame.rows) console.log(row.map((v) => (v instanceof Date ? v.toISOString() : String(v))).join('\t'))
