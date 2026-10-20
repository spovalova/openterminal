#!/usr/bin/env node
/* global process, console, fetch, setTimeout, AbortSignal */
// Smoke-test a release build the way a user runs it: `--version`, start with `--no-open` on a spare port and a
// scratch OPENTERMINAL_HOME, wait for /api/health, load the web app, run one pandas transform through
// POST /api/query, stop. Prints the timings; exit 0 on success.
//
//   node scripts/release/smoke.mjs dist/release/lib                              # the bundle, on this Node
//   node scripts/release/smoke.mjs dist/release/npm-pack/openterminal-0.1.0.tgz  # npm install -g into a temp prefix
//
// `checkServer` is exported for wrappers that start the server their own way (the desktop app). The transform's
// input is a live yahoo route (a transform needs at least one input query), tried on a few routes with retries so
// one flaky endpoint does not fail a release.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const win = process.platform === 'win32'
const log = (msg) => console.log(`[smoke] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

async function json(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, body: await res.json() }
}

const TRANSFORM_INPUTS = [
  { connector: 'yahoo', route: 'quote', params: { symbols: ['SPY', 'QQQ'] } },
  { connector: 'yahoo', route: 'chart', params: { symbol: 'SPY', period1: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) } },
  { connector: 'yahoo', route: 'search', params: { q: 'apple' } },
]
const CODE = ['import numpy as np', 'import pandas as pd', 'result = pd.DataFrame({"rows": [len(x)], "cols": [len(x.columns)], "pandas": [pd.__version__], "numpy": [np.__version__]})'].join('\n')

/**
 * Check a starting server at `base`: healthy within `timeoutMs` (`alive()` false ends the wait early), serves the web
 * app, answers one pandas transform. Resolves to the timings; throws on the first failure.
 */
export async function checkServer(base, { t0 = Date.now(), timeoutMs = 120_000, alive = () => true } = {}) {
  let healthy
  while (!healthy) {
    if (!alive()) throw new Error('the server exited before it was healthy')
    if (Date.now() - t0 > timeoutMs) throw new Error(`not healthy after ${timeoutMs / 1000} s`)
    try {
      const h = await json(`${base}/api/health`, {}, 2000)
      if (h.status === 200 && h.body.ok === true) healthy = h.body
    } catch {
      await sleep(250)
    }
  }
  const healthyMs = Date.now() - t0
  log(`healthy in ${healthyMs} ms: ${JSON.stringify(healthy)}`)

  const page = await fetch(`${base}/`)
  const html = await page.text()
  if (page.status !== 200 || !/<div id="root">/.test(html)) throw new Error(`GET / answered ${page.status} without the app`)
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  if (!asset || (await fetch(`${base}${asset}`)).status !== 200) throw new Error(`the web app's script ${asset} did not load`)
  log(`GET / serves the web app (${asset})`)

  // The first transform waits for the Pyodide worker's cold start.
  const errors = []
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const input of TRANSFORM_INPUTS) {
      const t1 = Date.now()
      const r = await json(`${base}/api/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: { inputs: { x: input }, code: CODE } }) }, 180_000)
      if (r.status === 200 && r.body.frame?.rows?.length === 1) {
        const row = r.body.frame.rows[0]
        const [rows, cols, pandas] = row
        if (!(rows > 0 && cols > 0 && /^\d/.test(pandas))) throw new Error(`unexpected transform result ${JSON.stringify(row)}`)
        log(`transform over yahoo ${input.route} in ${Date.now() - t1} ms (${Date.now() - t0} ms after start): ${JSON.stringify(row)}`)
        return { healthyMs, transformMs: Date.now() - t0 }
      }
      errors.push(`${input.route}: ${r.status} ${r.body.error ?? JSON.stringify(r.body).slice(0, 200)}`)
      if (r.body.traceback || /^transform/i.test(String(r.body.error))) throw new Error(`the transform itself failed: ${r.body.error}\n${r.body.traceback ?? ''}`)
    }
    await sleep(5000)
  }
  throw new Error(`no transform input could be fetched:\n${errors.join('\n')}`)
}

/** The command that runs the build under test, and the version it must report. */
function prepare(target, scratch) {
  const abs = resolve(target)
  if (abs.endsWith('.tgz')) {
    const prefix = join(scratch, 'npm')
    execFileSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', abs], { stdio: 'inherit', shell: win })
    const pkg = JSON.parse(readFileSync(join(prefix, win ? '' : 'lib', 'node_modules/openterminal/package.json'), 'utf8'))
    return { cmd: win ? join(prefix, 'openterminal.cmd') : join(prefix, 'bin/openterminal'), pre: [], version: pkg.version }
  }
  if (!existsSync(join(abs, 'openterminal.mjs'))) throw new Error(`${abs} is neither an npm .tgz nor a bundle lib/ directory`)
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const version = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8')).version
  return { cmd: process.execPath, pre: [join(abs, 'openterminal.mjs')], version }
}

/** A .cmd needs a shell on Windows; everything else runs directly. */
function launch(cmd, args, opts) {
  return win && cmd.endsWith('.cmd') ? spawn(`"${cmd}"`, args, { ...opts, shell: true }) : spawn(cmd, args, opts)
}

function stop(child) {
  if (child.exitCode !== null) return
  if (win) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

async function main(target) {
  const scratch = mkdtempSync(join(tmpdir(), 'openterminal-smoke-'))
  try {
    const { cmd, pre, version } = prepare(target, scratch)
    log(`running ${[cmd, ...pre].join(' ')}`)
    const reported = execFileSync(win && cmd.endsWith('.cmd') ? `"${cmd}"` : cmd, [...pre, '--version'], { encoding: 'utf8', shell: win && cmd.endsWith('.cmd') }).trim()
    if (reported !== version) throw new Error(`--version printed "${reported}", expected ${version}`)
    log(`--version ${reported}`)

    const port = await freePort()
    const env = { ...process.env, OPENTERMINAL_HOME: join(scratch, 'home'), OPENTERMINAL_NO_UPDATE_CHECK: '1', PORT: '' }
    delete env.ANTHROPIC_API_KEY
    delete env.OPENAI_API_KEY
    const t0 = Date.now()
    const child = launch(cmd, [...pre, '--no-open', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    try {
      const { healthyMs } = await checkServer(`http://127.0.0.1:${port}`, { t0, alive: () => child.exitCode === null })
      log(`ok: ${version}, healthy in ${healthyMs} ms`)
    } catch (err) {
      console.error(output)
      throw err
    } finally {
      stop(child)
      await sleep(500)
    }
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    } catch (err) {
      console.error(`[smoke] could not remove ${scratch}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/release/smoke.mjs <dist/release/lib | npm .tgz>')
    process.exit(2)
  }
  main(target).catch((err) => {
    console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
