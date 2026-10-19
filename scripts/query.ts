// Print a frame from the registry without the app.
//
//   pnpm query <recipe> key=value …                a recipe (built-in or ~/.openterminal/recipes.yml), e.g. `pnpm query ohlcv symbols=NVDA range=1y`
//   pnpm query <connector> <route> key=value …     one route of one connector, params validated against its descriptor
//   pnpm query <connector> --routes [filter]       list a connector's routes
//
// Comma lists become arrays; the recipe schema or the descriptor coerces numbers and booleans. Connectors come from
// ~/.openterminal/config.yml (OPENTERMINAL_HOME overrides the directory) when it exists, else yahoo only. Recipes whose data
// graph has a transform (options, earnings, news, …) start the Pyodide engine, which takes about twenty seconds cold.
// `pnpm query --help` lists every recipe with its params.
import { existsSync } from 'node:fs'
import { ConnectorRegistry, MemoryCache, describeDescriptor, recipeParams, recipeSummaryLines, type AnyQuery, type Recipe } from '@openterminal/core'
import { builtinAnnotations, builtinRecipes } from '@openterminal/core/node'
import yahoo from '@openterminal/connector-yahoo'
import { configPath, loadConfig } from '../packages/server/src/config.js'
import { resolveHome } from '../packages/server/src/home.js'
import { BUILTIN_CONNECTORS, buildRegistry } from '../packages/server/src/connectors.js'
import { loadUserRecipes } from '../packages/server/src/routes-data.js'
import { createTransformEngine } from '../packages/server/src/transform/index.js'

const log = (m: string) => console.error(m)
const home = resolveHome(process.env, { log })

// ---------- registry (built first: the usage text and the route lookups need the recipes and the descriptors) ----------

const recipes: Recipe[] = [...builtinRecipes(), ...loadUserRecipes(home, log)]
const engine = createTransformEngine({ log })
let registry: ConnectorRegistry
if (existsSync(configPath(home))) {
  log(`connectors from ${configPath(home)}`)
  registry = buildRegistry(loadConfig({ home }), { cache: new MemoryCache(), log, recipes, annotations: builtinAnnotations(), transform: engine })
} else {
  log('no config.yml; using yahoo only')
  registry = new ConnectorRegistry({ cache: new MemoryCache(), log, recipes, annotations: builtinAnnotations(), transform: engine })
  registry.register(yahoo, {})
}
const connectorNames = new Set([...registry.connectors().map((c) => c.name), ...Object.keys(BUILTIN_CONNECTORS)])
const recipeByName = new Map(recipes.map((r) => [r.name, r]))

function usage(): string {
  return [
    'usage:',
    '  pnpm query <recipe> key=value …              a recipe (pnpm query ohlcv symbols=NVDA,AMD range=1y; pnpm query options symbol=NVDA strikes=5)',
    '  pnpm query <connector> <route> key=value …   one route (pnpm query openbb equity/price/quote symbol=NVDA provider=yfinance)',
    '  pnpm query <connector> --routes [filter]     list a connector\'s routes',
    '',
    `connectors: ${[...connectorNames].join(', ')}`,
    '',
    'recipes:',
    ...recipeSummaryLines(recipes).map((l) => `  ${l}`),
  ].join('\n')
}

async function exit(code: number): Promise<never> {
  await engine.close()
  process.exit(code)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.error(usage())
  await exit(argv.length === 0 ? 2 : 0)
}
const [first, ...rest] = argv as [string, ...string[]]

// ---------- key=value parsing ----------

const scalar = (s: string): unknown => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s)

/** `key=value` pairs → an object; comma lists become arrays of strings (descriptors and recipe schemas coerce the rest). */
async function keyValues(args: string[], what: string): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {}
  for (const arg of args) {
    const eq = arg.indexOf('=')
    if (eq <= 0) {
      console.error(`expected key=value, got "${arg}" (${what})`)
      await exit(2)
    }
    const key = arg.slice(0, eq)
    const value = arg.slice(eq + 1)
    params[key] = value.includes(',') ? value.split(',').map((s) => s.trim()).filter(Boolean) : value
  }
  return params
}

async function print(query: AnyQuery): Promise<void> {
  try {
    const frame = await registry.run(query)
    const lineage = frame.meta.lineage
    const via = lineage?.route ? ` via ${lineage.connector} ${lineage.route}${lineage.provider ? ` (${lineage.provider})` : ''}` : lineage?.code ? ' via a transform' : ''
    console.error(`${frame.rows.length} rows from ${frame.meta.connector}${via} (ttl ${frame.meta.ttl}ms)`)
    const units = frame.meta.fields ? Object.entries(frame.meta.fields).filter(([, f]) => f.unit).map(([n, f]) => `${n}:${f.unit}`) : []
    if (units.length) console.error(`units: ${units.join(' ')}`)
    console.log(frame.columns.map((c) => c.name).join('\t'))
    for (const row of frame.rows) console.log(row.map((v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v))).join('\t'))
  } catch (err) {
    console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`)
    await exit(1)
  }
}

// ---------- a connector route ----------

if (connectorNames.has(first) && !recipeByName.has(first)) {
  const [route, ...kv] = rest
  if (!route) {
    console.error(`usage: pnpm query ${first} <route> key=value …  (or --routes [filter])`)
    await exit(2)
  }
  if (route === '--routes') {
    const filter = kv[0]?.toLowerCase()
    const all = await registry.descriptorsOf(first)
    const shown = filter ? all.filter((d) => d.route.toLowerCase().includes(filter) || d.summary.toLowerCase().includes(filter)) : all
    for (const d of shown) console.log(describeDescriptor(d))
    console.error(`${shown.length} of ${all.length} routes on ${first}`)
    await exit(0)
  }
  const descriptor = await registry.descriptorFor(first, route!)
  if (!descriptor) {
    console.error(`${first} has no route "${route}". Run \`pnpm query ${first} --routes ${route!.split('/').pop() ?? ''}\` to search.`)
    await exit(2)
  }
  const params = await keyValues(kv, describeDescriptor(descriptor!))
  // typed descriptor params: a number param typed as "5" stays a string here; parseParams coerces it
  await print({ connector: first, route: route!, params })
  await exit(0)
}

// ---------- a recipe ----------

const recipe = recipeByName.get(first)
if (!recipe) {
  console.error(`unknown recipe or connector "${first}".\nconnectors: ${[...connectorNames].join(', ')}\nrecipes: ${recipes.map((r) => r.name).join(', ')}\nRun \`pnpm query --help\` for the params of each.`)
  await exit(2)
}
const params = await keyValues(rest, `${recipe!.name}(${recipeParams(recipe!).map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ')})`)
for (const [k, v] of Object.entries(params)) {
  const p = recipeParams(recipe!).find((x) => x.name === k)
  if (p && (p.type === 'number' || p.type === 'integer') && typeof v === 'string') params[k] = scalar(v)
  if (p && p.type === 'string[]' && typeof v === 'string') params[k] = [v]
}
await print({ recipe: recipe!.name, params })
await exit(0)
