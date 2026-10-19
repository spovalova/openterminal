// Probe every route of the catalog (PLAN.md section 17): one call per route with default params and a sample
// symbol, eight at a time, liveness recorded on the catalog and in ~/.terminal/catalog/liveness.json.
//
//   pnpm probe                              every route of every configured connector (a few minutes for OpenBB)
//   pnpm probe --connector=openbb --match=equity/*   one connector, routes matching a glob
//   pnpm probe --limit=50 --concurrency=4 --timeout=10000
//   pnpm probe --json=/tmp/probe.json       also write every result (params, provider, error) to a file
//   pnpm probe --no-store                   do not write liveness rows
//   pnpm probe --ci                         no network: generate descriptors from the core fixture and check that
//                                           every one gets sample params that validate
//
// Connectors come from ~/.terminal/config.yml (TERMINAL_HOME overrides the directory); liveness rows go to the
// store the server reads (`<home>/terminal.db`), so the Data page shows them. Nothing here is committed; the summary
// goes to docs/notes/openbb-probe.md by hand.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ConnectorRegistry, DescriptorSchema, MemoryCache, descriptorsFromOpenApi, globToRegExp } from '@terminal/core'
import { builtinAnnotations, builtinRecipes } from '@terminal/core/node'
import { loadConfig, terminalHome, workspacesDir } from '../packages/server/src/config.js'
import { builtinConnector } from '../packages/server/src/connectors.js'
import { applyLiveness, livenessStoreOver } from '../packages/server/src/liveness.js'
import { probeCatalog, renderSummary, sampleParams } from '../packages/server/src/probe.js'
import { openStore } from '../packages/server/src/store/index.js'

const args = new Map<string, string>()
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
  if (!m) {
    console.error(`unexpected argument ${a}`)
    process.exit(2)
  }
  args.set(m[1]!, m[2] ?? 'true')
}
const log = (m: string) => console.error(m)

if (args.has('ci')) {
  const fixture = fileURLToPath(new URL('../packages/core/test/fixtures/openbb-openapi.json', import.meta.url))
  const descriptors = descriptorsFromOpenApi(JSON.parse(readFileSync(fixture, 'utf8')), 'openbb')
  let bad = 0
  for (const d of descriptors) {
    if (!DescriptorSchema.safeParse(d).success) {
      bad++
      log(`invalid descriptor: ${d.route}`)
    }
    const s = sampleParams(d)
    if ('skip' in s) log(`${d.route}: ${s.skip}`)
  }
  const expected = 38
  const ok = bad === 0 && descriptors.length === expected
  console.log(`ci: ${descriptors.length} descriptors from the fixture (expected ${expected}), ${bad} invalid, ${descriptors.filter((d) => 'params' in sampleParams(d)).length} with sample params`)
  process.exit(ok ? 0 : 1)
}

const home = terminalHome()
const config = loadConfig({ home })
const registry = new ConnectorRegistry({ cache: new MemoryCache(), log, recipes: builtinRecipes(), annotations: builtinAnnotations() })
for (const entry of config.connectors) {
  const connector = builtinConnector(entry.name)
  if (!connector) {
    log(`connector "${entry.name}" is not built in; skipped`)
    continue
  }
  const info = registry.register(connector, entry.config ?? {})
  log(`connector ${info.name}: ${info.status}${info.error ? ` (${info.error})` : ''} · ${info.mode}`)
}

const catalog = await registry.catalog()
const opened = args.has('no-store') ? undefined : openStore(home, { log, jsonDir: workspacesDir(home) })
const store = opened ? livenessStoreOver(opened.store) : undefined
if (opened && store) log(`${await applyLiveness(catalog, store)} liveness rows loaded from the ${opened.kind} store at ${opened.store.location}`)
const stats = catalog.stats()
log(`catalog: ${Object.entries(stats).map(([c, s]) => `${c} ${s.routes} routes`).join(', ')}`)

const connectors = args.get('connector')?.split(',').map((s) => s.trim()).filter(Boolean)
const matchGlob = args.get('match')
const match = matchGlob ? (d: { route: string }) => globToRegExp(matchGlob).test(d.route) || d.route === matchGlob : undefined
const summary = await probeCatalog(registry, catalog, {
  concurrency: Number(args.get('concurrency') ?? 8),
  timeoutMs: Number(args.get('timeout') ?? 20_000),
  limit: args.has('limit') ? Number(args.get('limit')) : undefined,
  connectors,
  match,
  store,
  log,
})
console.log(renderSummary(summary))
opened?.store.close()
if (args.has('json')) {
  writeFileSync(args.get('json')!, JSON.stringify(summary, null, 1), 'utf8')
  log(`results written to ${args.get('json')}`)
}
process.exit(0)
