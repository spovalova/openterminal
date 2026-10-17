// ~/.terminal/config.yml: the LLM key and the connector list in priority order.
// The directory is overridable with TERMINAL_HOME. Created with defaults on first run.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Document, parse, parseDocument, isMap, isSeq, YAMLSeq } from 'yaml'
import { z } from 'zod'
import { DEFAULT_MODEL } from './agent/index.js'

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

export const DEFAULT_CONFIG_YML = `# terminal config. Keys never leave this machine.
#
# llm: the model that turns prompts into workspaces. Leave empty to use
# ANTHROPIC_API_KEY / OPENAI_API_KEY from the environment, or fill it in:
#   llm:
#     provider: anthropic   # or openai
#     model: ${DEFAULT_MODELS.anthropic}
#     apiKey: sk-ant-...
llm:

# connectors: answered in this order (first wins, the rest are fallbacks).
# yahoo needs no key. finnhub takes { apiKey } (free key at finnhub.io).
connectors:
  - name: yahoo
`

/** `TERMINAL_HOME` or `~/.terminal`. */
export function terminalHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TERMINAL_HOME?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.terminal')
}

export function configPath(home: string): string {
  return join(home, 'config.yml')
}

export function workspacesDir(home: string): string {
  return join(home, 'workspaces')
}

/** Creates the home directory, the workspaces directory, and a default config.yml when missing. Returns the config path. */
export function ensureHome(home: string): string {
  mkdirSync(workspacesDir(home), { recursive: true })
  const file = configPath(home)
  if (!existsSync(file)) writeFileSync(file, DEFAULT_CONFIG_YML, 'utf8')
  return file
}

export type LoadConfigOptions = { home?: string; env?: NodeJS.ProcessEnv }

/**
 * Parse config.yml (creating it on first run) and fill `llm` from the environment when the file
 * has no usable key: a partial `llm` (provider without apiKey) takes that provider's env var,
 * an empty `llm` takes the first provider whose env var is set.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env
  const home = opts.home ?? terminalHome(env)
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
  let doc: Document = parseDocument(readFileSync(file, 'utf8'))
  if (doc.errors.length > 0) throw new Error(`invalid ${file}: ${doc.errors[0]!.message}`)
  if (!isMap(doc.contents)) doc = new Document({})

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

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, doc.toString(), 'utf8')
  renameSync(tmp, file)
  return normalizeConfig(parse(doc.toString()), process.env, file)
}
