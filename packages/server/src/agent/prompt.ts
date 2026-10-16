import { z } from 'zod'
import { KINDS, KIND_NAMES, type Kind, type KindDef, type Message, type Widget, type Workspace } from '@terminal/core'
import { easternDate, easternParts, type MarketState } from './market.js'

export type PromptInput = {
  /** Kinds at least one healthy connector answers right now (from the registry). */
  kinds: Kind[]
  workspace: Workspace
  now: Date
  marketState: MarketState
}

/** How many prior messages the model sees. Older turns are dropped. */
export const PROMPT_HISTORY = 6
const PROMPT_MESSAGE_CHARS = 500

export function buildSystemPrompt(input: PromptInput): string {
  const { kinds, workspace, now, marketState } = input
  const et = easternParts(now)
  const answerable = new Set(kinds)
  const unanswerable = KIND_NAMES.filter((k) => !answerable.has(k))

  const sections: string[] = []

  sections.push(
    [
      'You are the agent inside a local-first terminal for retail traders (US equities only).',
      'A prompt becomes a workspace: four to six widgets, each one query rendered as a chart or table, plus a short reply that links to the widgets it draws on.',
      'You have two tools: `query` runs one query and returns a preview; `set_workspace` replaces the workspace widgets.',
    ].join('\n'),
  )

  sections.push(
    [
      '# Now',
      `Date: ${et.date} (${WEEKDAY_NAMES[et.weekday]}), ${et.time} America/New_York.`,
      `US market: ${MARKET_LABEL[marketState]}.`,
      `Useful dates: today ${easternDate(now)}, +7d ${easternDate(now, 7)}, +30d ${easternDate(now, 30)}, +60d ${easternDate(now, 60)}, -7d ${easternDate(now, -7)}.`,
    ].join('\n'),
  )

  sections.push(renderCatalog(kinds, unanswerable))

  sections.push(
    [
      '# Widgets',
      'A widget is `{ id, title, size, query, view }`.',
      '- size: lg (hero, 2x2), md (2x1), sm (1x1). The first widget is the hero and should be lg.',
      '- view: `{ type: "table" }` for any kind. `{ type: "series", candle?: boolean, normalize?: boolean }` only for ohlcv.',
      '- candle: exactly one symbol. normalize: rebases every symbol to 100, use it for baskets. Never both.',
      '- Titles are short (two to five words). ids are optional; omit them and w1..wN are assigned in order.',
      '- Four to six widgets. Series for price over time, tables for quote, news, earnings, search.',
    ].join('\n'),
  )

  sections.push(
    [
      '# Rules',
      '1. Run queries before writing. Never write a figure that is not in a preview you received this turn. Day changes come from `quote`, range changes from the ohlcv preview stats (`changePct`).',
      '2. Resolve names to symbols with ONE `search` call that batches every lookup (`q: ["memory", "MU", ...]`). Skip search when the user gives tickers you are sure of.',
      '3. Issue independent queries in parallel (several tool calls in one turn). You have at most 10 tool calls per prompt, including `set_workspace`.',
      '4. Call `set_workspace` exactly once, after the queries, with the complete widget set. A prompt overwrites the workspace: to keep a current widget, re-emit it. "Add the news" means the current widgets plus a news widget.',
      '5. If `set_workspace` returns errors, fix them and call it again.',
      '6. Then reply in two to four plain sentences. End with chips for the widgets the reply draws on, written exactly as `[[widget:<id>]]` using the ids returned by `set_workspace`. No markdown headings, no bullet lists, no tables in the reply.',
      '7. A bare ticker such as "MU" means "Overview of MU": chart, quote, news, next earnings.',
      '8. Use only answerable kinds. If a kind is not answerable, leave that widget out and say so in one clause.',
      '9. Do not narrate before calling tools; call them.',
    ].join('\n'),
  )

  sections.push(renderExamples())

  sections.push(renderWorkspace(workspace))

  return sections.join('\n\n')
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MARKET_LABEL: Record<MarketState, string> = {
  pre: 'pre-market (04:00-09:30 ET)',
  regular: 'regular session (09:30-16:00 ET)',
  post: 'after-hours (16:00-20:00 ET)',
  closed: 'closed',
}

// ---------- catalog, generated from core ----------

function renderCatalog(answerable: Kind[], unanswerable: Kind[]): string {
  const lines = ['# Kinds (query catalog)']
  lines.push(
    answerable.length === 0
      ? 'Answerable now: none. No connector is configured; explain that and do not call tools.'
      : `Answerable now: ${answerable.join(', ')}.`,
  )
  if (unanswerable.length > 0) lines.push(`Not answerable now (no connector): ${unanswerable.join(', ')}.`)
  for (const kind of KIND_NAMES) {
    const def = KINDS[kind] as KindDef
    const mark = answerable.includes(kind) ? '' : ' [unavailable]'
    lines.push(`- ${kind}${mark}: ${def.description}`)
    lines.push(`  params ${renderParams(def.params)}`)
    lines.push(`  columns ${def.columns.map((c) => `${c.name}:${c.type}`).join(', ')}`)
  }
  lines.push('`time` columns are epoch milliseconds. Any cell may be null. Multi-symbol frames carry a `symbol` column.')
  return lines.join('\n')
}

type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  format?: string
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  default?: unknown
  description?: string
}

