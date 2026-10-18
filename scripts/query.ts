// Print a frame from the registry without the app: `pnpm query ohlcv AAPL 1d 3mo`.
//
// Generic form, any kind:   pnpm query <kind> key=value key=a,b …   (comma lists become arrays, numbers become numbers)
// Legacy positional forms:  search <terms…> | quote <symbols…> | ohlcv <symbols…> <interval> <range> | news <symbols…> [limit] | earnings <symbols…> <from> <to>
// Params are validated by core's parseQuery; `pnpm query --help` lists every kind with its params.
// Connectors come from ~/.terminal/config.yml (TERMINAL_HOME overrides the directory) when it exists, else yahoo only.
import { existsSync } from 'node:fs'
import { ConnectorRegistry, KINDS, KIND_NAMES, MemoryCache, parseQuery, type Kind, type KindDef, type Query } from '@terminal/core'
import yahoo from '@terminal/connector-yahoo'
import { renderParams } from '../packages/server/src/agent/prompt.js'
import { configPath, loadConfig, terminalHome } from '../packages/server/src/config.js'
import { buildRegistry } from '../packages/server/src/connectors.js'

const LEGACY = new Set<string>(['search', 'quote', 'ohlcv', 'news', 'earnings'])

function usage(): string {
  const lines = [
    'usage:',
    '  pnpm query <kind> key=value [key=a,b …]     any kind; comma lists become arrays, numbers become numbers',
    '  pnpm query search <terms…>',
    '  pnpm query quote <symbols…>',
    '  pnpm query ohlcv <symbols…> <interval> <range>',
    '  pnpm query news <symbols…> [limit]',
    '  pnpm query earnings <symbols…> <from> <to>',
    '',
    'examples:',
    '  pnpm query options symbol=NVDA strikes=5',
    '  pnpm query macro series=treasury_10y,treasury_2y range=2y',
    '  pnpm query calendar from=2026-10-19 to=2026-10-23',
    '  pnpm query movers list=losers limit=10',
    '',
    'kinds:',
  ]
  for (const kind of KIND_NAMES) lines.push(`  ${kind.padEnd(15)} ${renderParams((KINDS[kind] as KindDef).params)}`)
  return lines.join('\n')
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.error(usage())
  process.exit(argv.length === 0 ? 2 : 0)
}
const [kindArg, ...rest] = argv
if (!(KIND_NAMES as readonly string[]).includes(kindArg!)) {
  console.error(`unknown kind "${kindArg}". Kinds: ${KIND_NAMES.join(', ')}.\nRun \`pnpm query --help\` for the params of each.`)
  process.exit(2)
}
const kind = kindArg as Kind

// ---------- argument parsing ----------

type Def = { type: string; innerType?: { def: Def } }
type Field = { def: Def; safeParse(v: unknown): { success: boolean } }

/** True when the param is an array (through optional/default wrappers). */
function isArrayField(field: Field): boolean {
  let d: Def | undefined = field.def
  while (d) {
    if (d.type === 'array') return true
    d = d.innerType?.def
  }
  return false
}

/** Coerce one `key=value` to what the kind's param schema accepts: a number, a string, or an array of either. */
function coerce(field: Field, raw: string): unknown {
  const scalar = (s: string): unknown => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s)
  if (isArrayField(field)) {
    const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    const coerced = parts.map(scalar)
    // Prefer what validates; otherwise the natural coercion, so parseQuery reports the real problem (range, enum).
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

// ---------- registry ----------

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

try {
  const frame = await registry.run(query)
  console.error(`${frame.rows.length} rows from ${frame.meta.connector} (ttl ${frame.meta.ttl}ms)`)
  console.log(frame.columns.map((c) => c.name).join('\t'))
  for (const row of frame.rows) console.log(row.map((v) => (v instanceof Date ? v.toISOString() : String(v))).join('\t'))
} catch (err) {
  console.error(`${kind} failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
