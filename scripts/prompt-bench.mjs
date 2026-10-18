// Prompt bench: run prompts from scripts/prompts.json against a running server and print what the agent did.
//
//   pnpm bench                       every prompt
//   pnpm bench semis gold            by name
//   pnpm bench -- --prompt "..."     an ad-hoc prompt (repeat --prompt for follow-ups on the same workspace)
//
// BASE (default http://127.0.0.1:4242) picks the server. Each run creates a workspace named "bench: <name>"
// so the result can be opened in the UI; --delete removes it afterwards. --out <dir> also writes one JSON
// transcript per prompt (socket log plus the stored workspace) for number checking.
//
// Last report: docs/notes/prompt-bench-2026-10-18.md
/* global process, console, fetch, WebSocket, setTimeout, clearTimeout */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.BASE ?? 'http://127.0.0.1:4242'
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
const flags = (name) => {
  const out = []
  for (let v = flag(name); v !== undefined; v = flag(name)) out.push(v)
  return out
}
const outDir = flag('--out')
const del = args.includes('--delete') ? (args.splice(args.indexOf('--delete'), 1), true) : false
const adHoc = flags('--prompt')
const file = resolve(dirname(fileURLToPath(import.meta.url)), 'prompts.json')
const all = JSON.parse(readFileSync(file, 'utf8')).map((c) => ({ name: c.name, prompts: c.prompts ?? [c.prompt] }))
const cases = adHoc.length ? [{ name: 'ad-hoc', prompts: adHoc }] : args.length ? all.filter((c) => args.includes(c.name)) : all
if (!cases.length) {
  console.error(`no such prompt; names: ${all.map((c) => c.name).join(', ')}`)
  process.exit(2)
}
if (outDir) mkdirSync(outDir, { recursive: true })

const pad = (ms) => String(ms).padStart(6)
const describe = (w) => `${w.id}:${w.query.kind}/${w.view.type}${w.view.candle ? '+candle' : ''}${w.view.normalize ? '+norm' : ''}/${w.size}`

async function runCase({ name, prompts }) {
  console.log(`\n================ ${name}`)
  const res = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `bench: ${name}` }) })
  if (!res.ok) throw new Error(`POST /api/workspaces ${res.status}`)
  const workspace = await res.json()
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`)
  const log = []
  const t0 = Date.now()
  let i = 0
  let ok = true
  const send = () => {
    console.log(`PROMPT ${i + 1}/${prompts.length}: ${prompts[i]}`)
    ws.send(JSON.stringify({ t: 'prompt', workspaceId: workspace.id, text: prompts[i] }))
  }
  await new Promise((done) => {
    const timer = setTimeout(() => { console.error('TIMEOUT'); ok = false; done() }, 240_000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'focus', workspaceId: workspace.id }))
      send()
    })
    ws.addEventListener('error', (e) => { console.error('socket error', e.message ?? e); ok = false; clearTimeout(timer); done() })
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data))
      const at = Date.now() - t0
      log.push({ at, ...m })
      if (m.t === 'step') console.log(`${pad(at)}ms step ${m.step.summary}${m.step.error ? ' ERROR ' + m.step.error : ''} (${m.step.ms}ms)`)
      else if (m.t === 'widgets') console.log(`${pad(at)}ms widgets name=${m.name ?? ''} ${m.widgets.map(describe).join(' ')}`)
      else if (m.t === 'frame') console.log(`${pad(at)}ms frame ${m.widgetId} ${m.frame.rows.length} rows (${m.frame.meta.connector})`)
      else if (m.t === 'frameError') console.log(`${pad(at)}ms frameError ${m.widgetId}: ${m.error}`)
      else if (m.t !== 'delta') console.log(`${pad(at)}ms ${m.t}${m.error ? ' ' + m.error : ''}`)
      if (m.t === 'done' || m.t === 'failed') {
        console.log(`\nREPLY ${i + 1} (${at}ms):\n${m.message?.text ?? '(failed)'}\n`)
        if (m.t === 'failed') ok = false
        if (m.t === 'done' && ++i < prompts.length) return send()
        clearTimeout(timer)
        done()
      }
    })
  })
  ws.close()
  const stored = await (await fetch(`${base}/api/workspaces/${workspace.id}`)).json()
  if (outDir) writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify({ name, prompts, workspaceId: workspace.id, log, stored }, null, 1))
  if (del) await fetch(`${base}/api/workspaces/${workspace.id}`, { method: 'DELETE' })
  else console.log(`workspace "bench: ${name}" kept; open it from the sidebar at ${base}`)
  return ok
}

let failed = 0
for (const c of cases) if (!(await runCase(c))) failed++
console.log(`\n${cases.length - failed}/${cases.length} completed`)
process.exit(failed ? 1 : 0)
