# terminal — v1 plan and handoff

Repository: https://github.com/williammtan/terminal. Until code exists, this file is the single source of truth. "terminal" is a working name; the real name is undecided.

## 0. Handoff

**Status (2026-10-16, later).** Phase 0 is done: the pnpm monorepo is scaffolded with every package and dependency declared, `packages/core` implements section 7.4 with 29 unit tests, yahoo-finance2 is probed (`docs/notes/yahoo-probe.md`), and every Phase 1 seam exists as a typed stub (`docs/notes/phase1-contracts.md`). `pnpm typecheck && pnpm test` are green. Phase 1 is next. Nothing is waiting on the user except the product name.

**If you are taking over**, read this file once top to bottom, then:

1. Start at Phase 0 in section 11. Do not fan out to parallel work before Phase 0 is green.
2. Use the vocabulary in section 3 exactly, in code, docs, and commit messages.
3. When something here turns out to be wrong, change this file in the same commit as the code and say why in the commit message.
4. Load the `dataviz` skill before writing any chart or palette code.
5. Anything marked **Ask** needs the user; everything else is yours to decide.

**Decisions already made, and why.**

- A prompt overwrites the workspace. No diff, no accept/reject. The user chose this for simplicity; a follow-up prompt re-emits the widgets it wants to keep.
- cordis is deferred. Contributors only ever see `defineConnector`, so the loader can be swapped for a cordis one later (DeepSeek Harness is the reference for that) without touching a connector. Chosen to avoid an unstable dependency in v1.
- Five kinds, two views, two agent tools, two connectors. Every trim in section 9 was checked against the three use cases in section 5; add nothing back without a use case that needs it.
- Local-first and bring your own keys. One process on localhost plus the browser. Keys never leave the machine, data is never redistributed, so there is no licensing problem and no backend to host.
- No dragging. CSS grid auto-packs widgets by size. Fewer dependencies, no layout state to persist.
- Layout feels like Cursor: a centered prompt that becomes a right sidebar after the first prompt (section 6).
- US equities only. Yahoo is the zero-key connector so the app works on first run; Finnhub (free key) adds news and proves the contributor path.
- Stack: Node 22, pnpm, TypeScript, Zod, Hono, Vite + React, Tailwind, lightweight-charts, cmdk, Vercel AI SDK, Vitest. MIT.
- Phase 0 contract details, decided while writing core and reflected in section 7.4: `time` columns are epoch milliseconds; any cell may be null; `Stats.changePct` is `number | null` (null when the first value is 0); `Step` has an optional `error`; the `widgets` server message carries an optional workspace `name`; `Registry.run` takes `{ signal?, bypassCache? }`; `Cache.set` takes an optional ttl; the registry validates frame columns against the catalog by name, type, and order. Ports and seam signatures are in `docs/notes/phase1-contracts.md`.
- Vercel AI SDK v7 and Zod 4 are what installed. Read the installed types in `node_modules` rather than remembering older APIs.

**Open, in priority order.**

- **Ask** Product name. The user's shortlist: Aerotyne, Sideways, Blotter, Candle. "Wally" is a candidate name for the agent persona. Keep `terminal` as the placeholder and keep it in one place (package scope and CLI bin) so renaming is one change.
- Default model. Use the latest Claude Sonnet through the Vercel AI SDK; read the provider's current model list at build time instead of guessing an id.
- ~~yahoo-finance2 coverage.~~ Verified in Phase 0: search, quote with pre and post-market fields, chart at 5m and 1wk, and quoteSummary calendarEvents all work on 4.0.4. Chart takes period1/period2 only (no `range`), and intraday includes pre/post bars unless `includePrePost: false`. Details in `docs/notes/yahoo-probe.md`.

**Reference material.** The visual reference is Instinct (instinct.xyz, YC, launched 2026-10-14): a dark terminal with a top tab bar of workspaces, a three-column grid of chart widgets each with edit, refresh, and expand actions, and a right chat panel whose reply links back to the workspace. Background: cordis (github.com/cordiverse/cordis) and DeepSeek Harness (github.com/deepseek-ai/deepseek-harness) for the plugin model to adopt later; OpenBB Workspace (docs.openbb.co/workspace) for the incumbent's widget and MCP model.

## 1. Context: the problem

A retail trader asking a simple question like "what's happening with memory?" opens eight tabs: TradingView for the chart, Yahoo for fundamentals, a news site, X for sentiment, SEC for filings, an options-flow site, Discord. Nothing is connected. You cannot ask a question across them, and the answer lives in your head, assembled by hand, and is gone when you close the tabs.