/** Compact one-line params, e.g. `{ symbols: string[] (1-50), interval: 1m|5m|15m|1h|1d|1w, limit?: integer 1-100 = 20 }`. */
export function renderParams(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as JsonSchema
  const required = new Set(json.required ?? [])
  const props = Object.entries(json.properties ?? {})
  const parts = props.map(([name, p]) => {
    const opt = required.has(name) ? '' : '?'
    const def = p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''
    return `${name}${opt}: ${renderType(p)}${def}`
  })
  return `{ ${parts.join(', ')} }`
}

function renderType(p: JsonSchema): string {
  if (p.enum) return p.enum.map(String).join('|')
  if (p.const !== undefined) return JSON.stringify(p.const)
  if (p.type === 'array') {
    const inner = p.items ? renderType(p.items) : 'any'
    const bounds = p.minItems !== undefined || p.maxItems !== undefined ? ` (${p.minItems ?? 0}-${p.maxItems ?? '∞'})` : ''
    return `${inner}[]${bounds}`
  }
  if (p.format === 'date') return 'YYYY-MM-DD'
  if (p.type === 'integer' || p.type === 'number') {
    const bounds = p.minimum !== undefined || p.maximum !== undefined ? ` ${p.minimum ?? ''}-${p.maximum ?? ''}` : ''
    return `${p.type}${bounds}`
  }
  if (typeof p.type === 'string') return p.type
  return 'any'
}

// ---------- worked examples (PLAN.md section 5) ----------

