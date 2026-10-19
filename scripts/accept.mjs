// Visual acceptance (PLAN.md section 17, "Visual acceptance: test cases and the iteration loop"): screenshot every
// bench workspace at 1440x900 and 1920x1080 with the conversation panel open, and score the checklist in the browser.
//
//   BASE=http://127.0.0.1:4270 node scripts/accept.mjs --runs <bench --out dir> --out docs/screenshots [--cases a,b] [--viewports 1440x900,1920x1080]
//
// `--runs` is the directory `pnpm bench -- --group v2-accept --out <dir>` wrote: one <name>.json per case with the
// stored workspace (its id and name) and the socket log (the `done` message carries the reply and its verification).
// Screenshots land in --out as accept-<case>-<viewport>.png (the "accept-" prefix of the bench name is not repeated).
// Playwright is not a dependency of the repo; it is loaded from PLAYWRIGHT_DIR (default ~/.local/share/openterminal-dev/browser).
//
// The checklist, per workspace and viewport, each a pass or a list of failures:
//   overflow     no element with scrollWidth > clientWidth (sideways scroll or clipping) inside the grid or the panel
//   holes        no empty grid cell, and no cell showing "No data", "Could not load" or a loading skeleton
//   fill         content fills at least 60% of a table's or card's body height and 80% of a chart's
//   oneRow       no table with one row
//   columns      three grid columns at 1440 with the panel open (and at 1920)
//   headers      every widget has a title and a sub-header
//   charts       every chart has a legend and a last-value label
//   clipped      no text clipped mid-word (ellipsis truncation or a text box cut by overflow: hidden)
//   verified     the reply's verification has no unverified number
//   chips        the reply ends with at least one chip and every chip names a widget of the workspace
//   plain        the reply has no markdown headings, bullets or bold
// The result prints as JSON lines (one per case and viewport) and a Markdown table at the end; --json <file> saves it.
/* global process, console, fetch, document, getComputedStyle, localStorage */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i === -1 ? def : args.splice(i, 2)[1]
}
const BASE = process.env.BASE ?? 'http://127.0.0.1:4270'
const runs = flag('--runs')
const out = resolve(flag('--out', 'docs/screenshots'))
const only = (flag('--cases', '') || '').split(',').filter(Boolean)
const viewports = flag('--viewports', '1440x900,1920x1080').split(',').map((v) => v.split('x').map(Number))
const jsonOut = flag('--json')
const settleMs = Number(flag('--settle', '3000'))
/** Screenshot file prefix: `accept-` for the hand-built workspaces, `accept-agent-` for the agent's (bench transcripts). */
const prefix = flag('--prefix', 'accept-')
const pwDir = process.env.PLAYWRIGHT_DIR ?? join(homedir(), '.local/share/openterminal-dev/browser')
if (!runs) {
  console.error('usage: BASE=... node scripts/accept.mjs --runs <bench out dir> [--out dir] [--cases a,b] [--viewports 1440x900,1920x1080] [--json file]')
  process.exit(2)
}
const { chromium } = await import(pathToFileURL(join(pwDir, 'node_modules/playwright/index.mjs')).href)
mkdirSync(out, { recursive: true })