The alternatives each miss:
- **Bloomberg** connects everything, for $25k a year, behind a 1980s UI.
- **ChatGPT / Perplexity** answer in prose with no live views and numbers you cannot trust.
- **OpenBB** open-sourced the data layer but sells the workspace and is drifting to institutions.
- **Instinct** is the right shape but closed, waitlisted, and crypto-first.

The gap: one open, local place where a question becomes a connected, live set of views, and the written answer points at those views.

## 2. The idea in one paragraph

You type a question. An agent turns it into a **workspace**: four to six **widgets**, each a live query against a **connector** rendered as a chart or table, plus a short reply that links to the widgets it is drawing on. Ask a follow-up and the workspace is rewritten. Everything runs on your machine with your own API keys. Connectors are plugins anyone can write in about 50 lines.

## 3. Vocabulary

Seven nouns. Users see workspace, widget, and connector. Contributors need all seven.

| Term | Definition |
|---|---|
| **Workspace** | A named tab holding a set of widgets and the conversation that produced them. Everything in the app is a workspace, including one created from a ticker. |
| **Widget** | One query rendered by one view, with a title and a size (lg, md, sm). Editable by hand or by the agent. |
| **Query** | `{ kind, params }`. The kind names one contract from the catalog in section 7: a param schema plus the columns of the resulting frame. Widgets hold queries; connectors answer them. |
| **Frame** | The only data shape that crosses from connector to view: typed columns plus rows. |
| **View** | A renderer for a frame: `series` or `table` in v1. Built into the web app. |
| **Connector** | A plugin that answers one or more kinds from an external source. Holds its own config (API key). Runs server-side. |
| **Agent** | The planner that turns a prompt into a workspace. |

Also used: a **preview** is the part of a frame the agent sees (columns, row count, rows, per-symbol stats). The agent's text answer is the **reply**. A **chip** is a link in the reply to a widget. A **step** is one tool call shown in the conversation.

## 4. Product rules

1. **A prompt overwrites the workspace.** Each prompt produces a complete new widget set that replaces the old one. The agent sees the current widgets in context, so "add the news" means it re-emits the existing widgets plus one more.
2. **Everything is a workspace.** Typing `MU` in the prompt creates a workspace from "Overview of MU". No Home, no Feed, no Save button, no watchlist feature; every workspace persists until deleted.
3. **Layout is automatic.** The agent assigns sizes, not positions. A CSS grid packs them. No dragging in v1.
4. **Numbers come from previews.** The agent must run queries before writing a reply and never writes a figure that is not in a preview. Series legends show each symbol's last price and change over the range, and previews return exactly those numbers, so the reply and the widget agree.
5. **Local-first, bring your own keys.** One local process, keys never leave the machine, no hosted backend, no accounts.
6. **Research and monitoring only.** No order execution in v1. US equities only.

## 5. Three use cases

All three must work end to end with the v1 kinds, views, and two connectors in section 7.

### A. "What's happening with memory?" (theme research)

Agent steps: `search` the basket in one call (MU, SNDK, WDC, STX) → in parallel: `ohlcv` 3mo daily for the basket, `ohlcv` 6mo daily MU, `quote` basket, `news` basket, `earnings` basket next 60 days → `set_workspace`.

| Widget | Query | View | Size |
|---|---|---|---|
| Memory names, 3 months rebased | ohlcv, 1d, 3mo, basket | series, normalize | lg |
| MU daily | ohlcv, 1d, 6mo, MU | series, candle | md |
| Basket snapshot | quote, basket | table | md |
| Upcoming earnings | earnings, basket | table | sm |
| Memory news | news, basket | table | md |

Reply: "Over three months MU is up A%, SNDK B%, WDC C%, STX D%. MU reports on DATE. Recent news clusters around HBM demand and contract pricing. [Memory names] [Memory news]". Every figure is a per-symbol change from the ohlcv preview or a row in a table.

### B. "Is NVDA's drop today news or just the market?" (event diagnosis)

Agent steps: `search` NVDA plus the peers it names (AMD, AVGO, TSM, SMH, SPY) in one call → in parallel: `ohlcv` 5m 1d for NVDA, SPY, SMH; `ohlcv` 5m 1d NVDA; `quote` for all of them; `news` NVDA → `set_workspace`.

