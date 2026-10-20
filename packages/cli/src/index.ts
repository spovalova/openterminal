// CLI entry for `openterminal` (`npx openterminal`, or the checkout's bin/openterminal.js): parse the flags, start
// @openterminal/server and open the browser. The first interactive start without an LLM key asks for one; every
// start prints a short banner and, from the release bundle, checks at most once a day for a newer release.
import { closeSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isBundled } from '@openterminal/core/node'
import { BUILTIN_CONNECTORS, DEFAULT_PORT, configPath, loadConfig, resolveHome, resolvedLlm, saveLlmConfig, startServer, type Config, type RunningServer } from '@openterminal/server'
import { askHidden } from './prompt.js'
import { readState, statePath, updateState } from './state.js'
import { checkForUpdate, updateCheckDisabled } from './update-check.js'
import { VERSION } from './version.js'

export { VERSION } from './version.js'

export type StartCommand = { command: 'start'; port: number; open: boolean; verbose: boolean }
export type Command = StartCommand | { command: 'help' } | { command: 'version' }

export const KEY_PROMPT = 'Anthropic API key for the agent (Enter to skip): '
export const LOG_FILE = 'openterminal.log'

export const USAGE = `Open Terminal: the open-source, AI-native terminal for traders.

usage: openterminal [--port <n>] [--no-open] [--verbose]

  --port <n>   listen on port n (default: PORT or ${DEFAULT_PORT})
  --no-open    do not open the browser
  --verbose    print the server log here too (in a terminal it goes to ~/.openterminal/${LOG_FILE})
  --version    print the version
  --help       show this help

Config, workspaces and recipes live in ~/.openterminal (OPENTERMINAL_HOME overrides the directory).
OPENTERMINAL_NO_UPDATE_CHECK=1 turns off the daily check for a newer release.`