// --build: create the hand-built workspaces of scripts/accept-cases.mjs on the server and write transcripts for them
// into --runs (marked handBuilt, so the reply checks report n/a), then score them like bench transcripts.
if (args.includes('--build')) {
  args.splice(args.indexOf('--build'), 1)
  const { CASES } = await import('./accept-cases.mjs')
  mkdirSync(runs, { recursive: true })
  // A previous round's workspaces of the same names are replaced, so the tab bar does not fill with copies.
  const existing = await (await fetch(`${BASE}/api/workspaces`)).json()
  for (const ws of Array.isArray(existing) ? existing : []) {
    if (CASES.some((c) => c.workspace === ws.name)) await fetch(`${BASE}/api/workspaces/${ws.id}`, { method: 'DELETE' })
  }
  for (const c of CASES) {
    if (only.length && !only.includes(c.name) && !only.includes(`accept-${c.name}`)) continue
    const res = await fetch(`${BASE}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: c.workspace, widgets: c.widgets.map((w, i) => ({ id: `w${i + 1}`, ...w })) }) })
    const body = await res.json()
    if (!res.ok) {
      console.error(`${c.name}: POST /api/workspaces ${res.status} ${JSON.stringify(body).slice(0, 400)}`)
      continue
    }
    writeFileSync(join(runs, `accept-${c.name}.json`), JSON.stringify({ name: `accept-${c.name}`, prompts: [c.prompt], workspaceId: body.id, handBuilt: true, log: [], stored: body }, null, 1))
    console.error(`${c.name}: workspace ${body.id} (${body.widgets.length} widgets)`)
  }
}

/** The cases: bench transcripts in --runs. */
const cases = readdirSync(runs)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(runs, f), 'utf8')))
  .filter((c) => only.length === 0 || only.includes(c.name) || only.includes(c.name.replace(/^accept-/, '')))
if (cases.length === 0) {
  console.error(`no transcripts in ${runs}`)
  process.exit(2)
}

/** What the reply side of the checklist needs from a transcript: the final reply, its verification, the widget ids. */
function replyFacts(c) {
  const done = [...c.log].reverse().find((m) => m.t === 'done')
  const text = done?.message?.text ?? ''
  const verification = done?.message?.verification
  const widgetIds = (c.stored?.widgets ?? []).map((w) => w.id)
  const chips = [...text.matchAll(/\[\[widget:([^\]]+)\]\]/g)].map((m) => m[1])
  return { text, verification, widgetIds, chips, failed: !done, handBuilt: !!c.handBuilt }
}

/** Runs in the page: measure every widget and the grid. */
const measure = () => {
  const near = (el) => el.getBoundingClientRect()
  const grid = document.querySelector('.widget-grid')
  const g = grid ? near(grid) : null
  const columns = grid ? Number(grid.getAttribute('data-columns')) : 0
  const rowsAttr = grid ? Number(grid.getAttribute('data-rows')) : 0
  const cells = [...document.querySelectorAll('.widget-grid > div')]
  // Coverage of the grid from each cell's explicit placement.
  const covered = new Set()
  for (const cell of cells) {
    const [c0, , cs] = cell.style.gridColumn.split(/\s*\/\s*span\s*|\s*\/\s*/).map(Number)
    const [r0, , rs] = cell.style.gridRow.split(/\s*\/\s*span\s*|\s*\/\s*/).map(Number)
    const cspan = Number(cell.style.gridColumn.match(/span\s+(\d+)/)?.[1] ?? cs ?? 1)
    const rspan = Number(cell.style.gridRow.match(/span\s+(\d+)/)?.[1] ?? rs ?? 1)
    for (let y = r0; y < r0 + rspan; y++) for (let x = c0; x < c0 + cspan; x++) covered.add(`${y}:${x}`)
  }
  const holes = []
  for (let y = 1; y <= rowsAttr; y++) for (let x = 1; x <= columns; x++) if (!covered.has(`${y}:${x}`)) holes.push(`row ${y} col ${x}`)

  const panel = document.querySelector('aside.sidebar')
  const panelRect = panel ? near(panel) : null
  const scope = [grid, panel].filter(Boolean)
  const visible = (el) => {
    const r = near(el)
    return r.width > 0 && r.height > 0
  }
  const describe = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''} "${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`
  const overflow = []
  const clipped = []
  for (const root of scope) {
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el)) continue
      if (el.tagName === 'CANVAS' || el.tagName === 'svg' || el.closest('svg')) continue
      const cs = getComputedStyle(el)
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') {
        // An intentional horizontal scroller is still a sideways scroll; the checklist allows none.
        overflow.push(describe(el))
      }
      // Ellipsis truncation is a word cut mid-way whenever the text is wider than the box.
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) clipped.push(`ellipsis: ${describe(el)}`)
    }
  }

  const widgets = cells.map((cell) => {
    const sec = cell.querySelector('section')
    const header = sec?.querySelector('header')
    const body = header?.nextElementSibling
    const title = sec?.querySelector('h3')?.textContent?.trim() ?? ''
    const subtitle = sec?.querySelector('[data-subtitle]')?.textContent?.trim() ?? ''
    const view = body?.querySelector('[data-view]')
    const kind = view?.getAttribute('data-view') ?? (body?.querySelector('[aria-busy="true"]') ? 'loading' : /Could not load/.test(body?.textContent ?? '') ? 'error' : /No data/.test(body?.textContent ?? '') ? 'empty' : 'none')
    // The body is measured from the header to the frame's foot, not the body element: a content-sized card (round 2)
    // has a body as tall as its content, and blank space under it inside the frame still counts against the fill.
    const secRect = sec ? near(sec) : null
    const headRect = header ? near(header) : null
    const bodyRect = body && secRect && headRect ? { top: headRect.bottom, bottom: secRect.bottom - 1, height: secRect.bottom - 1 - headRect.bottom, width: secRect.width } : { height: 0, top: 0, bottom: 0, width: 0 }
    // Content height: the union of the content's boxes inside the body, clipped to the body.
    let contentTop = Infinity
    let contentBottom = -Infinity
    const consider = (el) => {
      const r = near(el)
      if (r.height <= 0 || r.width <= 0) return
      contentTop = Math.min(contentTop, Math.max(r.top, bodyRect.top))
      contentBottom = Math.max(contentBottom, Math.min(r.bottom, bodyRect.bottom))
    }
    let tableRows = null
    if (kind === 'chart') {
      for (const c of body.querySelectorAll('canvas')) consider(c)
      // The price pane's legend sits above the plot (taste round, change 4): it is the chart's content too.
      for (const l of body.querySelectorAll('[data-legend]')) consider(l)
    }
    else if (kind === 'table' || kind === 'chain' || kind === 'heatmap') {
      const table = body.querySelector('table')
      if (table) {
        consider(table)
        tableRows = table.querySelectorAll('tbody tr').length
      }
      // The chain's header strip counts as content; a heatmap's legend at the bottom does not (the matrix must fill).
      if (kind !== 'heatmap') for (const extra of body.querySelectorAll('[data-view] > :not(:has(table))')) consider(extra)
      if (kind === 'table' && body.querySelector('[data-cards]')) for (const card of body.querySelectorAll('[data-cards] > [data-row]')) consider(card)
    } else if (kind === 'stat' || kind === 'facts') {
      for (const child of view.children) consider(child)
      if (view.children.length === 0) consider(view)
      // a scrolling card is full
      if (view.scrollHeight > view.clientHeight + 1) {
        contentTop = bodyRect.top
        contentBottom = bodyRect.bottom
      }
    }
    const contentH = contentBottom > contentTop ? contentBottom - contentTop : 0
    const fill = bodyRect.height > 0 ? contentH / bodyRect.height : 0
    const legend = !!body?.querySelector('[data-legend]')
    const legendItems = body?.querySelectorAll('[data-legend] [data-symbol], [data-legend] [role="listitem"]').length ?? 0
    const lastValue = Number(view?.getAttribute('data-last-value') ?? 0)
    // Text boxes cut by an overflow: hidden ancestor inside the body (vertical clipping of a cell or label).
    const cut = []
    for (const el of body?.querySelectorAll('td, th, span, div, p') ?? []) {
      if (el.children.length > 0 || !el.textContent?.trim()) continue
      const r = near(el)
      if (r.height <= 0) continue
      if (r.bottom > bodyRect.bottom + 1 && r.top < bodyRect.bottom - 1 && !el.closest('[data-virtual], .overflow-y-auto, table')) cut.push(describe(el))
    }
    const rect = near(cell)
    return {
      id: cell.querySelector('.widget-cell')?.id ?? '',
      title,
      subtitle,
      kind,
      size: sec?.getAttribute('data-size'),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      bodyH: Math.round(bodyRect.height),
      contentH: Math.round(contentH),
      fill: Math.round(fill * 100),
      tableRows,
      legend,
      legendItems,
      lastValue,
      cut,
      gridColumn: cell.style.gridColumn,
      gridRow: cell.style.gridRow,
    }
  })
  return {
    grid: g ? { w: Math.round(g.width), h: Math.round(g.height), columns, rows: rowsAttr, scrollW: grid.scrollWidth, clientW: grid.clientWidth } : null,
    panel: panelRect ? { w: Math.round(panelRect.width) } : null,
    pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    holes,
    overflow,
    clipped,
    widgets,
  }
}