| Widget | Query | View | Size |
|---|---|---|---|
| NVDA vs SPY vs SMH today | ohlcv, 5m, 1d | series, normalize | lg |
| NVDA today | ohlcv, 5m, 1d, NVDA | series, candle | md |
| Semis today | quote, NVDA + peers + SPY + SMH | table | md |
| NVDA news, 24h | news, NVDA | table | md |

Reply: "NVDA is down X% today against SMH down Y% and SPY down Z%, so most of the move is sector. The only NVDA-specific headline in the last 24h is ... [NVDA vs SPY vs SMH] [NVDA news]". The day changes come from the `quote` preview, not from the intraday bars.

### C. "Morning check on my watchlist" (recurring monitoring)

The user keeps a workspace named Morning and re-runs the same prompt each day. Overwrite semantics make this natural. The watchlist is the symbols named in the prompt or already in the workspace.

Agent steps: in parallel: `quote` for the watchlist plus SPY and QQQ, `earnings` watchlist today, `news` watchlist, `ohlcv` 5d daily SPY and QQQ → `set_workspace`.

| Widget | Query | View | Size |
|---|---|---|---|
| Watchlist pre-market | quote, watchlist + SPY + QQQ | table | lg |
| Reporting today | earnings, watchlist | table | sm |
| Overnight news | news, watchlist | table | md |
| SPY and QQQ, 5 days | ohlcv, 1d, 5d | series | md |

Reply: "Three names are moving pre-market: ... X reports before the open. SPY and QQQ are flat pre-market. [Watchlist pre-market] [Reporting today]".

## 6. Architecture

### Repo layout (pnpm monorepo, TypeScript)

```
packages/
  core/       Frame, Widget, Workspace types; kind catalog; defineConnector; registry; cache; protocol
  server/     connector loader, HTTP + WebSocket API, JSON file store, agent loop (src/agent)
  ui/         design system: tokens, components, chart theme, preview page
  web/        React app: shell, state, WebSocket client, palette, connectors page, views (src/views)
  cli/        `npx terminal` → starts server on localhost, opens browser
connectors/
  yahoo/      no key; search, quote, ohlcv, earnings
  finnhub/    free key; quote, news, earnings
docs/
  vocabulary.md, writing-a-connector.md
```

### Connectors are plain modules behind one helper

Contributors write one file. This contract is fixed from day one and does not change if the loader underneath changes.

```ts
export default defineConnector({
  name: 'finnhub',
  config: z.object({ apiKey: z.string() }),
  queries: {
    quote:    async ({ symbols }, { http, config }) => toFrame('quote', rows),
    news:     async ({ symbols, limit }, { http, config }) => toFrame('news', rows),
    earnings: async ({ symbols, from, to }, { http, config }) => toFrame('earnings', rows),
  },
})
```

**Loader (v1):** `~/.terminal/config.yml` lists connectors with their config. The server imports each module, validates its config against its schema, and registers each kind it answers into the registry. Config order is routing priority. Config changes restart the process. In dev, `tsx watch` restarts on source change.

### Core services (server)

- **registry**: kind → ordered list of connectors. `run(query)` tries them in config order, falls back on error, validates the frame's columns against the catalog.
- **cache**: in-memory, keyed by kind plus stable-stringified params, TTL per kind (quote 10s, intraday ohlcv 60s, daily ohlcv 10m, news 2m, earnings 1h, search 1d). Only the focused workspace polls.
- **store**: `~/.terminal/workspaces/<id>.json`, one file per workspace. No database.
- **agent**: the loop below, behind the `AgentRunner` interface so the API and the loop can be built separately.

### Agent loop

Provider-agnostic via the Vercel AI SDK, keys from config. Two tools:

| Tool | Returns |
|---|---|
| `query(kind, params)` | a preview: columns, row count, every row when the frame has 25 or fewer rows, otherwise the first 25, and per symbol per numeric column: first, last, min, max, change percent. The full frame is cached so widget rendering does not refetch. |
| `set_workspace({ name?, widgets })` | validates every widget against kind and view schemas, replaces the workspace widgets, starts executing them. |

Symbol lookup is `query('search', { q: [...] })`, batched. The model is told to issue independent queries in parallel. Hard cap of ten tool calls per prompt.

System prompt: the kind catalog with param schemas (generated from core), which kinds are currently answerable (from registry), the current workspace JSON, today's date and market state, and the rules: run queries before writing numbers, four to six widgets, first widget is the hero, short titles, overwrite semantics.

The final assistant text is the reply. `[[widget:<id>]]` tokens render as chips that scroll to and flash the widget.

