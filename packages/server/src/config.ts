// ~/.openterminal/config.yml: the LLM key and the connector list in priority order.
// The directory is overridable with OPENTERMINAL_HOME (see home.ts). Created with defaults on first run.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, parse, parseDocument, isMap, isSeq, YAMLSeq } from 'yaml'
import { z } from 'zod'
import { DEFAULT_MODEL } from './agent/index.js'
import { resolveHome } from './home.js'

export { openterminalHome } from '@openterminal/core/node'

export const PROVIDERS = ['anthropic', 'openai'] as const
export type Provider = (typeof PROVIDERS)[number]

/** Model used when config.yml names a provider but no model. Defined once in agent/index.ts. */
export const DEFAULT_MODELS: Record<Provider, string> = DEFAULT_MODEL

const ENV_KEYS: Record<Provider, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }

export const LlmConfigSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1),
})
export type LlmConfig = z.infer<typeof LlmConfigSchema>

export const ConnectorEntrySchema = z.object({
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
})
export type ConnectorEntry = z.infer<typeof ConnectorEntrySchema>

export const ConfigSchema = z.object({
  llm: LlmConfigSchema.optional(),
  connectors: z.array(ConnectorEntrySchema).default([]),
})
export type Config = z.output<typeof ConfigSchema>

export const DEFAULT_CONFIG_YML = `# Open Terminal config. Keys never leave this machine.
#
# llm: the model that turns prompts into workspaces. Leave empty to use
# ANTHROPIC_API_KEY / OPENAI_API_KEY from the environment, or fill it in:
#   llm:
#     provider: anthropic   # or openai
#     model: ${DEFAULT_MODELS.anthropic}
#     apiKey: sk-ant-...
llm:

# connectors: answered in this order (first wins, the rest are fallbacks).
# openbb answers OpenBB's routes: the providers ported to TypeScript need no
#   install; a running OpenBB Platform API (pip install "openbb[routers]"
#   openbb-yfinance, then openbb-api) adds the rest. When neither can answer, the
#   miss costs nothing and yahoo answers. Options: { baseUrl, native: prefer|only|off,
#   credentials: { fred_api_key: ... }, providers: { equity/price/quote: cboe, ... } }.
# yahoo needs no key. finnhub takes { apiKey } (free key at finnhub.io).
connectors:
  - name: openbb
  - name: yahoo
`

export function configPath(home: string): string {
  return join(home, 'config.yml')
}

export function workspacesDir(home: string): string {
  return join(home, 'workspaces')
}

/** config.yml holds API keys, so it is readable by its owner only. */
export const CONFIG_FILE_MODE = 0o600

/** Creates the home directory, the workspaces directory, and a default config.yml when missing. Returns the config path. */
export function ensureHome(home: string): string {
  mkdirSync(workspacesDir(home), { recursive: true })
  const file = configPath(home)
  if (!existsSync(file)) writeFileSync(file, DEFAULT_CONFIG_YML, { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  return file
}

/** Replace config.yml atomically (temp file then rename), owner-only. */
function writeConfigFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  // `mode` is masked by the umask; set it outright so the key is never group- or world-readable.
  chmodSync(tmp, CONFIG_FILE_MODE)
  renameSync(tmp, file)
}

/** config.yml as a YAML document (comments kept), an empty map when the file holds something else. */
function readConfigDocument(file: string): Document {
  const doc: Document = parseDocument(readFileSync(file, 'utf8'))
  if (doc.errors.length > 0) throw new Error(`invalid ${file}: ${doc.errors[0]!.message}`)
  return isMap(doc.contents) ? doc : new Document({})
}

export type LoadConfigOptions = { home?: string; env?: NodeJS.ProcessEnv }

/**
 * Parse config.yml (creating it on first run) and fill `llm` from the environment when the file
 * has no usable key: a partial `llm` (provider without apiKey) takes that provider's env var,
 * an empty `llm` takes the first provider whose env var is set.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env
  const home = opts.home ?? resolveHome(env)
  const file = ensureHome(home)
  const raw = parse(readFileSync(file, 'utf8')) as unknown
  return normalizeConfig(raw, env, file)
}

/** Validate a raw YAML document into a Config. Exported for tests. */
export function normalizeConfig(raw: unknown, env: NodeJS.ProcessEnv = {}, file = 'config.yml'): Config {
  const doc: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  doc.llm = resolveLlm(doc.llm, env)
  if (doc.connectors == null) doc.connectors = []
  const parsed = ConfigSchema.safeParse(doc)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`invalid ${file}: ${issues}`)
  }
  return parsed.data
}

function resolveLlm(raw: unknown, env: NodeJS.ProcessEnv): LlmConfig | undefined {
  const llm = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  const provider = typeof llm.provider === 'string' && (PROVIDERS as readonly string[]).includes(llm.provider) ? (llm.provider as Provider) : undefined
  const fileKey = typeof llm.apiKey === 'string' && llm.apiKey.trim().length > 0 ? llm.apiKey.trim() : undefined
  const model = typeof llm.model === 'string' && llm.model.trim().length > 0 ? llm.model.trim() : undefined

  if (provider && fileKey) return { provider, apiKey: fileKey, ...(model ? { model } : {}) }
  if (provider) {
    const envKey = env[ENV_KEYS[provider]]?.trim()
    return envKey ? { provider, apiKey: envKey, ...(model ? { model } : {}) } : undefined
  }
  for (const p of PROVIDERS) {
    const envKey = env[ENV_KEYS[p]]?.trim()
    if (envKey) return { provider: p, apiKey: envKey, ...(model ? { model } : {}) }
  }
  return undefined
}

/** The llm block with the model filled in, in the shape the agent runner takes. */
export function resolvedLlm(config: Config): { provider: Provider; model: string; apiKey: string } | undefined {
  if (!config.llm) return undefined
  return { provider: config.llm.provider, model: config.llm.model ?? DEFAULT_MODELS[config.llm.provider], apiKey: config.llm.apiKey }
}

/**
 * Write a connector's config back to config.yml, keeping the rest of the file (and its comments).
 * Appends the connector to the list when it is not configured yet. Atomic (temp file then rename).
 */
export function saveConnectorConfig(home: string, name: string, config: Record<string, unknown>): Config {
  const file = ensureHome(home)
  const doc = readConfigDocument(file)

  let seq = doc.get('connectors')
  if (!isSeq(seq)) {
    seq = new YAMLSeq()
    doc.set('connectors', seq)
  }
  const list = seq as YAMLSeq
  const existing = list.items.find((item) => isMap(item) && item.get('name') === name)
  if (existing && isMap(existing)) {
    existing.set('config', doc.createNode(config))
  } else {
    list.add(doc.createNode({ name, config }))
  }

  writeConfigFile(file, doc.toString())
  return normalizeConfig(parse(doc.toString()), process.env, file)
}

/**
 * Write the `llm` block (the first-run key prompt in the CLI): provider and key, plus the model when given, replacing
 * whatever `llm` held and keeping the rest of the file and its comments. Owner-only (mode 600), atomic.
 */
export function saveLlmConfig(home: string, llm: { provider: Provider; apiKey: string; model?: string }): Config {
  const parsed = LlmConfigSchema.parse(llm)
  const file = ensureHome(home)
  const doc = readConfigDocument(file)
  doc.set('llm', doc.createNode({ provider: parsed.provider, ...(parsed.model ? { model: parsed.model } : {}), apiKey: parsed.apiKey }))
  writeConfigFile(file, doc.toString())
  return normalizeConfig(parse(doc.toString()), {}, file)
}
