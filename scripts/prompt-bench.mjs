// Prompt bench: run prompts from scripts/prompts.json against a running server and print what the agent did.
//
//   pnpm bench                       every prompt
//   pnpm bench semis gold            by name
//   pnpm bench -- --group v2         one group (prompts.json entries carry a `group`; v1 is the 2026-10-18 set, v2 the strict use-case set,
//                                    v2-accept the twelve visual cases of PLAN.md section 17; scripts/accept.mjs screenshots and checks them)
//   pnpm bench -- --prompt "..."     an ad-hoc prompt (repeat --prompt for follow-ups on the same workspace)
//
// BASE (default http://127.0.0.1:4242) picks the server. Each run creates a workspace named "bench: <name>"
// so the result can be opened in the UI; --delete removes it afterwards. --out <dir> also writes one JSON
// transcript per prompt (socket log plus the stored workspace) for number checking.
//
// After each reply the bench prints a verification block: for every widget, the frame it received
// (kind, connector, rows) and the figures a reply is allowed to quote from it: per-symbol first and last
// close with the change over the range for ohlcv, the rows for quote, the first rows for everything else.
// A figure in the reply that is not in this block did not come from a frame.
//
// Reports: docs/notes/prompt-bench-2026-10-18.md (v1), docs/notes/prompt-bench-v2-2026-10-18.md (v2, strict).
/* global process, console, fetch, WebSocket, setTimeout, clearTimeout */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.BASE ?? 'http://127.0.0.1:4242'
const args = process.argv.slice(2).filter((a) => a !== '--') // pnpm passes the `--` separator through
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
const group = flag('--group')
const del = args.includes('--delete') ? (args.splice(args.indexOf('--delete'), 1), true) : false
const adHoc = flags('--prompt')
const file = resolve(dirname(fileURLToPath(import.meta.url)), 'prompts.json')
const all = JSON.parse(readFileSync(file, 'utf8')).map((c) => ({ name: c.name, group: c.group ?? 'v1', prompts: c.prompts ?? [c.prompt] }))
const pool = group ? all.filter((c) => c.group === group) : all
const cases = adHoc.length ? [{ name: 'ad-hoc', prompts: adHoc }] : args.length ? pool.filter((c) => args.includes(c.name)) : pool
if (!cases.length) {
  console.error(`no such prompt; names: ${all.map((c) => c.name).join(', ')}; groups: ${[...new Set(all.map((c) => c.group))].join(', ')}`)
  process.exit(2)
}
if (outDir) mkdirSync(outDir, { recursive: true })

const pad = (ms) => String(ms).padStart(6)
/** One token per widget: v1 `w1:ohlcv/series+candle/md`, v2 `w1:recipe ohlcv(+events)/price+candle/md`. */
const describe = (w) => {
  if (w.query && w.view?.type) return `${w.id}:${w.query.kind}/${w.view.type}${w.view.candle ? '+candle' : ''}${w.view.normalize ? '+norm' : ''}/${w.size}`
  const names = Object.keys(w.data ?? {})
  const main = w.data?.[w.view?.data ?? 'main'] ?? w.data?.[names[0]]
  const q = !main ? '?' : main.recipe ? `recipe ${main.recipe}` : main.route ? `${main.connector} ${main.route}` : main.code ? `transform(${Object.keys(main.inputs ?? {}).join(',')})` : main.kind ?? '?'
  const extra = names.filter((n) => n !== (w.view?.data ?? 'main'))
  const opts = Object.entries(w.view ?? {}).filter(([k, v]) => k !== 'preset' && k !== 'data' && v === true).map(([k]) => `+${k}`).join('')
  return `${w.id ?? '?'}:${q}${extra.length ? `(+${extra.join(',')})` : ''}/${w.view?.preset ?? '?'}${opts}/${w.size}`
}
const fmt = (v) => (v === null || v === undefined ? '·' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v).slice(0, 48))
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** What a reply may quote from one frame, as text lines. */
function verify(widget, frame) {
  const cols = frame.columns.map((c) => c.name)
  const col = (name) => cols.indexOf(name)
  const rows = frame.rows
  // v2 widgets hold datasets; the main one names the kind through its recipe (or route) for the lines below.
  const main = widget.query ?? widget.data?.[widget.view?.data ?? 'main'] ?? Object.values(widget.data ?? {})[0] ?? {}
  const kind = main.kind ?? main.recipe ?? main.route ?? 'transform'
  const lines = [`${widget.id} ${kind} ${JSON.stringify(main.params ?? Object.keys(main.inputs ?? {}))} → ${rows.length} rows (${frame.meta.connector})`]
  if (kind === 'ohlcv' || kind === 'macro' || (col('time') >= 0 && col('close') >= 0)) {
    const key = col('symbol') >= 0 ? 'symbol' : 'series'
    const value = col('close') >= 0 ? 'close' : 'value'
    const k = col(key), t = col('time'), v = col(value)
    const by = new Map()
    for (const r of rows) {
      if (!by.has(r[k])) by.set(r[k], [])
      by.get(r[k]).push(r)
    }
    for (const [sym, rs] of by) {
      rs.sort((a, b) => a[t] - b[t])
      const first = rs[0], last = rs[rs.length - 1]
      const vals = rs.map((r) => r[v]).filter((x) => typeof x === 'number')
      const chg = first[v] ? ((last[v] - first[v]) / first[v]) * 100 : null
      lines.push(`  ${sym}: ${rs.length} bars ${iso(first[t])} → ${iso(last[t])}; first ${fmt(first[v])} last ${fmt(last[v])} chg ${fmt(chg)}% (first bar to last bar); min ${fmt(Math.min(...vals))} max ${fmt(Math.max(...vals))}` + (chg !== null && kind === 'macro' ? ` abs ${fmt(last[v] - first[v])}` : ''))
    }
    return lines
  }
  const head = kind === 'quote' ? rows.length : kind === 'options' ? 12 : 8
  lines.push(`  ${cols.join(' | ')}`)
  for (const r of rows.slice(0, head)) lines.push(`  ${r.map((v, i) => (frame.columns[i].type === 'time' && typeof v === 'number' ? iso(v) : fmt(v))).join(' | ')}`)
  if (rows.length > head) lines.push(`  … ${rows.length - head} more`)
  return lines
}