### Web app: layout in the spirit of Cursor

Three states. The design system (tokens, components, chart theme) lives in `packages/ui`; the shell, state, and views live in `packages/web`.

- **Empty.** A new workspace shows only a centered PromptBox (max width 640px) with the three example prompts from section 5 as chips beneath it and a hint for the palette. The tab bar is at the top but quiet.
- **Active.** On the server's `started` message the PromptBox moves to the bottom of a right sidebar (380px) that holds the conversation: the user's message, a collapsible Steps header ("Worked for 12s · 5 steps"), and the reply with chips. The center fills with the grid as `widgets` and then `frame` messages arrive; each widget is a skeleton until its frame lands.
- **Transition.** The View Transitions API with a `view-transition-name` on the PromptBox, so the box visibly slides from center to sidebar. No animation library. Browsers without support just switch.
- **Sidebar** toggles with ⌘\ as in Cursor. Below 1100px it overlays the grid.
- **Grid.** CSS grid, three columns, `grid-auto-flow: dense`; lg spans 2x2, md 1x2, sm 1x1; first widget placed first.
- **Views.** `series` on lightweight-charts with options `{ candle?, normalize? }`, mutually exclusive; candle requires exactly one symbol; normalize uses the chart's indexed-to-100 price scale mode; the legend shows each symbol's last price and change over the range. `table` with typed formatting (price, percent, time, link) and column sort.
- **Widget.** Title; actions edit (query and view as a form in a dialog), refresh, expand; loading, error, and empty states.
- **Also**: `/` or ⌘K opens the palette (new workspace, jump to workspace, ticker shortcut); a connectors page lists each connector with status (ok, missing key, error) and a key field; a NoKeys state explains how to add an LLM key.
- **Theme.** Dark only. Tokens on root; 13px base type, 8px grid unit for density; green and red for up and down; a categorical palette of six for multi-symbol series; one accent.

## 7. The v1 contract

### 7.1 Kinds

| Kind | Params | Frame columns |
|---|---|---|
| `search` | q[] | query, symbol, name, exchange |
| `quote` | symbols[] | symbol, price, change_pct, volume, market_state, extended_price, extended_change_pct |
| `ohlcv` | symbols[], interval (1m 5m 15m 1h 1d 1w), range (1d 5d 1mo 3mo 6mo 1y 5y) | symbol, time, open, high, low, close, volume |
| `news` | symbols[], limit | time, headline, source, url, symbol |
| `earnings` | symbols[], from, to | symbol, date, session (bmo, amc, or null), eps_estimate |

Long format throughout: multi-symbol results carry a `symbol` column. `symbols` is required on every kind because no free source offers a market-wide calendar or news feed.

### 7.2 Views

`series` and `table`. Nothing else in v1.

### 7.3 Connectors

| Connector | Key | Kinds | Notes |
|---|---|---|---|
| yahoo | none | search, quote, ohlcv, earnings | via yahoo-finance2, pinned and fixture-tested. Quote has pre and post-market fields. Chart takes period1/period2 and `1wk`, so the connector maps range and interval. Earnings via quoteSummary calendarEvents: next date and estimate only, session null. |
| finnhub | free | quote, news, earnings | 60 calls/min. Quote has no extended hours (fallback only). Company news is one symbol per call with day granularity, so the connector fans out and filters to the window locally. Earnings calendar includes an hour field that maps to session. |

Finnhub `quote` exists so price tables survive a Yahoo breakage.

### 7.4 Core contract sketch

Phase 0 writes these into `packages/core/src` as Zod schemas with inferred types. They are the seams between parallel workstreams and are read-only during Phase 1.

