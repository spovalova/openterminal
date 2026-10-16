// Wires config → registry → store → agent → HTTP + WebSocket, and serves. Entry point for `pnpm start`.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import type { AgentRunner, Registry } from '@terminal/core'
import { createAgentRunner } from './agent/index.js'
import { createApp, type App } from './app.js'
import { loadConfig, resolvedLlm, terminalHome, workspacesDir, type Config } from './config.js'
import { buildRegistry } from './connectors.js'
import { WorkspaceStore } from './store.js'
import { createStubAgentRunner } from './stub-agent.js'

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
}

export type RunningServer = {
  url: string
  port: number
  hostname: string
  server: ServerType
  app: App['app']
  registry: Registry
  store: WorkspaceStore
  config: Config
  /** True when the real agent runner is in use. */
  llm: boolean
  close(): Promise<void>
}

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_WEB_DIST = resolve(here, '../../web/dist')

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((msg: string) => console.error(`[server] ${msg}`))
  const home = opts.home ?? terminalHome(env)
  const hostname = opts.hostname ?? '127.0.0.1'
  const port = opts.port ?? (Number(env.PORT) || DEFAULT_PORT)

  const config = loadConfig({ home, env })
  log(`home ${home}`)
  const registry = opts.registry ?? buildRegistry(config, { log })
  log(`kinds answerable: ${registry.kinds().join(', ') || '(none)'}`)
  const store = new WorkspaceStore(workspacesDir(home), { log })

  const llm = resolvedLlm(config)
  let agent: AgentRunner
  let real = false
  if (opts.agent) {
    agent = opts.agent
    log('agent: injected')
  } else if (llm) {
    agent = createAgentRunner({ registry, llm, log })
    real = true
    log(`agent: ${llm.provider} ${llm.model}`)
  } else {
    agent = createStubAgentRunner({ kinds: () => registry.kinds() })
    log('agent: stub (no LLM key in config.yml or ANTHROPIC_API_KEY / OPENAI_API_KEY); prompts return the canned memory workspace')
  }

  const webDist = opts.webDist === false ? undefined : (opts.webDist ?? (existsSync(DEFAULT_WEB_DIST) ? DEFAULT_WEB_DIST : undefined))
  const { app, injectWebSocket, wss } = createApp({ registry, store, agent, home, llm: real, log, webDist })

  const server = await new Promise<ServerType>((resolveServer) => {
    const s = serve({ fetch: app.fetch, port, hostname }, () => resolveServer(s))
  })
  injectWebSocket(server)
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
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        for (const client of wss.clients) client.terminate()
        wss.close()
        server.close((err) => (err ? reject(err) : resolveClose()))
      }),
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
