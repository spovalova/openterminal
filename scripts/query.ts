// Print a frame from the registry without the app.
//
//   pnpm query <connector> <route> key=value …     v2: one route of one connector, params validated against its descriptor
//   pnpm query <recipe> key=value …                v2: a recipe (built-in or ~/.terminal/recipes.yml), e.g. `pnpm query ohlcv symbols=NVDA range=1y`
//   pnpm query <kind> key=value …                  v1: a kind (until phase 3); comma lists become arrays, numbers become numbers
//   legacy positional forms:  search <terms…> | quote <symbols…> | ohlcv <symbols…> <interval> <range> | news <symbols…> [limit] | earnings <symbols…> <from> <to>
//
// Connectors come from ~/.terminal/config.yml (TERMINAL_HOME overrides the directory) when it exists, else yahoo only.
// `pnpm query --help` lists every recipe and kind with its params; `pnpm query <connector> --routes [filter]` lists a connector's routes.
import { existsSync } from 'node:fs'
import {
  ConnectorRegistry,
  KINDS,
  KIND_NAMES,
  MemoryCache,
  describeDescriptor,
  parseQuery,
  recipeParams,
  recipeSummaryLines,
  type AnyQuery,
  type Kind,
  type KindDef,
  type Query,
  type Recipe,
} from '@terminal/core'
import { builtinAnnotations, builtinRecipes } from '@terminal/core/node'
import yahoo from '@terminal/connector-yahoo'
import { renderParams } from '../packages/server/src/agent/prompt.js'
import { configPath, loadConfig, terminalHome } from '../packages/server/src/config.js'
import { BUILTIN_CONNECTORS, buildRegistry } from '../packages/server/src/connectors.js'
import { loadUserRecipes } from '../packages/server/src/routes-data.js'

const LEGACY = new Set<string>(['search', 'quote', 'ohlcv', 'news', 'earnings'])
const log = (m: string) => console.error(m)
const home = terminalHome()

// ---------- registry (built first: the usage text and the route lookups need the recipes and the descriptors) ----------

const recipes: Recipe[] = [...builtinRecipes(), ...loadUserRecipes(home, log)]
let registry: ConnectorRegistry
if (existsSync(configPath(home))) {
  log(`connectors from ${configPath(home)}`)
  registry = buildRegistry(loadConfig({ home }), { cache: new MemoryCache(), log, recipes, annotations: builtinAnnotations() })
} else {
  log('no config.yml; using yahoo only')
  registry = new ConnectorRegistry({ cache: new MemoryCache(), log, recipes, annotations: builtinAnnotations() })
  registry.register(yahoo, {})
}
const connectorNames = new Set([...registry.connectors().map((c) => c.name), ...Object.keys(BUILTIN_CONNECTORS)])
const recipeByName = new Map(recipes.map((r) => [r.name, r]))

function usage(): string {
  const lines = [
    'usage:',
    '  pnpm query <connector> <route> key=value …   one route (pnpm query openbb equity/price/quote symbol=NVDA provider=yfinance)',
    '  pnpm query <connector> --routes [filter]     list a connector\'s routes',
    '  pnpm query <recipe> key=value …              a recipe (pnpm query ohlcv symbols=NVDA,AMD range=1y)',
    '  pnpm query <kind> key=value …                a v1 kind, exact v1 path (pnpm query options symbol=NVDA strikes=5)',
    '  pnpm query search <terms…> | quote <symbols…> | ohlcv <symbols…> <interval> <range> | news <symbols…> [limit] | earnings <symbols…> <from> <to>',
    '',
    `connectors: ${[...connectorNames].join(', ')}`,
    '',
    'recipes:',
    ...recipeSummaryLines(recipes).map((l) => `  ${l}`),
    '',
    'kinds (v1):',
  ]
  for (const kind of KIND_NAMES) lines.push(`  ${kind.padEnd(15)} ${renderParams((KINDS[kind] as KindDef).params)}`)
  return lines.join('\n')
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.error(usage())
  process.exit(argv.length === 0 ? 2 : 0)
}
const [first, ...rest] = argv as [string, ...string[]]

// ---------- key=value parsing ----------

const scalar = (s: string): unknown => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s)

