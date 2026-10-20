#!/usr/bin/env node
/* global process, console, setTimeout */
// Smoke-test a packaged desktop app: start it with `--no-window` (server only, no window, tray or update check) on a
// scratch OPENTERMINAL_HOME, read the URL it prints, then the same checks as the npm package (scripts/release/
// smoke.mjs `checkServer`): /api/health, the web app, one pandas transform. Linux needs a display even with no
// window: run it under `xvfb-run -a`.
//
//   node scripts/smoke.mjs "release/linux-arm64-unpacked/openterminal-app" [--port <n>] [extra app args…]
//   node scripts/smoke.mjs "release/mac-arm64/Open Terminal.app/Contents/MacOS/Open Terminal"
//   node scripts/smoke.mjs "release/win-unpacked/Open Terminal.exe"
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkServer } from '../../../scripts/release/smoke.mjs'

const [exe, ...extra] = process.argv.slice(2)
if (!exe) {
  console.error('usage: node scripts/smoke.mjs <packaged app executable> [--port <n>] [app args…]')
  process.exit(2)
}
const home = mkdtempSync(join(tmpdir(), 'openterminal-desktop-smoke-'))
const env = { ...process.env, OPENTERMINAL_HOME: join(home, 'data'), OPENTERMINAL_NO_UPDATE_CHECK: '1' }
delete env.ANTHROPIC_API_KEY
delete env.OPENAI_API_KEY
const t0 = Date.now()
const child = spawn(resolve(exe), ['--no-window', ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
let base
const found = new Promise((ok, fail) => {
  const onData = (d) => {
    output += d
    const m = /OPENTERMINAL_URL=(\S+)/.exec(output)
    if (m && !base) {
      base = m[1]
      ok(base)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', (d) => (output += d))
  child.on('exit', (code) => fail(new Error(`the app exited (${code}) before printing its URL`)))
  setTimeout(() => fail(new Error('no OPENTERMINAL_URL after 120 s')), 120_000).unref()
})

function stop() {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

try {
  const url = await found
  console.log(`[smoke] the app's server is up at ${url}, ${Date.now() - t0} ms after launch`)
  const r = await checkServer(url, { t0, alive: () => child.exitCode === null })
  console.log(`[smoke] ok: healthy ${r.healthyMs} ms after launch, first transform ${r.transformMs} ms`)
  stop()
  await new Promise((r) => setTimeout(r, 1500))
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  process.exit(0)
} catch (err) {
  console.error(output)
  console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  stop()
  process.exit(1)
}
