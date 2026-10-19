// Wires config → store → registry → agent → HTTP + WebSocket, and serves. Entry point for `pnpm start`.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import { ConnectorRegistry, type AgentRunner, type Registry } from '@terminal/core'
import { builtinAnnotations, builtinRecipes, loadAnnotationsFile } from '@terminal/core/node'
import { createAgentRunner } from './agent/index.js'
import { createApp, type App } from './app.js'
import { SqliteCache } from './cache-sqlite.js'
import { loadConfig, resolvedLlm, terminalHome, workspacesDir, type Config } from './config.js'
import { buildRegistry } from './connectors.js'
import { loadUserRecipes, type ProbeFn } from './routes-data.js'
import { RunLogRowSchema, type RunLog, type RunLogRow } from './runlog.js'
import { openStore, type MigrationReport, type Store } from './store/index.js'
import { createStubAgentRunner } from './stub-agent.js'
import { createTransformEngine, type ServerTransformEngine } from './transform/index.js'

export const DEFAULT_PORT = 4242

export type StartOptions = {
  /** Defaults to PORT or 4242. 0 picks a free port. */
  port?: number
  hostname?: string
  /** Defaults to TERMINAL_HOME or ~/.terminal. */
  home?: string
  env?: NodeJS.ProcessEnv
  log?: (msg: string) => void
  /** Injected for tests; otherwise built from config.yml. */
  registry?: Registry
  /** Injected for tests; otherwise the real runner when an LLM is configured, else the stub. */
  agent?: AgentRunner
  /** Built web app directory. Defaults to packages/web/dist; false disables static serving. */
  webDist?: string | false
  /** Injected for tests; otherwise SQLite at `<home>/terminal.db` with the JSON migration on first run. */
  store?: Store
  /** (a)'s catalog probe, when available. */
  probe?: ProbeFn
}

export type RunningServer = {
  url: string
  port: number
  hostname: string
  server: ServerType
  app: App['app']
  registry: Registry
  store: Store
  config: Config
  /** True when the real agent runner is in use. */
  llm: boolean
  /** What the store is and what the JSON migration did on this start (undefined when the store was injected). */
  storeKind: 'sqlite' | 'json' | 'injected'
  migration?: MigrationReport
  close(): Promise<void>
}

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_WEB_DIST = resolve(here, '../../web/dist')

/** (c)'s `RunLog` over (e)'s store: rows go to the `runs` table, extra fields kept whole. */
export function storeRunLog(store: Store): RunLog {
  return {
    async append(row: RunLogRow) {
      store.appendRun(RunLogRowSchema.parse(row))
    },
    async list(opts = {}) {
      return store.listRuns(opts).flatMap((r) => {
        const parsed = RunLogRowSchema.safeParse(r)
        return parsed.success ? [parsed.data] : []
      })
    },
  }
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((msg: string) => console.error(`[server] ${msg}`))
  const home = opts.home ?? terminalHome(env)
  const hostname = opts.hostname ?? '127.0.0.1'
  const port = opts.port ?? (Number(env.PORT) || DEFAULT_PORT)

  const config = loadConfig({ home, env })
  log(`home ${home}`)

  // The store: SQLite with the one-time JSON migration (PLAN.md section 17), the frame cache on the same file.
  let store: Store
  let storeKind: RunningServer['storeKind'] = 'injected'
  let migration: MigrationReport | undefined
  if (opts.store) store = opts.store
  else {
    const opened = openStore(home, { log, jsonDir: workspacesDir(home) })
    store = opened.store
    storeKind = opened.kind
    migration = opened.migration
    log(`store: ${opened.kind} at ${store.location}`)
  }

  // Recipes and annotations: the built-in files plus the user's (`<home>/recipes.yml`, `<home>/annotations.yml`).
  const userRecipes = loadUserRecipes(home, log)
  if (userRecipes.length > 0) store.setRecipes(userRecipes)
  const recipes = [...builtinRecipes(), ...store.listRecipes()]
  const userAnnotationsFile = resolve(home, 'annotations.yml')
  const builtin = builtinAnnotations()
  const annotations = existsSync(userAnnotationsFile) ? [...builtin, ...loadAnnotationsFile(userAnnotationsFile, { orderFrom: builtin.length })] : builtin
  log(`recipes: ${recipes.length} (${store.listRecipes().length} user) · annotations: ${annotations.length}`)

  const registry = opts.registry ?? buildRegistry(config, { log, cache: new SqliteCache(store), recipes, annotations })
  log(`kinds answerable: ${registry.kinds().join(', ') || '(none)'}`)

  const llm = resolvedLlm(config)
  let agent: AgentRunner
  let real = false
  if (opts.agent) {
    agent = opts.agent
    log('agent: injected')
  } else if (llm) {
    agent = createAgentRunner({ registry, llm, log, runLog: storeRunLog(store) })
    real = true
    log(`agent: ${llm.provider} ${llm.model}`)
  } else {
    agent = createStubAgentRunner({ kinds: () => registry.kinds() })
    log('agent: stub (no LLM key in config.yml or ANTHROPIC_API_KEY / OPENAI_API_KEY); prompts return the canned memory workspace')
  }

  const webDist = opts.webDist === false ? undefined : (opts.webDist ?? (existsSync(DEFAULT_WEB_DIST) ? DEFAULT_WEB_DIST : undefined))
  const { app, injectWebSocket, wss } = createApp({
    registry,
    store,
    agent,
    home,
    llm: real,
    log,
    webDist,
    builtinRecipes,
    storeInfo: () => ({ kind: storeKind, ...(migration ? { migration } : {}) }),
    ...(opts.probe ? { probe: opts.probe } : {}),
  })

  const server = await new Promise<ServerType>((resolveServer) => {
    const s = serve({ fetch: app.fetch, port, hostname }, () => resolveServer(s))
  })
  injectWebSocket(server)
  // The transform engine (phase 1 (b)): one Pyodide worker, warmed after listen so the first prompt does not pay the
  // cold start. A server started with an injected registry (tests) runs without one.
  let transform: ServerTransformEngine | undefined
  if (!opts.registry && registry instanceof ConnectorRegistry) {
    transform = createTransformEngine({ log })
    registry.setTransformEngine(transform)
    void transform.warmup().catch((err: unknown) => log(`transform engine warmup failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${boundPort}`

  return {
    url,
    port: boundPort,
    hostname,
    server,
    app,
    registry,
    store,
    config,
    llm: real,
    storeKind,
    ...(migration ? { migration } : {}),
    close: async () => {
      await transform?.close()
      await new Promise<void>((resolveClose, reject) => {
        for (const client of wss.clients) client.terminate()
        wss.close()
        server.close((err) => {
          if (!opts.store) store.close()
          if (err) reject(err)
          else resolveClose()
        })
      })
    },
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  const running = await startServer()
  console.error(`[server] listening on ${running.url}`)
  const shutdown = () => {
    running.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