function portOf(value: string | undefined, flag: string): number {
  const n = Number(value)
  if (value === undefined || value === '' || !Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid ${flag} ${value ?? ''}`.trim())
  return n
}

/** argv (after `node openterminal`) → the command. Throws with the usage on anything it does not know. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Command {
  if (argv.some((a) => a === '--help' || a === '-h')) return { command: 'help' }
  if (argv.some((a) => a === '--version' || a === '-v' || a === '-V')) return { command: 'version' }
  const opts: StartCommand = { command: 'start', port: Number(env.PORT) || DEFAULT_PORT, open: true, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--no-open') opts.open = false
    else if (a === '--verbose') opts.verbose = true
    else if (a === '--port') opts.port = portOf(argv[++i], '--port')
    else if (a.startsWith('--port=')) opts.port = portOf(a.slice('--port='.length), '--port')
    else throw new Error(`unknown argument ${a}\n${USAGE}`)
  }
  return opts
}

/** `/home/me/.openterminal` → `~/.openterminal`, for display only. */
export function tilde(path: string, userHome: string = homedir()): string {
  return userHome && (path === userHome || path.startsWith(userHome + '/') || path.startsWith(userHome + '\\')) ? `~${path.slice(userHome.length)}` : path
}

export type ConnectorState = { name: string; state: 'ok' | 'needs-key' | 'unreachable' | 'off' | 'error' }

export type BannerInfo = {
  version: string
  url: string
  connectors: ConnectorState[]
  llm?: { provider: string; model: string }
  home: string
  logFile?: string
  /** The config file, named in the hint when there is no key. */
  config: string
}

const CONNECTOR_NOTE: Record<ConnectorState['state'], string> = {
  ok: '',
  'needs-key': ' (needs a key: Data page)',
  unreachable: ' (not running)',
  off: ' (off: add it on the Data page)',
  error: ' (failed to load)',
}

/** The startup banner: name, version, URL, connectors, the agent (or how to add a key), where data and the log are. */
export function bannerLines(b: BannerInfo, userHome: string = homedir()): string[] {
  const connectors = b.connectors.map((c) => `${c.name}${CONNECTOR_NOTE[c.state]}`).join(', ') || '(none)'
  const lines = ['', `  Open Terminal ${b.version}  ${b.url}`, '', `  connectors  ${connectors}`]
  if (b.llm) lines.push(`  agent       ${b.llm.model} (${b.llm.provider})`)
  else {
    lines.push('  agent       no LLM key, so a prompt builds a sample workspace')
    lines.push(`              add one: set ANTHROPIC_API_KEY, or fill in llm: in ${tilde(b.config, userHome)}`)
  }
  lines.push(`  data        ${tilde(b.home, userHome)}`)
  if (b.logFile) lines.push(`  log         ${tilde(b.logFile, userHome)}`)
  lines.push('', '  ctrl-c to stop', '')
  return lines
}

/** One line when a newer release is out. Only the release bundle checks, and from npm it updates through npm. */
export function updateNotice(latest: string, current: string): string {
  return `  update      Open Terminal ${latest} is out (this is ${current}): run \`npx openterminal@latest\`, or \`npm install -g openterminal@latest\``
}

async function connectorStates(running: RunningServer): Promise<ConnectorState[]> {
  const registered = running.registry.connectors()
  const out = await Promise.all(
    registered.map(async (r): Promise<ConnectorState> => {
      if (r.status === 'missing_config') return { name: r.name, state: 'needs-key' }
      if (r.status !== 'ok') return { name: r.name, state: 'error' }
      const h = running.registry.health ? await running.registry.health(r.name, { timeoutMs: 1500 }).catch(() => ({ ok: false as const })) : { ok: true }
      return { name: r.name, state: h.ok ? 'ok' : 'unreachable' }
    }),
  )
  for (const name of Object.keys(BUILTIN_CONNECTORS)) if (!registered.some((r) => r.name === name)) out.push({ name, state: 'off' })
  return out
}

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

async function start(cmd: StartCommand, env: NodeJS.ProcessEnv): Promise<void> {
  const stderrLog = (msg: string) => console.error(`[server] ${msg}`)
  const home = resolveHome(env, { log: stderrLog })
  let config: Config
  try {
    config = loadConfig({ home, env })
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const stateFile = statePath(home)

  // First run: no key in the environment or config.yml, and someone at the keyboard. Asked once; a skip is remembered.
  if (!config.llm && interactive && !readState(stateFile).keyPrompt) {
    const key = await askHidden(KEY_PROMPT)
    if (key) {
      saveLlmConfig(home, { provider: 'anthropic', apiKey: key })
      console.log(`Saved to ${tilde(configPath(home))} (readable only by you).`)
    } else {
      updateState(stateFile, { keyPrompt: { skippedAt: new Date().toISOString() } })
    }
  }

  // From the release bundle only: a source checkout updates by pulling, not by a notice.
  const updateCheck = isBundled() && !updateCheckDisabled(env) ? checkForUpdate({ current: VERSION, stateFile }).catch(() => undefined) : Promise.resolve(undefined)

  // In a terminal the server's log goes to a file (the last run's), so the banner is all there is to read.
  let log = stderrLog
  let logFile: string | undefined
  let logFd: number | undefined
  if (interactive && !cmd.verbose) {
    try {
      logFile = join(home, LOG_FILE)
      logFd = openSync(logFile, 'w', 0o600)
      const fd = logFd
      log = (msg: string) => {
        try {
          writeSync(fd, `${new Date().toISOString()} ${msg}\n`)
        } catch {
          // a full disk does not stop the server
        }
      }
    } catch {
      logFile = undefined
    }
  }

  let running: RunningServer
  try {
    running = await startServer({ port: cmd.port, home, env, log })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'EADDRINUSE') fail(`Port ${cmd.port} is in use (another Open Terminal?). Pick another with --port <n>.`)
    fail(`Open Terminal could not start: ${err instanceof Error ? err.message : String(err)}`)
  }

  const llm = resolvedLlm(running.config)
  const lines = bannerLines({
    version: VERSION,
    url: running.url,
    connectors: await connectorStates(running),
    ...(llm && running.llm ? { llm: { provider: llm.provider, model: llm.model } } : {}),
    home,
    config: configPath(home),
    ...(logFile ? { logFile } : {}),
  })
  console.log(lines.join('\n'))

  if (cmd.open) {
    try {
      const { default: open } = await import('open')
      await open(running.url)
    } catch (err) {
      console.error(`could not open a browser: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  void updateCheck.then((r) => {
    if (r?.newer && r.latest) console.log(updateNotice(r.latest, VERSION))
  })

  const shutdown = () => {
    running.close().finally(() => {
      if (logFd !== undefined) closeSync(logFd)
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let cmd: Command
  try {
    cmd = parseArgs(argv, env)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2)
  }
  switch (cmd.command) {
    case 'help':
      console.log(USAGE)
      return
    case 'version':
      console.log(VERSION)
      return
    case 'start':
      return start(cmd, env)
  }
}