/** `key=value` pairs → an object; comma lists become arrays of strings (descriptors and recipe schemas coerce the rest). */
function keyValues(args: string[], what: string): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const arg of args) {
    const eq = arg.indexOf('=')
    if (eq <= 0) {
      console.error(`expected key=value, got "${arg}" (${what})`)
      process.exit(2)
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
    const via = lineage?.route ? ` via ${lineage.connector} ${lineage.route}${lineage.provider ? ` (${lineage.provider})` : ''}` : ''
    console.error(`${frame.rows.length} rows from ${frame.meta.connector}${via} (ttl ${frame.meta.ttl}ms)`)
    const units = frame.meta.fields ? Object.entries(frame.meta.fields).filter(([, f]) => f.unit).map(([n, f]) => `${n}:${f.unit}`) : []
    if (units.length) console.error(`units: ${units.join(' ')}`)
    console.log(frame.columns.map((c) => c.name).join('\t'))
    for (const row of frame.rows) console.log(row.map((v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v))).join('\t'))
  } catch (err) {
    console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// ---------- v2: connector route ----------

if (connectorNames.has(first) && !(KIND_NAMES as readonly string[]).includes(first)) {
  const [route, ...kv] = rest
  if (!route) {
    console.error(`usage: pnpm query ${first} <route> key=value …  (or --routes [filter])`)
    process.exit(2)
  }
  if (route === '--routes') {
    const filter = kv[0]?.toLowerCase()
    const all = await registry.descriptorsOf(first)
    const shown = filter ? all.filter((d) => d.route.toLowerCase().includes(filter) || d.summary.toLowerCase().includes(filter)) : all
    for (const d of shown) console.log(describeDescriptor(d))
    console.error(`${shown.length} of ${all.length} routes on ${first}`)
    process.exit(0)
  }
  const descriptor = await registry.descriptorFor(first, route)
  if (!descriptor) {
    console.error(`${first} has no route "${route}". Run \`pnpm query ${first} --routes ${route.split('/').pop() ?? ''}\` to search.`)
    process.exit(2)
  }
  const params = keyValues(kv, describeDescriptor(descriptor))
  // typed descriptor params: a number param typed as "5" stays a string here; parseParams coerces it
  await print({ connector: first, route, params })
  process.exit(0)
}

// ---------- v2: recipe (names that are not v1 kinds, or kinds asked for with key=value when the v1 kind is gone) ----------

const isKind = (KIND_NAMES as readonly string[]).includes(first)
if (!isKind) {
  const recipe = recipeByName.get(first)
  if (!recipe) {
    console.error(`unknown connector, recipe or kind "${first}".\nconnectors: ${[...connectorNames].join(', ')}\nrecipes: ${recipes.map((r) => r.name).join(', ')}\nRun \`pnpm query --help\` for the params of each.`)
    process.exit(2)
  }
  const params = keyValues(rest, `${recipe.name}(${recipeParams(recipe).map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ')})`)
  for (const [k, v] of Object.entries(params)) {
    const p = recipeParams(recipe).find((x) => x.name === k)
    if (p && (p.type === 'number' || p.type === 'integer') && typeof v === 'string') params[k] = scalar(v)
    if (p && p.type === 'string[]' && typeof v === 'string') params[k] = [v]
  }
  await print({ recipe: recipe.name, params })
  process.exit(0)
}

// ---------- v1 kind path (exactly as before) ----------

const kind = first as Kind

type Def = { type: string; innerType?: { def: Def } }
type Field = { def: Def; safeParse(v: unknown): { success: boolean } }

function isArrayField(field: Field): boolean {
  let d: Def | undefined = field.def
  while (d) {
    if (d.type === 'array') return true
    d = d.innerType?.def
  }
  return false
}

function coerce(field: Field, raw: string): unknown {
  if (isArrayField(field)) {
    const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    const coerced = parts.map(scalar)
    return field.safeParse(coerced).success || !field.safeParse(parts).success ? coerced : parts
  }
  const n = scalar(raw)
  return field.safeParse(n).success || !field.safeParse(raw).success ? n : raw
}

function genericParams(): Record<string, unknown> {
  const shape = ((KINDS[kind] as KindDef).params as unknown as { shape: Record<string, Field> }).shape
  const params: Record<string, unknown> = {}
  for (const arg of rest) {
    const eq = arg.indexOf('=')
    if (eq <= 0) {
      console.error(`expected key=value, got "${arg}". Params for ${kind}: ${renderParams((KINDS[kind] as KindDef).params)}`)
      process.exit(2)
    }
    const key = arg.slice(0, eq)
    const value = arg.slice(eq + 1)
    const field = shape[key]
    if (!field) {
      console.error(`unknown param "${key}" for ${kind}. Params: ${renderParams((KINDS[kind] as KindDef).params)}`)
      process.exit(2)
    }
    params[key] = coerce(field, value)
  }
  return params
}

function legacyParams(): Record<string, unknown> {
  switch (kind) {
    case 'search':
      return { q: rest }
    case 'quote':
      return { symbols: rest }
    case 'ohlcv': {
      const [symbols, interval = '1d', range = '3mo'] = [rest.slice(0, -2), rest.at(-2), rest.at(-1)] as const
      return { symbols: symbols.length ? symbols : rest, interval, range }
    }
    case 'news': {
      const limit = Number(rest.at(-1))
      return Number.isFinite(limit) ? { symbols: rest.slice(0, -1), limit } : { symbols: rest }
    }
    case 'earnings':
      return { symbols: rest.slice(0, -2), from: rest.at(-2), to: rest.at(-1) }
    default:
      return {}
  }
}

const generic = rest.some((a) => a.includes('=')) || (rest.length === 0 && !LEGACY.has(kind))
if (!generic && !LEGACY.has(kind)) {
  console.error(`${kind} takes key=value params: ${renderParams((KINDS[kind] as KindDef).params)}`)
  process.exit(2)
}
const params = generic ? genericParams() : legacyParams()

let query: Query
try {
  query = parseQuery({ kind, params })
} catch (err) {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues
  const detail = issues ? issues.map((i) => `  ${i.path.map(String).join('.') || '(params)'}: ${i.message}`).join('\n') : String(err)
  console.error(`invalid ${kind} params ${JSON.stringify(params)}:\n${detail}\nexpected: ${renderParams((KINDS[kind] as KindDef).params)}`)
  process.exit(2)
}
await print(query)