function score(m, facts) {
  const fails = {}
  const add = (k, v) => {
    if (!fails[k]) fails[k] = []
    fails[k].push(v)
  }
  if (!m.grid) add('holes', 'no grid rendered')
  for (const h of m.holes) add('holes', `empty cell ${h}`)
  for (const w of m.widgets) {
    const tag = `${w.id || w.title}`
    if (w.kind === 'loading' || w.kind === 'error' || w.kind === 'empty' || w.kind === 'none') add('holes', `${tag}: ${w.kind}`)
    const want = w.kind === 'chart' ? 80 : 60
    if (['chart', 'table', 'stat', 'facts', 'heatmap', 'chain'].includes(w.kind) && w.fill < want) add('fill', `${tag} (${w.kind}, ${w.size}): ${w.fill}% of ${w.bodyH}px, needs ${want}%`)
    if (w.kind === 'table' && w.tableRows === 1) add('oneRow', `${tag}`)
    if (!w.title) add('headers', `${tag}: no title`)
    if (!w.subtitle) add('headers', `${tag}: no sub-header`)
    if (w.kind === 'chart') {
      if (!w.legend || w.legendItems === 0) add('charts', `${tag}: no legend`)
      if (!(w.lastValue > 0)) add('charts', `${tag}: no last-value label`)
    }
    for (const c of w.cut) add('clipped', `${tag}: ${c}`)
  }
  if (m.pageScroll) add('overflow', 'page scrolls sideways')
  if (m.grid && m.grid.scrollW > m.grid.clientW + 1) add('overflow', 'grid scrolls sideways')
  for (const o of m.overflow) add('overflow', o)
  for (const c of m.clipped) add('clipped', c)
  if (m.grid && m.grid.columns !== 3) add('columns', `${m.grid.columns} columns`)
  if (!facts.handBuilt) {
    if (facts.failed) add('verified', 'the run failed; no reply')
    else if (facts.verification && !facts.verification.ok) add('verified', `${facts.verification.unmatched.length} of ${facts.verification.checked} figures not in any preview: ${facts.verification.unmatched.map((u) => u.text).join(', ')}`)
    if (facts.chips.length === 0) add('chips', 'no chips')
    for (const id of facts.chips) if (!facts.widgetIds.includes(id)) add('chips', `chip ${id} names no widget`)
    if (/^#{1,6}\s|\*\*|^\s*[-*•]\s|^\s*\d+\.\s/m.test(facts.text)) add('plain', 'markdown heading, bold or list in the reply')
  }
  const keys = ['overflow', 'holes', 'fill', 'oneRow', 'columns', 'headers', 'charts', 'clipped', 'verified', 'chips', 'plain']
  const result = Object.fromEntries(keys.map((k) => [k, fails[k] ?? (facts.handBuilt && ['verified', 'chips', 'plain'].includes(k) ? 'n/a' : 'pass')]))
  return { pass: keys.every((k) => !fails[k]), result }
}

// CHROMIUM_PATH points at a Chromium build when the Playwright cache holds a different revision than the library expects.
const browser = await chromium.launch({ channel: 'chromium', ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
const rows = []
for (const [width, height] of viewports) {
  const viewport = `${width}x${height}`
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  for (const c of cases) {
    const slug = c.name.replace(/^accept-/, '')
    const facts = replyFacts(c)
    // Pick the workspace before the app loads: the app restores the remembered active workspace from localStorage.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate((id) => localStorage.setItem('terminal.activeWorkspace', id), c.workspaceId)
    await page.goto(BASE, { waitUntil: 'networkidle' })
    // The first page load can write its own remembered workspace back after ours (the first case screenshotted the
    // previous session's tab): check what the app settled on and reload until it is the case's workspace.
    for (let i = 0; i < 4; i++) {
      const name = c.stored?.name ?? c.workspaceName
      // The app can still be restoring when storage already holds our id: wait for the selected tab to name the workspace.
      const shown = name
        ? await page
            .waitForFunction((n) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes(n), name, { timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
        : (await page.evaluate(() => localStorage.getItem('terminal.activeWorkspace'))) === c.workspaceId
      if (shown) break
      await page.evaluate((id) => localStorage.setItem('terminal.activeWorkspace', id), c.workspaceId)
      await page.goto(BASE, { waitUntil: 'networkidle' })
    }
    await page
      .waitForFunction(
        () => {
          const cells = [...document.querySelectorAll('.widget-cell')]
          return cells.length > 0 && cells.every((x) => !x.querySelector('[aria-busy="true"]'))
        },
        null,
        { timeout: 90_000 },
      )
      .catch(() => console.error(`${slug} ${viewport}: still loading after 90 s`))
    await page.waitForTimeout(settleMs)
    const file = join(out, `${prefix}${slug}-${viewport}.png`)
    await page.screenshot({ path: file })
    const m = await page.evaluate(measure)
    const { pass, result } = score(m, facts)
    const row = { case: slug, viewport, pass, result, screenshot: file, grid: m.grid, widgets: m.widgets.map((w) => ({ id: w.id, title: w.title, kind: w.kind, size: w.size, w: w.w, h: w.h, fill: w.fill, rows: w.tableRows, legendItems: w.legendItems, lastValue: w.lastValue })), reply: facts.text.slice(0, 400), verification: facts.verification }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  await context.close()
}
await browser.close()

const keys = ['overflow', 'holes', 'fill', 'oneRow', 'columns', 'headers', 'charts', 'clipped', 'verified', 'chips', 'plain']
const mark = (v) => (v === 'pass' || v === 'n/a' ? v : `fail (${v.length})`)
console.log('\n| case | viewport | ' + keys.join(' | ') + ' | verdict |')
console.log('|---|---|' + keys.map(() => '---').join('|') + '|---|')
for (const r of rows) console.log(`| ${r.case} | ${r.viewport} | ${keys.map((k) => mark(r.result[k])).join(' | ')} | ${r.pass ? 'pass' : 'fail'} |`)
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} pass`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1))
if (!existsSync(out)) process.exit(1)
process.exit(rows.every((r) => r.pass) ? 0 : 1)