```ts
// frame.ts
type Column = { name: string; type: 'string' | 'number' | 'time' | 'boolean' }
type Frame = { columns: Column[]; rows: unknown[][]; meta: { connector: string; fetchedAt: number; ttl: number } }

// kinds.ts — KINDS[kind] = { params: ZodSchema, columns: Column[], ttl: number }, exactly section 7.1
type Kind = 'search' | 'quote' | 'ohlcv' | 'news' | 'earnings'
type Query = { kind: Kind; params: Record<string, unknown> }

// widget.ts
type View = { type: 'series'; candle?: boolean; normalize?: boolean } | { type: 'table' }
type Widget = { id: string; title: string; size: 'lg' | 'md' | 'sm'; query: Query; view: View }

// workspace.ts
type Step = { tool: 'query' | 'set_workspace'; args: unknown; summary: string; ms: number; error?: string }
type Message = { role: 'user' | 'agent'; text: string; steps?: Step[] }
type Workspace = { id: string; name: string; widgets: Widget[]; messages: Message[]; createdAt: number; updatedAt: number }

// preview.ts
type Stats = { first: number; last: number; min: number; max: number; changePct: number | null }
type Preview = { columns: Column[]; rowCount: number; rows: unknown[][]; stats: Record<string, Record<string, Stats>> } // symbol → column → stats
function preview(frame: Frame): Preview

// connector.ts
type Ctx<C> = { http: { get(url: string, init?: RequestInit): Promise<unknown> }; config: C; log(msg: string): void }
type Handler<P, C> = (params: P, ctx: Ctx<C>) => Promise<Frame>
function defineConnector<C>(def: { name: string; config: ZodSchema<C>; queries: Partial<Record<Kind, Handler<any, C>>> }): Connector
function toFrame(kind: Kind, rows: Record<string, unknown>[], meta?: Partial<Frame['meta']>): Frame

// registry.ts, cache.ts
interface Registry { register(c: Connector, config: unknown): RegisteredConnector; kinds(): Kind[]; connectors(): RegisteredConnector[]; run(q: QueryInput, opts?: { signal?: AbortSignal; bypassCache?: boolean }): Promise<Frame> }
interface Cache { get(q: Query): Frame | undefined; set(q: Query, f: Frame, ttl?: number): void; delete(q: Query): void; clear(): void }

// protocol.ts — one WebSocket per client
type ClientMsg =
  | { t: 'prompt'; workspaceId: string; text: string }
  | { t: 'cancel'; workspaceId: string }
  | { t: 'refresh'; widgetId: string }
  | { t: 'focus'; workspaceId: string }
type ServerMsg =
  | { t: 'started'; workspaceId: string }
  | { t: 'step'; workspaceId: string; step: Step }
  | { t: 'widgets'; workspaceId: string; widgets: Widget[]; name?: string }
  | { t: 'frame'; widgetId: string; frame: Frame }
  | { t: 'frameError'; widgetId: string; error: string }
  | { t: 'delta'; workspaceId: string; text: string }
  | { t: 'done'; workspaceId: string; message: Message }
  | { t: 'failed'; workspaceId: string; error: string }

interface AgentRunner { run(input: { workspace: Workspace; prompt: string; signal: AbortSignal; emit(m: ServerMsg): void }): Promise<Message> }
```

HTTP routes: `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/:id`, `GET /api/widgets/:id/frame`, `GET /api/connectors`, `PUT /api/connectors/:name/config`.

On disk: `~/.terminal/config.yml` holds `llm: { provider, model, apiKey }` and `connectors: [{ name, config? }]` in priority order; `~/.terminal/workspaces/<id>.json` holds one Workspace.

Message sequence for a prompt: `started` (the web app moves Empty to Active here) → `step`… → `widgets` (grid renders skeletons) → `frame` or `frameError` per widget, interleaved with `delta`… → `done`. `failed` can replace anything after `started`.

## 8. Tech choices

Node 22, pnpm workspaces, TypeScript strict, Zod for every schema, Hono for HTTP and WebSocket, Vite + React, Tailwind for tokens, lightweight-charts, cmdk for the palette, Vercel AI SDK, Vitest. MIT license.

## 9. Cut from v1

Each of these is a real feature someone will ask for. Cutting them is what keeps v1 buildable in weeks.

- Diff / accept-reject of agent edits (overwrite instead)
- Home and Feed pages, Save button, watchlist feature
- Dragging and resizing widgets (CSS grid auto-packing instead)
- `stat`, `heatmap`, `text`, `list` views; `area` series style
- `peers` kind (the agent names peers and validates them with `search`)
- Multi-query widgets (price with open interest overlay)
- Real-time streaming (TTL polling instead)
- cordis spine, views and agents as plugins (loader swap later)
- Grounded numeric chips bound to widget fields (reply links to widgets instead)
- Alerts, automations, scheduling
- Order execution and broker connectors
- Crypto connectors (ideal first community connector), non-US tickers
- Economic calendar, options flow, filings, fundamentals kinds
- Auto-generated settings forms (connectors page with a key field per connector instead)
- Desktop packaging (Tauri later), auth, hosting, multi-user

## 10. Milestones