function renderExamples(): string {
  const a = compactWidgets([
    w('Memory names, 3 months', 'lg', 'ohlcv', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], interval: '1d', range: '3mo' }, { type: 'series', normalize: true }),
    w('MU daily', 'md', 'ohlcv', { symbols: ['MU'], interval: '1d', range: '6mo' }, { type: 'series', candle: true }),
    w('Basket snapshot', 'md', 'quote', { symbols: ['MU', 'SNDK', 'WDC', 'STX'] }, { type: 'table' }),
    w('Upcoming earnings', 'sm', 'earnings', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], from: '<today>', to: '<today+60d>' }, { type: 'table' }),
    w('Memory news', 'md', 'news', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], limit: 20 }, { type: 'table' }),
  ])
  const b = compactWidgets([
    w('NVDA vs SPY vs SMH today', 'lg', 'ohlcv', { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' }, { type: 'series', normalize: true }),
    w('NVDA today', 'md', 'ohlcv', { symbols: ['NVDA'], interval: '5m', range: '1d' }, { type: 'series', candle: true }),
    w('Semis today', 'md', 'quote', { symbols: ['NVDA', 'AMD', 'AVGO', 'TSM', 'SMH', 'SPY'] }, { type: 'table' }),
    w('NVDA news, 24h', 'md', 'news', { symbols: ['NVDA'], limit: 20 }, { type: 'table' }),
  ])
  const c = compactWidgets([
    w('Watchlist pre-market', 'lg', 'quote', { symbols: ['<watchlist>', 'SPY', 'QQQ'] }, { type: 'table' }),
    w('Reporting today', 'sm', 'earnings', { symbols: ['<watchlist>'], from: '<today>', to: '<today>' }, { type: 'table' }),
    w('Overnight news', 'md', 'news', { symbols: ['<watchlist>'], limit: 20 }, { type: 'table' }),
    w('SPY and QQQ, 5 days', 'md', 'ohlcv', { symbols: ['SPY', 'QQQ'], interval: '1d', range: '5d' }, { type: 'series' }),
  ])
  return [
    '# Worked examples',
    'A. "What\'s happening with memory?" (theme research). Steps: search ["memory", "MU", "SNDK", "WDC", "STX"] → in parallel: ohlcv 1d 3mo basket, ohlcv 1d 6mo MU, quote basket, news basket, earnings basket next 60 days → set_workspace:',
    a,
    'Reply: "Over three months MU is up A%, SNDK B%, WDC C%, STX D%. MU reports on DATE. Recent news clusters around HBM demand and contract pricing. [[widget:w1]] [[widget:w5]]" where every figure is a changePct from the ohlcv preview or a row in a table.',
    '',
    'B. "Is NVDA\'s drop today news or just the market?" (event diagnosis). Steps: search NVDA plus peers (AMD, AVGO, TSM, SMH, SPY) in one call → in parallel: ohlcv 5m 1d NVDA+SPY+SMH, ohlcv 5m 1d NVDA, quote all, news NVDA → set_workspace:',
    b,
    'Reply: "NVDA is down X% today against SMH down Y% and SPY down Z%, so most of the move is sector. The only NVDA-specific headline in the last 24h is … [[widget:w1]] [[widget:w4]]". Day changes come from the quote preview, not the intraday bars.',
    '',
    'C. "Morning check on my watchlist" (recurring). The watchlist is the symbols in the prompt or already in the workspace. Steps, in parallel: quote watchlist+SPY+QQQ, earnings watchlist today, news watchlist, ohlcv 1d 5d SPY+QQQ → set_workspace:',
    c,
    'Reply: "Three names are moving pre-market: … X reports before the open. SPY and QQQ are flat pre-market. [[widget:w1]] [[widget:w2]]".',
  ].join('\n')
}

type ExampleWidget = { title: string; size: Widget['size']; query: { kind: Kind; params: Record<string, unknown> }; view: Record<string, unknown> }
function w(title: string, size: Widget['size'], kind: Kind, params: Record<string, unknown>, view: Record<string, unknown>): ExampleWidget {
  return { title, size, query: { kind, params }, view }
}
function compactWidgets(ws: ExampleWidget[]): string {
  return ws.map((x, i) => `  w${i + 1} ${JSON.stringify({ title: x.title, size: x.size, query: x.query, view: x.view })}`).join('\n')
}

// ---------- current workspace ----------

function renderWorkspace(ws: Workspace): string {
  const widgets = ws.widgets.map((x) => ({ id: x.id, title: x.title, size: x.size, query: x.query, view: x.view }))
  const messages = ws.messages.slice(-PROMPT_HISTORY).map(compactMessage)
  const lines = ['# Current workspace', `Name: ${JSON.stringify(ws.name)}. Widgets: ${widgets.length}. Earlier messages shown: ${messages.length}.`]
  lines.push(JSON.stringify({ id: ws.id, name: ws.name, widgets, messages }))
  if (widgets.length === 0) lines.push('The workspace is empty: this is the first prompt. Suggest a short workspace `name` in set_workspace.')
  else lines.push('Re-emit any of these widgets you want to keep; anything you leave out disappears.')
  return lines.join('\n')
}

function compactMessage(m: Message): { role: Message['role']; text: string } {
  const text = m.text.length > PROMPT_MESSAGE_CHARS ? `${m.text.slice(0, PROMPT_MESSAGE_CHARS)}…` : m.text
  return { role: m.role, text }
}
