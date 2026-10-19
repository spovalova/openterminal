// CLI entry for `openterminal`: parse flags, start @openterminal/server, open the browser.
import { startServer, DEFAULT_PORT } from '@openterminal/server'

export type CliOptions = { port: number; open: boolean; help: boolean }

export const USAGE = `Open Terminal: the open-source, AI-native terminal for traders.

usage: openterminal [--port <n>] [--no-open]

  --port <n>   listen on port n (default: PORT or ${DEFAULT_PORT})
  --no-open    do not open the browser
  --help       show this help

Config, workspaces and recipes live in ~/.openterminal (OPENTERMINAL_HOME overrides the directory).`

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const opts: CliOptions = { port: Number(env.PORT) || DEFAULT_PORT, open: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-open') opts.open = false
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--port') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --port ${argv[i]}`)
      opts.port = n
    } else if (a?.startsWith('--port=')) {
      const n = Number(a.slice('--port='.length))
      if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${a}`)
      opts.port = n
    } else throw new Error(`unknown argument ${a}\n${USAGE}`)
  }
  return opts
}

export async function run(argv: string[]): Promise<void> {
  let opts: CliOptions
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const running = await startServer({ port: opts.port })
  console.error(`Open Terminal running at ${running.url} (ctrl-c to stop)`)
  if (opts.open) {
    try {
      const { default: open } = await import('open')
      await open(running.url)
    } catch (err) {
      console.error(`could not open a browser: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const shutdown = () => {
    running.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