| # | Deliverable | Proves |
|---|---|---|
| M0 Spine | core types, kind catalog, registry, cache, protocol, yahoo connector, `pnpm query ohlcv AAPL 1d 3mo` prints a frame | the contract |
| M1 Terminal, no AI | web shell, workspaces, grid, series and table views, manual add-widget form | widget = query + view |
| M2 Agent | chat panel, agent loop, two tools, streaming steps and frames | use cases A and B pass |
| M3 Contribution path | finnhub via `defineConnector`, writing-a-connector.md, `create-connector` template with fixture tests | use case C passes; a stranger can add a connector |
| M4 Launch | palette, connectors page, theme pass, README with the three use cases as recordings, `npx terminal` | first run in under two minutes |

## 11. Build plan for parallel agents

The milestones above are the order of proof. The build itself is parallel: after a short trunk phase, eight workstreams run at once because their paths are disjoint and their only shared code is `packages/core`, frozen in Phase 0.

### Phase 0: trunk (one agent, sequential)

1. Scaffold the monorepo: `pnpm-workspace.yaml`, root `package.json` with `dev`, `build`, `typecheck`, `test` scripts, `tsconfig.base.json`, Vitest config, a minimal ESLint config, a `package.json` for every package and connector in section 6 with every dependency the later phases need already declared, then one `pnpm install`.
2. Write `packages/core` from section 7.4 as Zod schemas with inferred types, `preview()`, `toFrame()`, the registry and cache implementations, and unit tests for each.
3. Probe yahoo-finance2 with a scratch script for the four kinds and record what it actually returns in `docs/notes/yahoo-probe.md`.
4. Done when `pnpm typecheck && pnpm test` are green and the lockfile is committed.

### Phase 1: fan out (one workflow, eight agents in parallel)

| Workstream | Owns | Builds | Done when |
|---|---|---|---|
| ui | `packages/ui` | tokens, components (PromptBox, Tabs, WidgetFrame, DataTable, Chip, Steps, Skeleton, Kbd, Button, IconButton, Dialog), lightweight-charts theme, a preview page | preview page renders every component in dark mode; typecheck green |
| yahoo | `connectors/yahoo` | search, quote, ohlcv, earnings via `defineConnector`; recorded fixtures | fixture tests green; a live smoke script prints a frame per kind |
| finnhub | `connectors/finnhub` | quote, news, earnings; recorded fixtures | same |
| server | `packages/server` except `src/agent`, `packages/cli` | config loader, registry wiring, cache TTLs, store, HTTP and WebSocket per section 7.4, widget execution, `npx terminal` | with a stub AgentRunner, a hand-written workspace file renders over the socket; route tests green |
| agent | `packages/server/src/agent` | AgentRunner on the Vercel AI SDK, two tools, preview, system prompt builder | use cases A and B produce valid widget sets against recorded tool responses |
| web | `packages/web` except `src/views` | shell with states Empty, Active, Streaming, Error, NoKeys; transition; socket client; palette; connectors page | runs against the server with the stub agent; transition works |
| views | `packages/web/src/views` | series and table | renders fixture frames for every widget row in section 5 |
| docs | `docs/`, `README.md` | vocabulary.md, writing-a-connector.md, README | a reader can write a connector from docs alone |

Rules for every Phase 1 agent: touch only your owned paths; never add a dependency (report the need instead); `packages/core` is read-only, report contract gaps rather than patching them; finish with your package's typecheck and tests green; return a short report of what is built, what is stubbed, and what is blocked.

### Phase 2: integrate (one agent, then one verifier per use case)

Replace stubs, run `pnpm dev`, run use cases A, B, C with real keys, and fix seams anywhere in the repo. Then one verifier per use case checks the workspace against the section 5 table and every number in the reply against the tool transcript. At most two rounds.

### Phase 3: launch

Theme pass, recordings of the three use cases for the README, fresh-clone `npx terminal` test.

## 12. Verification

- **Contract**: Vitest schema tests for every kind and view (including candle-with-one-symbol and candle-xor-normalize); every connector has recorded-fixture tests so CI never hits the network.
- **M0**: the query CLI prints valid frames for all yahoo kinds.
- **M1**: build a workspace by hand matching use case A's widget table; charts render; refresh works; reload restores it.
- **M2 and M3**: run each use case prompt three times; assert the workspace contains the expected kinds and views, every number in the reply appears in the tool transcript's previews, and total time stays under 30 seconds.
- **M4**: fresh clone, `npx terminal`, type the use case A prompt, workspace appears with no keys configured (yahoo only), then add a Finnhub key on the connectors page and re-run to get news.