async function runCase({ name, prompts }) {
  console.log(`\n================ ${name}`)
  const res = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `bench: ${name}` }) })
  if (!res.ok) throw new Error(`POST /api/workspaces ${res.status}`)
  const workspace = await res.json()
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`)
  const log = []
  const frames = new Map()
  let widgets = []
  let lastSet = []
  const t0 = Date.now()
  let i = 0
  let ok = true
  const send = () => {
    console.log(`PROMPT ${i + 1}/${prompts.length}: ${prompts[i]}`)
    ws.send(JSON.stringify({ t: 'prompt', workspaceId: workspace.id, text: prompts[i] }))
  }
  const printVerification = () => {
    console.log('VERIFY (what the reply may quote, per widget):')
    for (const w of widgets) {
      const f = frames.get(w.id)
      if (!f) { console.log(`${w.id} ${describe(w)}: no frame`); continue }
      for (const line of verify(w, f)) console.log(line)
    }
    if (widgets.length === 0 && lastSet.length > 0) {
      // No `widgets` message arrived (the v2 widget set is dropped by the server until the protocol carries
      // AnyWidgetSchema); the set the agent applied is in the set_workspace step's args.
      console.log(`(no widgets message; the set_workspace step carried ${lastSet.length} widgets: ${lastSet.map(describe).join(' ')})`)
    }
    console.log('')
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
      if (m.t === 'step') {
        console.log(`${pad(at)}ms step ${m.step.summary}${m.step.error ? ' ERROR ' + m.step.error : ''} (${m.step.ms}ms)`)
        if (m.step.tool === 'set_workspace' && !m.step.error && Array.isArray(m.step.args?.widgets)) lastSet = m.step.args.widgets.map((w, i) => ({ id: `w${i + 1}`, ...w }))
      }
      else if (m.t === 'widgets') { widgets = m.widgets; frames.clear(); console.log(`${pad(at)}ms widgets name=${m.name ?? ''} ${m.widgets.map(describe).join(' ')}`) }
      // v2 frames carry a dataset; the verification block reads the main one, so secondary datasets (events, levels) are keyed apart.
      else if (m.t === 'frame') { frames.set(m.dataset ? `${m.widgetId}/${m.dataset}` : m.widgetId, m.frame); console.log(`${pad(at)}ms frame ${m.widgetId}${m.dataset ? `/${m.dataset}` : ''} ${m.frame.rows.length} rows (${m.frame.meta.connector})`) }
      else if (m.t === 'frameError') console.log(`${pad(at)}ms frameError ${m.widgetId}${m.dataset ? `/${m.dataset}` : ''}: ${m.error}`)
      else if (m.t !== 'delta') console.log(`${pad(at)}ms ${m.t}${m.error ? ' ' + m.error : ''}`)
      if (m.t === 'done' || m.t === 'failed') {
        console.log(`\nREPLY ${i + 1} (${at}ms):\n${m.message?.text ?? '(failed)'}\n`)
        if (m.message?.verification) {
          const v = m.message.verification
          console.log(`VERIFICATION: ${v.ok ? 'ok' : 'FAILED'} · ${v.matched}/${v.checked} figures matched${v.unmatched.length ? ` · not in any preview: ${v.unmatched.map((u) => u.text).join(', ')}` : ''}\n`)
        }
        if (m.t === 'failed') ok = false
        // Frames can arrive after `done`; give them a moment before printing the verification block.
        setTimeout(() => {
          printVerification()
          if (m.t === 'done' && ++i < prompts.length) return send()
          clearTimeout(timer)
          done()
        }, 1500)
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
