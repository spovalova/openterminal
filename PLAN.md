# Open Terminal — v1 plan and handoff

Repository: https://github.com/spovalova/openterminal (moved from williammtan/terminal on 2026-10-18). Until code exists, this file is the single source of truth. The product is called **Open Terminal** (decided 2026-10-18). `terminal` remains the package scope, CLI bin and config directory until the rename commit; `open-terminal` on npm is held by an unrelated 2022 package, so the published name is `openterminal` unless the user prefers a scoped `@open-terminal/cli`.

## 0. Handoff

**Status (2026-10-19, night): v2 phase 3a done; the kinds are gone.** Section 17 is the plan and its status line carries the phase list; sections 7.1 and 14 are history. A query is a route, a recipe or a transform; a connector is `descriptors()` plus `call()`; units come from `packages/core/annotations.yml`, the common questions from `packages/core/recipes.yml` (24 recipes, the README table generated from it), selection and derivation from pandas in a recipe's data graph or a transform. **If you are taking over**, read section 17 top to bottom, then `docs/architecture.md`, `docs/vocabulary.md` and `docs/writing-a-connector.md` (rewritten for v2 in 3a), then `packages/core/src`. What is left of v2: the rubric runs (phase 2's agent half, blocked on API credit: the CRWV rerun, the six remaining `v2` prompts, the fifteen `v1` regression prompts), then 3b and beyond as section 17's "Also in v2" lists them. Production (`localhost:4242`) still runs `main`; a redeploy after this PR merges runs the one-time JSON → SQLite migration on `~/.terminal/workspaces` through `migrateWidget`.

**Status (2026-10-18, night): v2 phase 0 done.** Section 17 is the plan. Its trunk is in `packages/core`: descriptors and the OpenAPI generator (`descriptor.ts`, `descriptor-openapi.ts`, fixture under `packages/core/test/fixtures`), the catalog (`catalog.ts`), v2 queries beside the v1 kind query (`query.ts`), fields and shapes (`fields.ts`, `shape.ts`), annotations with the seed file (`annotations.ts`, `annotations.yml`), recipes with the 22 kinds (`recipes.ts`, `recipes.yml`), the widget model (`widget.ts` v2, `layers.ts`, `presets.ts`), the packer's size-by-content rule and the 960 px threshold (`layout.ts`), the clock (`clock.ts`), the transform contract (`transform.ts`), frame inference (`infer.ts`), `defineConnector` and the registry in both forms (`connector.ts`, `registry.ts`), and workspace-keyed frame messages (`protocol.ts`). 562 tests, typecheck and lint green; nothing user-visible changed and the v1 kind path is byte-for-byte the same, so production is unaffected. **If you are taking over v2**, read section 17, then `docs/notes/v2-contracts.md` (the exact exports each phase 1 workstream consumes, the files each owns, the stubs each must provide, the fixtures), then `packages/core/src` top to bottom. Phase 1 fans out into five workstreams, (a) to (e) in that note; (c) agent and (e) shell both touch `packages/server/src` outside `src/agent` and `src/store` only through the seams named there. The corrections phase 0 made to section 17 are listed under its status line.

**Status (2026-10-17, morning).** Phases 0 to 3 are done, except the literal `npx terminal`, which waits on the product name. `pnpm typecheck`, `pnpm test` (191 tests, no network), and `pnpm lint` are green, and a fresh clone installs from the lockfile and passes. With the user's Anthropic and Finnhub keys (kept in the gitignored `~/terminal/.env`, loaded into the environment before starting the server), the finnhub live smoke passed and the three use cases ran three times each against `claude-sonnet-5-5`: every run produced the section 5 widget set (4 to 6 widgets, lg hero, expected kinds and views), every widget received a frame, every figure and headline claim in every reply traced to a frame row or preview stat, and wall time was 7 to 12 seconds per prompt (almost all of it model latency; cached queries answer in under 1 ms). Use case C also proved the recurring flow: re-prompting the same workspace carried the watchlist over, overwrote the widgets, and left three user and three agent messages. The first live run found one defect, now fixed: the Anthropic API rejects a tool whose input schema is a top-level anyOf, so the `query` tool takes `{ kind, params }` with a most-specific-first union on params.

Phase 3 ran on headless Chromium (Playwright with `channel: 'chromium'`, since the machine has no display; the browser lives in `~/.cache/ms-playwright`, the driver scripts in the session scratchpad, nothing in the repo). The theme pass took screenshots of the shell, the grid after use case A, the palette, the widget editor, the expand dialog, the connectors page, a 1024px viewport, and the ui preview, and found three defects, all fixed in the Phase 3 commit: `WidgetFrame` had no height, so a widget rendered at its chart's 160px minimum and the lg hero sat in a short strip with empty rows below it (`h-full` on the section); the chart did not refit after a resize, so an expanded chart drew its bars in the left third of the dialog (`fitContent` in the ResizeObserver); `Dialog` was fixed at 520px, so the expand dialog could not be wide (`size="wide"`, 1200px). Both HTML shells also gained an inline SVG favicon. The recordings are in `docs/recordings/{a,b,c}.gif` (1280x800, 8 fps, about 2 MB each) and embedded in the README; each is one real prompt against the live connectors and `claude-sonnet-5-5`.

- Fresh-clone `npx terminal`: the equivalent (clone, frozen install, build, CLI boot, prompt) passes; the literal `npx terminal` needs the package published under its final name (an unrelated `terminal` package already exists on npm, so do not publish under the placeholder).
- Theme follow-ups seen in the screenshots, none blocking: ~~a 1x1 table widget clips its rightmost columns~~ (fixed by the layout pass, product rules 3 and 7); the candle chart's last-value label overlaps the price axis ticks; the sidebar overlays the grid below 1100px by design, which hides the widget action buttons at 1024px.

Observations from the verifiers worth a follow-up, none blocking: the agent never cites the candle widget with a chip; a news widget titled "24h" has no time window, only `limit`; the yahoo earnings `session` is always null, so replies cannot say "before the open" (Finnhub, second in routing order, does carry it, so swapping priority for `earnings` is a one-line config change); quote fields fetched for a widget can differ by cents from the preview the agent saw when extended hours are moving.

**v1.1 (2026-10-17, afternoon): OpenBB connector, section 13.** Done and verified live against OpenBB 5.0.0 installed in a venv on this machine (`~/.venvs/openbb`): the connector answers all five kinds, the Connectors page shows it as running (with its provider list) or not running (with the two install commands), the default config lists it first, and with it running the three use cases build their workspaces from `openbb` frames while a stopped API falls back to yahoo within the breaker. One contract addition: an optional `health` probe on `defineConnector`, run by `Registry.health` with a timeout, never on the query path. Findings that changed the plan are in `docs/notes/openbb-probe.md`: OpenBB 5's base package has no unified `equity/...` routes and no yfinance (hence the two-package install line), yfinance has no equity search and its company news is empty, `change_percent` is a fraction, and the earnings calendar is market-wide (nasdaq, 60 days in about 2 s).

**Production instance (2026-10-18).** The user asked for one always running on 4242. `deploy/systemd/` holds two systemd user units, `terminal.service` (loopback 4242, keys from `~/terminal/.env`, restart on crash and boot via linger) and `openbb-api.service` (6900), linked into `~/.config/systemd/user/` on this machine; `deploy/redeploy.sh` rebuilds the web app and restarts after a pull. The production `~/.terminal/config.yml` lists openbb, yahoo, finnhub. Not part of the shipped product: `npx terminal` stays the one-command story; this is how this VM is run.

**Prompt bench (2026-10-18).** Nine show-off prompts plus one ad-hoc run against production, written up in `docs/notes/prompt-bench-2026-10-18.md`, rerunnable with `pnpm bench` (`scripts/prompts.json`, `scripts/prompt-bench.mjs`). Seven pass or partial, three fail, all numbers in the replies verified against the frames. Open defects from it, in priority order: the model sometimes streams a one-line plan before the reply; "four to six widgets" is read as a floor even when the user asks for two (both are prompt edits in `packages/server/src/agent/prompt.ts`); no `2y` range in the ohlcv catalog; an empty search frame from the first connector is final and never falls through; multi-symbol news lets one name take most of the rows.

**Data gaps and vendors (2026-10-18).** `docs/notes/data-gaps-2026-10-18.md` maps about sixty prompt types against the five kinds and the keyless OpenBB routes installed here, ranks the gaps, and prices the vendors for the paid ones. Headline: the top five gaps (fundamentals and estimates, options chain and IV, economic calendar and macro, ownership and short interest, movers and screeners) are all keyless routes OpenBB already serves, so they are new kinds under section 7.1, not new vendors. Paid gaps: deep intraday history, options flow and GEX, per-ticker IV history, transcripts, consolidated real-time. Cheapest keys per gap: Massive $29, ThetaData $40, Alpaca $99, FMP $19 to $29, Unusual Whales API $150, ORATS $199. Social sentiment is effectively unavailable at retail prices.

**v1.2 catalog (2026-10-18): section 14, done.** The user asked for every kind the keyless OpenBB routes can feed, with new views where needed. Trunk landed first: 17 new kinds in `packages/core/src/kinds.ts` (22 total), a `2y` range, a `chain` view type, `querySymbols` for symbol-less and single-symbol kinds, previews grouped by `series` for macro, the agent's `query` tool taking open params validated by `parseQuery`, table formats and empty states for every kind. Then four parallel workstreams (openbb handlers, yahoo fallbacks, web views, agent prompt and docs), integrated and committed the same evening with production redeployed. Status and known limits are at the end of section 14.

**Prompt bench v2, strict (2026-10-18, night).** The user judged the first bench not strict, so `docs/notes/prompt-bench-v2-2026-10-18.md` grades seven use cases (why is CRWV down, compare the neoclouds, the S&P last week, rates and the macro calendar, TSLA puts, TSLA into earnings, a P/E screen) against a rubric written first: seven named criteria (answer first, facts complete, numbers verified, widgets right, rendering clean, cites and plain, time window and baseline) with a pass or fail each, a screenshot of every dashboard in `docs/screenshots/bench-v2-*.png`, and every figure checked against the recorded frames. Result: 0 pass, 1 partial, 6 fail. The fails split into data we do not have (corporate bond yields, which FINRA TRACE serves through OpenBB's finra provider, verified live for CoreWeave; a screener; sector performance; earnings reactions), data we have but did not show (financials and estimates in a comparison, `^GSPC` for "the S&P", calendar rows past the 25-row preview, bars around report dates), and UI defects (frames keyed by widget id leak across workspaces, so a tab can show another tab's data; the calendar time column truncates to the month; one-row tables 73% blank; markdown asterisks in replies; two prices for one stock between the chain and the quote). The note ends with sixteen ranked proposals with effort estimates; the four cheapest (per-workspace frames, calendar weekday column, plain replies, a `prevClose` preview stat) are correctness fixes, and the `bonds` kind is the one new kind the bench proves a need for. The bench script gained `--group` and a per-widget verification block; the prompts file carries the `v2` group beside `v1`.

**Shipping (2026-10-18).** The repo lives at https://github.com/spovalova/openterminal with one commit author (set in the repo git config). Every change is a PR from its own branch and worktree, opened with `scripts/pr.sh "<title>" <body.md>`, which pushes and creates the PR with the token from the gitignored `.env`. Agents run in parallel and open their own PRs; briefs say what to build and point at `docs/shipping.md`, nothing about identity or credentials. Before/after screenshots are committed on the branch under `docs/screenshots/` and embedded through `{{RAW}}`.

**Design system (2026-10-18, evening): type, widget chrome, stat view.** One PR on its own branch. Type: Geist for UI text and a mono stack for every number and code, `"Berkeley Mono", "Ioskeley Mono", ui-monospace, …`, with Ioskeley Mono vendored (section 6, Type). Widget chrome: a header and a derived sub-header per kind (`subtitleFor`, tested for all 22 kinds), quiet right-aligned actions, the series legend moved out of the plot into a strip, 12px padding and a hover border; the packer, the container queries and the column priorities from section 15 are untouched. A fourth view, `stat` (section 7.2), with a key-column table in core, an optional `column`, cards for several symbols and a one-shot tick on change; registered in the editor, the gallery, the agent's `set_workspace` schema and the prompt. One defect fixed on the way: frames are keyed by widget id and ids repeat across workspaces, so switching tabs showed the previous workspace's frame under the next workspace's widget until its own landed; `WidgetCell` now treats a frame whose columns are not the kind's as loading. 403 tests. Screenshots in `docs/screenshots/design-*.png`.

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

- ~~**Ask** Product name.~~ Decided 2026-10-18: **Open Terminal**. Positioning: the open-source, AI-native terminal for traders, "Cursor for trading". README rewritten around it. Still to do in one commit: rename the `@terminal/*` scope, the CLI bin, the `~/.terminal` config dir and the systemd units, and publish `openterminal` on npm. "Wally" remains a candidate name for the agent persona.
- Default model: `claude-opus-5-5` for anthropic (the user's choice on 2026-10-17; Sonnet 5.5 was the default through Phase 3 and is what the recordings used) and `gpt-6-luna` for openai, read from the installed provider packages' model id unions, defined once in `DEFAULT_MODEL` in `packages/server/src/agent/index.ts` and re-exported by `config.ts` (the two copies had drifted: config.ts said `gpt-5`).
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
3. **Layout is automatic.** The agent assigns sizes, not positions. `packLayout` (core) lays them out in a grid whose column count follows the grid's own width (two beside the open sidebar, three without it), and stretches a widget rather than leave a cell empty. Rows share the pane's height down to 240px. No dragging in v1.
7. **Nothing scrolls sideways.** A widget shows the columns that fit its width and drops the rest in a per-kind priority order (tables through container queries, the chain by measuring its width); long text truncates with a tooltip. Vertical scrolling only.
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
- **Views.** `series` on lightweight-charts with options `{ candle?, normalize? }`, mutually exclusive; candle requires exactly one symbol; normalize uses the chart's indexed-to-100 price scale mode; the legend is a strip between the sub-header and the plot (never over it) showing each symbol's last price and change over the range, under the symbol or the widget's `labels` override for it (section 16). `table` with typed formatting (price, percent, time, link) and column sort. `stat` (section 7.2) for one headline number.
- **Widget.** A header (the title) over a sub-header derived from the query by `subtitleFor(widget, frame)` in `packages/web/src/subtitle.ts`, one rule per kind ("NVDA · 5m · today", "4 symbols · 1d · 3mo, rebased", "NVDA · Oct 23 · 7 DTE · underlying 182.43", "MU · 20 headlines · last 3 days"); never typed by the agent or the user. Actions edit (query and view as a form in a dialog), refresh, expand sit at the right of the header and are quiet until the widget is hovered. One-pixel `border` token, 12px padding, `border-strong` on hover; loading, error and empty states on the same grid.
- **Also**: `/` or ⌘K opens the palette (new workspace, jump to workspace, ticker shortcut); a connectors page lists each connector with status (ok, missing key, error) and a key field; a NoKeys state explains how to add an LLM key.
- **Theme.** Dark only. Tokens on root; 13px base type, 8px grid unit for density; green and red for up and down; a categorical palette of six for multi-symbol series; one accent.
- **Type (2026-10-18).** UI text is Geist (Fontsource `@fontsource-variable/geist`, OFL). Every number and code is monospace through the `num` utility: the stack is `"Berkeley Mono", "Ioskeley Mono", ui-monospace, …`, so a locally installed Berkeley Mono (paid, never committed) wins and everyone else gets Ioskeley Mono (an Iosevka build, OFL, Regular, Medium, SemiBold and Italic vendored under `packages/ui/src/fonts/ioskeley` with its license, `font-display: swap`). Vite bundles the files so `npx terminal` serves them from localhost; nothing comes from a CDN. `tabular-nums` on body; table cells 12px, headers and legends 11px; mono runs half a pixel smaller than the sans on the same line (`font-size: calc(1em - 0.5px)`), which puts the two x-heights level. The chart axis uses the same mono stack and is repainted once the font has loaded.

## 7. The v1 contract

### 7.1 Kinds

**Superseded by section 17 (v2 phase 3a, 2026-10-19).** Kinds no longer exist in the code: `packages/core/src/kinds.ts` is deleted, a query is a route, a recipe or a transform, and this table lives on as the first 22 entries of `packages/core/recipes.yml` (the README's recipe table is generated from it). Kept for history.

v1 shipped the first five. v1.2 (section 14) added the rest over routes the keyless OpenBB providers already serve. Every kind was "a param schema plus exact columns".

| Kind | Params | Frame columns | Since |
|---|---|---|---|
| `search` | q[] | query, symbol, name, exchange | v1 |
| `quote` | symbols[] | symbol, price, change_pct, volume, market_state, extended_price, extended_change_pct | v1 |
| `ohlcv` | symbols[], interval (1m 5m 15m 1h 1d 1w), range (1d 5d 1mo 3mo 6mo 1y 2y 5y) | symbol, time, open, high, low, close, volume | v1 (`2y` v1.2) |
| `news` | symbols[], limit | time, headline, source, url, symbol | v1 |
| `earnings` | symbols[], from, to | symbol, date, session (bmo, amc, or null), eps_estimate | v1 |
| `profile` | symbols[] | symbol, name, exchange, sector, industry, market_cap, employees, beta, description | v1.2 |
| `metrics` | symbols[] | symbol, market_cap, pe, forward_pe, peg, ev_ebitda, ps, pb, gross_margin, operating_margin, profit_margin, revenue_growth, earnings_growth, roe, debt_to_equity, dividend_yield (percents scaled ×100) | v1.2 |
| `financials` | symbols[], period (annual, quarter), limit ≤5 | symbol, period_ending, revenue, gross_profit, operating_income, net_income, eps, operating_cash_flow, capex, free_cash_flow, cash, debt, shares | v1.2 |
| `estimates` | symbols[] | symbol, recommendation, analysts, target_low, target_consensus, target_high, upside_pct, eps_estimate_q, eps_estimate_y, eps_growth_y | v1.2 |
| `eps_history` | symbols[], limit | symbol, date, eps_actual, eps_estimate, surprise_pct | v1.2 |
| `dividends` | symbols[], limit | symbol, ex_date, amount | v1.2 |
| `insiders` | symbols[], limit | symbol, date, name, title, action (buy, sell, grant, other), shares, price, value, url | v1.2 |
| `institutions` | symbols[], limit | symbol, date, holder, shares, change_pct, value | v1.2 |
| `short_interest` | symbols[], limit | symbol, date, short_interest, change_pct, avg_volume, days_to_cover | v1.2 |
| `options` | symbol, expiration?, strikes (each side, default 10), type (call, put, both) | symbol, expiration, type, strike, bid, ask, last, volume, open_interest, iv, delta, gamma, theta, vega, underlying_price, dte | v1.2 |
| `volatility` | symbols[] | symbol, iv30, iv30_high, iv30_low, iv_rank, hv30, hv30_high, hv30_low, year_high, year_low | v1.2 |
| `calendar` | from, to, country (default United States) | time, country, event, actual, consensus, previous | v1.2 |
| `ipos` | from, to | symbol, date, name, exchange, price, offer_amount, status | v1.2 |
| `movers` | list (gainers, losers, active), limit, min_price (default 5) | symbol, name, price, change_pct, volume | v1.2 |
| `holdings` | symbol (an ETF) | etf, symbol, name, weight | v1.2 |
| `macro` | series[] (treasury_3m, treasury_2y, treasury_10y, treasury_30y, spread_10y_2y, fed_funds, sofr, cpi_yoy, unemployment, m2), range | series, time, value | v1.2 |
| `yield_curve` | date? | date, maturity, years, rate | v1.2 |

Long format throughout: multi-symbol results carry a `symbol` column; `macro` carries `series` instead and the preview groups by it. `search`, `calendar`, `ipos`, `movers`, `macro` and `yield_curve` have no symbols; `options` and `holdings` take exactly one. Percent columns are percent (5.63, not 0.0563); connectors scale.

### 7.2 Views

`series` (ohlcv and macro; `candle` and `normalize` only for ohlcv), `table` (any kind), `chain` (options only: calls on the left, strikes in the middle, puts on the right, the underlying price marked), `stat` (2026-10-18; the kinds whose frame has one row per symbol: quote, metrics, volatility, estimates, profile, short_interest). Nothing else.

`stat` shows one big number per symbol with the symbol as its label and a change line under it. The number is the kind's key column, `STAT_KEY_COLUMN` in core (quote `price`, metrics `pe`, volatility `iv30`, estimates `target_consensus`, profile `market_cap`, short_interest `days_to_cover`); an optional `column` on the view names another numeric column of the kind, and the schema refuses anything else. The change line is the day change for quote (plus the extended-hours price and move when `market_state` is not REGULAR), the forward P/E for metrics, the IV rank for volatility, the upside for estimates, the sector for profile and the change from the prior report for short_interest. One symbol fills the widget; several become a row of cards; short_interest takes the newest row per symbol. When a refreshed frame moves the number it is highlighted once in the direction's colour (no loop). Meant for sm widgets when the question is about that headline number; the prompt says so.

### 7.3 Connectors

| Connector | Key | Kinds | Notes |
|---|---|---|---|
| yahoo | none | search, quote, ohlcv, earnings | via yahoo-finance2, pinned and fixture-tested. Quote has pre and post-market fields. Chart takes period1/period2 and `1wk`, so the connector maps range and interval. Earnings via quoteSummary calendarEvents: next date and estimate only, session null. |
| finnhub | free | quote, news, earnings | 60 calls/min. Quote has no extended hours (fallback only). Company news is one symbol per call with day granularity, so the connector fans out and filters to the window locally. Earnings calendar includes an hour field that maps to session. |
| openbb | none (keys live on the OpenBB side) | search, quote, ohlcv, news, earnings | v1.1, section 13. A local OpenBB Platform API (`openbb-api`, 127.0.0.1:6900) answers every kind through a provider chosen per kind (defaults yfinance and nasdaq, both keyless). Listed first in the default config; a 30 s breaker makes it free when it is not running. |

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
  | { t: 'refresh'; widgetId: string; workspaceId?: string }
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

## 13. v1.1: OpenBB Platform as a connector

**Why.** OpenBB open-sourced a data layer with dozens of providers behind one REST API. Linking to it gives the terminal every provider OpenBB has (yfinance, nasdaq, cboe, sec with no key; FMP, Polygon, Intrinio, Tiingo, Benzinga with keys) through one connector, without changing the agent, the kinds, or the views.

**Decisions (user, 2026-10-17).**

- OpenBB is a **data connector**, not a Workspace backend. The other direction (serving `widgets.json` so our workspaces appear inside OpenBB's closed Workspace UI) is out of scope.
- **The user installs OpenBB** (`pip install "openbb[routers]" openbb-yfinance`, then `openbb-api`). We detect it; we never bundle, spawn, or import it. OpenBB Platform is AGPL-3.0 and stays on its side of an HTTP boundary; this repo is unchanged MIT.
- **OpenBB routes first when it is running.** It is first in the default `config.yml`; yahoo and finnhub are fallbacks. When it is not running, a 30 s circuit breaker inside the connector makes every miss immediate, so the first-run experience without OpenBB is unchanged apart from a `not running` row on the Connectors page.
- Still five kinds. OpenBB could feed fundamentals, options, economy and more; each of those is a catalog change with its own use case, not part of this.
- OpenBB's MCP server is not used as agent tools: numbers would bypass previews and frames, which product rule 2 forbids.

**What was built.**

- `packages/core`: `ConnectorDef.health?` and `Registry.health(name, { timeoutMs })` (section 7.4). `ConnectorStatus` gains `unreachable`, reported only by probes.
- `connectors/openbb`: `defineConnector` with all five kinds, config `{ baseUrl, providers: { <kind>: <provider> }, username?, password? }` (all optional, so it registers with `{}`), fixture tests recorded from the live API, `pnpm smoke`.
- `packages/server`: `BUILTIN_CONNECTORS` gains `openbb`; `describeConnectors` is async and runs the probes; the default config lists `openbb` first.
- `packages/web`: the Connectors page renders keyless connectors without a key field and shows `not running` with the connector's own instructions.
- Docs: `connectors/openbb/README.md`, `docs/notes/openbb-probe.md`, a health section in `docs/writing-a-connector.md`, a README section.

**Verification.** `pnpm test` offline; `pnpm --filter @openterminal/connector-openbb smoke` live; use cases A, B, C with the API running, every widget frame `meta.connector: openbb`; the same prompt with the API stopped answered by yahoo; Connectors page screenshots in both states.

## 14. v1.2: the catalog grows to 22 kinds

**Superseded by section 17 (v2 phase 3a, 2026-10-19).** The 22 kinds are the first 22 recipes in `packages/core/recipes.yml`; the per-kind handlers in the three connectors are gone (connectors publish descriptors and answer routes), the per-kind view wiring is shapes, annotations and presets. The provider choices and unit decisions recorded here survive as recipe route alternatives and annotation rules. Kept for history.

**Why.** The 2026-10-18 data-gaps note (`docs/notes/data-gaps-2026-10-18.md`) found that the five most-asked-for gaps (fundamentals and estimates, option chains and IV, the economic calendar and macro series, ownership and short interest, movers) are all served by keyless providers in the OpenBB install the terminal already routes through. The data was one URL away; the catalog was the limit. The user asked for all of them, with new views where a table would not do.

**Decisions.**
- Kinds stay "a param schema plus exact columns". No generic "run this OpenBB route" kind: the agent must not see numbers the views cannot render (product rule 2), and exact columns are what make previews and table formats work.
- 17 new kinds, listed in 7.1. Grouping: company (`profile`, `metrics`, `financials`, `estimates`, `eps_history`, `dividends`), ownership (`insiders`, `institutions`, `short_interest`), options (`options`, `volatility`), market-wide (`calendar`, `ipos`, `movers`, `holdings`, `macro`, `yield_curve`).
- `options` is one symbol at one expiration with a strike window, never the whole chain (MU has 11,000 contracts). `expiration` snaps forward to a listed date; omitted means the nearest expiration at least a week out, which is what a retail question usually means.
- `macro` is a curated enum of keyless series, not free-text FRED ids: FRED needs a key, and an enum keeps the agent honest about what exists. Sources: federal_reserve treasury rates, EFFR, SOFR and M2; OECD CPI and unemployment.
- One new view, `chain`, because a flat table of calls and puts is unreadable. Macro reuses `series` (lines keyed by `series` instead of `symbol`). Everything else is a table with per-kind formats.
- The agent's `query` tool takes `params` as an open object validated by `parseQuery`; a 22-member union would be fragile and the system prompt already renders every kind's params from the catalog.
- Bench findings folded in because the prompt was being edited anyway: `2y` range; "four to six widgets" is a default, not a floor; replies start with the answer; period changes are measured from the close before the period.
- Yahoo gets fallbacks only where yahoo-finance2 has the data (profile, metrics, estimates, eps history, insiders, institutions, options, dividends, holdings). finnhub is unchanged.

**Out of scope.** Screeners with arbitrary conditions, sector performance (do it with sector ETFs through `ohlcv`), technical indicators and realized vol (views over bars, a separate plan), transcripts, options flow, per-ticker IV history (section 12 of the data-gaps note), anything keyed.

**Workstreams** (after the trunk commit, in parallel, no shared files):
1. openbb: a handler per new kind, provider defaults, fixtures recorded from the live API, tests, README and probe note.
2. yahoo: fallbacks listed above, same test style as the existing handlers.
3. web: `chain` view; `series` over macro frames; table polish for the new kinds; a widget editor that works for every kind; gallery fixtures; headless screenshots.
4. agent and docs: prompt rules and examples for the new kinds, the bench fixes, `scripts/query.ts` for every kind, bench prompts, vocabulary and connector docs, README.

**Verification.** typecheck, lint, tests green; `pnpm query` for every new kind against the production OpenBB; a bench run of prompts that need the new kinds (options, fundamentals, macro, calendar, insiders) with every number traced to a preview; screenshots of the chain and macro views; production redeployed.

**Status (2026-10-18, evening): done.** All four workstreams landed and were integrated the same day: openbb answers all 22 kinds (63 tests, every kind smoked live), yahoo answers 14 as fallback (94 tests), the web has the `chain` view, `series` over macro with basis-point legends, `compact` and `change` table formats and a widget editor generated from each kind's schema (86 web tests), the agent prompt carries the new kinds, three new worked examples and the bench fixes (46 server tests). Whole repo: 354 tests, typecheck and lint clean. Integration changes: `movers` defaults to the yfinance screener presets (`day_gainers`, `day_losers`, `most_actives`) with a `min_price` param, because nasdaq's raw lists were twenty sub-dollar warrants; `debt_to_equity` is a ratio on both connectors; tax-withholding dispositions are `other`, not `sell`; `m2` cannot be mixed with percent series; previews carry an absolute `change` stat beside `changePct`. Six bench prompts over the new kinds (options into earnings, valuation, macro week, insiders, movers, ETF holdings) all built the intended workspaces with the chain and macro views as heroes; replies are recorded in `docs/notes/prompt-bench-2026-10-18.md`. Known limits: the 25-row preview cap shows in replies ("I only saw 25 of the 30 rows"); replies sometimes use bold labels despite the no-markdown rule; `volatility.hv30` is null from the keyless source; nasdaq holdings and yahoo institutions stop at ten rows. The chain's put side was clipped at lg in a two-column-wide grid and tables scrolled sideways in narrow cells; both fixed by the layout pass (section 15).

## 15. Layout pass: no empty cells, no horizontal scroll

**Why.** With the sidebar open, a 1280px screen leaves the grid 884px wide. Three fixed columns of 290px plus spans of lg 2x2, md 2x1, sm 1x1 meant every md left a hole in its row and a lone sm left one under itself, and a 290px cell could not hold a ten-column table, so DataTable fell back to `overflow: auto` on both axes. The user asked for no blank space on the right and no sideways scrolling (2026-10-18, evening).

**Decisions.**

- Column count from the grid's width, not the viewport: `columnsFor(width)` is 1 under 720px, 2 under 1100px, 3 from there. At two columns lg and md are full width and two sm share a row.
- `packLayout(widgets, columns)` in core is pure and tested: dense placement in widget order, then every empty cell is filled by stretching a neighbour (left, above, right, below). It returns explicit positions, which the web grid renders as `grid-column: start / span`. `set_workspace` runs it for three columns and tells the agent which widgets were stretched, without rejecting the set.
- Rows are explicit pixels, `rowHeightFor(rows, paneHeight)`: the visible height shared by one or two rows, 240px from three on. `minmax(240px, 1fr)` was tried first and rejected: in a scrolling grid the height is indefinite, fr rows size to content, and a chart that fills its cell grows without bound (a 7189px hero in the first screenshot).
- No horizontal scroll: DataTable is `overflow-x: hidden`, `table-layout: fixed`, with fixed widths for numeric, date and time columns so text columns share the rest. Each kind lists its columns in priority order (`TableView`); the first three always show and each later one needs the widget body about 60px wider, enforced by `@container widget` rules in `@openterminal/ui` styles.css, so a lg table in a narrow grid sheds columns the same way a sm one does. The chain measures its own width (a ResizeObserver, because its `colSpan` group headers cannot follow display:none cells) and keeps 7, 5, 4, 3 or 2 columns per side.

**Verification.** 368 tests (core packer exhaustively over every size mix at 1, 2 and 3 columns; DataTable overflow classes; chain tiers), typecheck and lint green; before and after screenshots of two production workspaces at 1280x800 with the sidebar open in `docs/screenshots/layout-*.png`, with a DOM check that no element inside a widget scrolls sideways and every grid cell is covered.

**Out of scope, noted for later.** One-row tables in a full-height cell (a stat card would fit better), human column labels with units, the chart legend over the plot, tab widths, and the sidebar width. All proposed in the same conversation; none needed for the two defects above.

## 16. Chat markdown and legend labels

**Why.** Two cosmetic defects reported from production. The reply was rendered as raw text in a `white-space: pre-wrap` div, so the markdown the model emits anyway (bold labels, bullet lists, inline code, the odd table) showed as literal `**`, `-` and backticks; the section 14 status already noted "replies sometimes use bold labels despite the no-markdown rule". And a series legend could only ever show the symbol (or the macro short name): nothing on the widget let a person or the agent call SPY "S&P 500".

**Decisions.**

- The reply is markdown. `Reply` renders it with react-markdown and remark-gfm (bold, lists, inline code, tables, strikethrough), no rehype-raw, so raw HTML is shown as text and never rendered; links open in a new tab. `[[widget:<id>]]` tokens are rewritten to links on `#widget:<id>` before the markdown pass and the link renderer turns those back into chips, so chips stay inline in sentences and lists. Styles live in `@openterminal/ui` styles.css under `.markdown`, on the tokens, compact: one unit between blocks, headings at body size, hairline table rows. The prompt rule against headings, lists and tables stays: the reply should still read as two to four sentences, and rendering is the safety net, not an invitation.
- A series view takes `labels?: Record<string, string>`: a legend label per symbol (ohlcv) or series (macro), trimmed, 1 to 32 characters, and every key must be one of the query's own symbols or series so a label never outlives its line. The legend shows the override in place of the symbol and keeps the symbol as the row's `title`; numbers are unchanged. The widget editor shows one input per line of the query (placeholder: the default label), derived from the params as typed, so adding a symbol adds an input and removing one drops its label. The field flows into `set_workspace` through `WidgetSchema`, with one line in the prompt telling the agent to use it only when the user names a line. Hiding a line is not part of this: that would be a query change, not a label.

**Verification.** 382 tests on the branch, 415 after merging the design system (schema accept/reject, legend override, editor inputs and round trip, reply with bold, list, code, chips, table, raw HTML), typecheck and lint green; before and after screenshots of the same production workspace in `docs/screenshots/chat-markdown-*.png` and `legend-*.png`.

## 17. v2: routes replace kinds (proposal)

**Taste round done 2026-10-19 (PR "v2 taste round: the critic's fifteen changes").** A design critic scored the acceptance set 5 of 10 against the Instinct reference and ranked fifteen changes (`docs/notes/taste-v2-2026-10-19.md`); all fifteen landed, with the round recorded in `docs/notes/accept-v2-2026-10-19.md` (hand-built 24 of 24, six agent prompts 12 of 12 with every figure verified). Corrections to this section, with the reason: the price pane's legend sits above the plot (a column beside it past four series in a widget 640px or wider), not inside its top-left, because with five to seven series the chips covered a third of the plot with the lines drawn behind them; last-value badges are drawn by the view as HTML, stacked when closer than 16px and covering the tick under them, because the library's badges collided (537.14/528.75); the categorical palette has seven hues (blue, orange, aqua, yellow, violet, magenta, cyan; the reference's green dropped) because the Mag 7 showed three greens; event markers are pins anchored above the bar's high, not library markers at a fixed offset; the yield curve and strike axes are categorical (one slot per tenor or strike) through `createOptionsChart`, not `createYieldCurveChart`, because the 1M to 6M end was a cliff at x = 0; counts by strike are paired bars with the underlying as a rule; best and worst marks go only on comparative columns, as a 2px bar, never a fill; a five-column table keeps two grid columns so a compare table does not shed the symbols it compares; the reply's unverified figures are underlined in place with a muted count, not listed in red; chips move to the end of their paragraph in the renderer; prompt rule 11 sets the voice (desk note, rounded figures, no provider or dashboard talk). Candles are not capped at 14px: the cap left half a month's plot empty.

**Status: phase 3a done 2026-10-19 (PR "v2 phase 3a: remove the kind code; recipes and routes serve everything").** The kind code is gone: `packages/core/src/kinds.ts` and its 22 schemas, the `LegacyQuery` branch of the query, registry and cache, the v1 `WidgetSchema`/`ViewSchema`/`parseWidget`/`STAT_KEY_COLUMN`, `defineConnector`'s `queries` form and `descriptorFromKind`, the three connectors' per-kind handlers (OpenBB's 600-line `index.ts` is the descriptor generator plus a 30-line caller; yahoo's fourteen modules and finnhub's three handlers are gone, their routes stay), the agent tools' kind acceptance and the recipe-failure kind hint, the `{ kind }` and positional forms of `pnpm query`, the web's `views/legacy.ts` kind tables, `formatsFor`, `KIND_PRIORITY`, the v1 widget editor and `frameMatches`, the `*:kind:*` annotation block. `migrateWidget` still reads the v1 JSON shape through a local `LegacyWidgetSchema` and `AnyWidgetSchema` migrates on parse, so every stored workspace loads (all 37 production widgets are v1 and migrate). Before the deletion, the nine recipes whose kind handler did work the raw route does not gained that work in their data graph, each tested end to end through the registry and the Pyodide engine over fixture rows: `search` (nasdaq listing-exchange codes to names, ten rows), `earnings` (`session` from the provider's word), `estimates` (consensus joined to the 0q/0y EPS estimates, `upside_pct`), `dividends`, `insiders` and `short_interest` (the newest `limit` rows per symbol), `insiders` (`action` and `value`), `institutions` (nasdaq's thousands to dollars), `options` (yahoo's column names), `yield_curve` (maturity labels). Sections 7.1 and 14 are marked superseded. 602 tests, typecheck and lint green; the web app builds; three production workspaces open on the branch server with every migrated widget rendering a frame (`docs/screenshots/phase3a-*.png`). Corrections from 3a, with the reason:

- The per-kind subtitle was on the "Removed" list ("route summary plus the params that matter"), but it stays, keyed by recipe name over the primary dataset's params and frame (`subtitleForRecipe`): "NVDA · 5m · today, candles" and "4 symbols · regular session" read better than a route path, and the route and transform cases do fall back to the path or the inputs. Marker kind columns lose `session`: with `session` on every earnings frame, earnings markers would have been keyed bmo/amc instead of "E".
- `migrateWidget` takes the raw JSON (it validates with the local legacy schema) and no longer keeps `query` on the migrated widget: nothing executes a kind, and the executor's v1 fallback is gone with it. A migrated candle chart gets `volume: true` in core, where the web used to add it. `MS`, `Range`, `Interval` and `isIntraday` live in `clock.ts`.
- The OpenBB connector's `providers` config is keyed by route (`equity/price/quote: fmp`), applied by `call` when a query names none and the route lists it; the per-kind defaults became the keyless preference list in `call.ts` and the recipes' `provider` fields.
- `/api/health` reports `connectors` and `recipes` (the status bar shows them), `/api/connectors` carries a route count instead of kinds, and the catalog route no longer reports a `mode`. `RegisteredConnector` is name, status, error, detail.
- The web fixtures are recipe widgets whose frames carry the field config the runner stamps (the old kind tables condensed into the fixture file), so every view test runs through the field-config pipeline; the macro fixture is one dataset per series in the live recipe shape (`time`, `year_10`, `series`), which is also how the compare preset keys its legend (by label) when each dataset has one group.
- The README's recipe table is generated (`pnpm readme:recipes`, `recipesMarkdownTable` in core) and a core test fails when it drifts. The agent `query` tool is two forms (recipe, route); `set_workspace` takes v2 widgets only.
- Still open from phase 2: the rubric runs blocked on API credit; `volatility.hv30` null from the keyless source; a by-sector P/E matrix needs a sector field.

**Status: phase 0 done 2026-10-18.** The trunk landed in `packages/core` (descriptors, the OpenAPI generator, catalog with BM25 search and liveness, v2 queries beside the v1 kind query, fields and shapes, annotations with the seed file, recipes with the 22 kinds, the widget model with layers and presets, the layout rule, the clock, the transform contract, `defineConnector` and the registry in both forms, workspace-keyed frame messages), 562 tests, nothing user-visible changed, production's kind path untouched. Phase 1 seams are in `docs/notes/v2-contracts.md`. Phases 1 to 3 are open.

**Status: phase 1 (d) done 2026-10-19.** The web views render from presets: `ChartView` draws `expandPreset`'s panes and layers on lightweight-charts 5.2 (`addPane` with stretch factors, `priceScaleId` per layer, `createSeriesMarkers` with a letter per event kind, `createPriceLine` for levels, histograms for volume and signed bars, a band primitive through `attachPrimitive`, `createYieldCurveChart` for maturities and `createOptionsChart` for other numeric axes, legend chips in each pane's top-left that follow the crosshair, last-value badges on the axis); `TableView` from `TableControl` (columns by priority, sort, highlighted row, conditional colour, best and worst marks), `FactsCard` from `FactsControl` and the one-row rule, `StatView` from `StatControl`, `HeatmapView` from a `cell` layer (wide frames melted, diverging red–neutral–blue scale with a legend), `ChainView` kept; frames keyed by `frameKey` in `state/frames.ts` with `frameMatches` as the fallback guard; `contentHintFor` and the grid packing with `{ size, contentHint }`; a gallery fixture per new preset; 586 tests. Corrections, with the reason: the pane's `scales.left` is the primary scale but the renderer draws it on the right-hand axis (`scale: 'right'` goes to the left), because every terminal and the v1 charts put prices on the right and flipping production's axis for a naming choice was not worth it; the `curve` preset keeps `lastValue: true` on a numeric axis (the long-end badge, and the checklist wants a last-value label on every chart); the heatmap's diverging pair is red–blue, not red–green, because red/green fails the dataviz CVD gate (ΔE 4.1) and the cell text carries the sign anyway; a v1 candle chart keeps its volume pane after migration (`viewOf` in the web adds `volume: true`, the look was the renderer's); the v1 kind tables moved to `views/legacy.ts` and feed field config as the annotations layer until phase 3 removes kinds; the web stamps a v1 server's `frame` messages with the active workspace id, since the server only pushes frames for the focused workspace. Found, not fixed (core, phase 2): a short table pulled up beside the hero still stretches to two rows when the no-holes rule has no chart to grow, and a two-row table cannot fill a 240px row; the one-row rule and the stat and facts demotion cover the rest.
**Phase 1 (b) done 2026-10-18: transforms, pandas in Pyodide.** `packages/server/src/transform/` holds the engine (`createTransformEngine`, one `worker_threads` worker running Pyodide 314.0.7 = CPython 3.14 with pandas 3.0.2, numpy 2.4.6, scipy 1.18.0), `runtime.py` (frame ↔ DataFrame, the import guard, the exec sandbox, tracebacks as `{ error, traceback }`) and `ot.py` (every `OT_HELPERS` name, the clock.ts calendar through 2027); `packages/server/src/agent/tools-transform.ts` is the `transform` tool body for (c) to register. The wheels pandas, numpy, scipy, tzdata and their dependencies (7 files, 22 MB) are vendored in `packages/server/pyodide/` by `packages/server/scripts/vendor-pyodide.mjs` (hashes from the lock file inside the `pyodide` npm package), so nothing is fetched at runtime. 31 tests: the P/E example verbatim with a hand-recomputed value (47.04 on 2025-12-01), every helper against a hand value, EMA and RSI parity with a reference loop, merge_asof, the forbidden import, the timeout, the kill, the memory cap, and `ot.trading_days` against `clock.tradingDays` over 2025–2026 (501 sessions). Not wired into `main.ts` yet (one line, `registry.setTransformEngine(createTransformEngine({ log }))` plus `warmup()` in the background and `close()` on shutdown): left to integration so the file that (c) and (e) also touch is edited once. Corrections from (b), with the reason: the `pyodide` npm package ships only the runtime (14 MB); the scientific stack is separate wheels, and `tzdata` has to come too because Pyodide ships no IANA database and `America/New_York` needs one, so the vendored total is 36 MB, not "about 30". Cold start measured 19 to 26 s on the dev box (Pyodide 4 to 9 s, wheels 5 s, `import pandas` 4 s plus `import scipy` 5 s), not 2 to 4 s, with warm runs at 80 ms for the P/E example; so the server must warm the worker in the background at start, and a timeout raises `KeyboardInterrupt` first (the worker stays warm) and kills only a script that swallows it, because every kill costs another cold start. Result frames drop an unnamed integer index (what filtering leaves; the P/E example filters) and turn a DatetimeIndex, a named index or a MultiIndex into leading columns. Time columns and `ot.to_et` are nanosecond resolution on both sides because pandas 3 parses strings to microseconds and `merge_asof` refuses mixed units.

**Phase 1 (c) done 2026-10-18: agent tools, prompt with recipes, reply verification, run log.** `packages/server/src/agent` has the four tools (`find_route`, `query` over recipes, routes and, until phase 3, kinds; `transform`; `set_workspace` over `WidgetV2Schema` with v1 widgets migrated through `parseAnyWidget`, content hints from the run's previews into `packLayout`, and the rule 8 refusal), the prompt rewritten around `recipeSummaryLines`, the section 17 rules, charts before tables, the baselines from `clock.ts`, the units line per preview column and the P/E transform example, reply verification in `packages/server/src/verify.ts` (every figure in the reply matched against the run's previews, unit-aware, on the `done` message as `verification`), and the run log behind `packages/server/src/runlog.ts` (`RunLog` interface, memory and JSON-lines implementations; (e)'s SQLite store implements the same interface). 595 tests. The `widgets` message, the store and the executor still carry v1 widgets, so a v2 widget set is validated and returned to the model but dropped by `app.ts` until the integration bot switches the protocol and the store to `AnyWidgetSchema` and the executor runs datasets.

**Phase 1 (c) corrections to the design above, with the reason.**

- `MessageSchema` gains an optional `verification` (`VerificationSchema`: `ok`, `checked`, `matched`, `unmatched[]`) in core; the server fills it and the run log row carries the same object. The contracts note listed this as the one-line core change the agent workstream would report.
- The `query` tool is one flat object (`recipe` | `connector` + `route` | `kind`, plus `params`) instead of a union, because the Anthropic API rejects a top-level `anyOf` in a tool schema (the v1 reason, unchanged); `set_workspace`'s `view` is a union under a property, which is fine.
- `find_route` takes `{ query, namespaces? }` and returns recipe names that match beside the routes, so a model that searches for something a recipe already covers is pointed back at the recipe.
- `set_workspace` checks more than rule 8 against the frames the run previewed: a chart preset over a frame without a time column, a curve without a numeric x, a chain over a non-chain frame and a stat without a numeric column are refused with the frame's columns in the message, because a widget that renders as a permanent error is worse than one more tool round trip. Datasets the run did not preview are not checked.
- Reply verification skips bare integers below 100 (counts and ordinals), dates, times, years, quarters and hyphenated counts ("30-day"); matches sign-insensitively because the prose carries the direction; allows a percent to match an unannotated value below 1 times 100 (a raw fraction nobody annotated) and reports the match as scaled; and counts the per-group preview stats (first, last, min, max, change, changePct) as preview numbers, since that is where range changes come from.
- The run log row carries `prompt` and, for failed or cancelled runs, `error` beside the listed fields; `cost` is filled only when the server is given a price per million tokens (none is configured; the model ids' prices are not in the repo).
- The server registry loads the built-in recipes and annotations in `buildRegistry` (`packages/server/src/connectors.ts`), because the recipe list in the prompt and `{ recipe }` queries need them; (e) layers user recipes through `setRecipes`.
- The `transform` tool is (b)'s `runTransformTool` from `tools-transform.ts` (its input schema, description, summaries and traceback path), wrapped so a successful result is recorded in the run's preview memory: reply verification and the set_workspace checks must see transform previews like any query's, and (b)'s body returns the preview, fields and lineage rather than the frame, so `PreviewMemory.rememberResult` keeps those. `main.ts` starts the Pyodide engine after listen (`createTransformEngine`, `setTransformEngine`, `warmup`) and closes it on shutdown; a server started with an injected registry (tests) gets no engine.
- Two runner backstops from the live check (2026-10-18, the three prompts against a branch server). When the ten-call budget was spent, the model's final turn without tools carried nothing (reasoning only) and the user got an empty reply: the runner now asks once more without tools, and the run row records every model turn (`turns`: finish reason, text chars, tool calls, output and reasoning tokens) and `continued`. The model also wrote short notes before tool calls ("Use the kind form.") that streamed into the reply despite rule 9: text at the start of a turn is held for 120 characters, and a held note from a turn that ends in tool calls is dropped, so prompt rule 9 is enforced by the server the way rule 4 is by verification.
- Until (a) lands, every recipe except `quote` fails on this branch because no connector serves `equity/price/historical`, `news/company`, `chart`, `quoteSummary` and the rest; the live check showed the agent recovering through `find_route` to the kind routes (`yahoo ohlcv`, `finnhub news`) at the cost of two calls, so a recipe that fails this way now tells the model the kind of the same name still answers. The hint goes with phase 3.

**Phase 1 (e) done 2026-10-19** (shell and store): the `Store` interface with SQLite on `node:sqlite` (`~/.terminal/terminal.db`: workspaces with widgets as `AnyWidget`, user recipes, catalog cache per connector, liveness rows, run log rows, frame cache rows with expiry, settings) and the one-time migration from the JSON directory (v1 widgets through `migrateWidget`, the directory renamed to `workspaces.json-backup`); the persistent frame cache (`SqliteCache`, keyed by `canonicalKey`, TTL on read, row and byte caps); the data routes (`/api/catalog`, `/api/catalog/:connector`, `/api/catalog/probe` answering 501 until (a)'s probe is wired, `/api/recipes` GET and PUT mirrored to `~/.terminal/recipes.yml`, workspace export and import, `POST /api/query`, `/api/settings`, `/api/runs`); the Data page in place of the Connectors page (catalog browser with search, liveness and probe, keys, per-route provider override, recipe library with promote and edit, the store's state); the three-tab editor (data graph with a preview per dataset and datasets added as route, recipe, transform or v1 kind; transform on CodeMirror 6 with the traceback inline; view with the preset and options generated from `ViewV2Schema` and the expanded control read-only); `VirtualTable` (the DataTable API with row windowing); export and import in the workspace tab menu; the ticker strip under the tabs (six `{ recipe: 'quote' }` datasets on their own TTL, editable, saved server-side) and the market strip from `describeMarketTime`; `pnpm query <connector> <route> key=value…` and `pnpm query <recipe> …` beside the kind forms.

**Phase 1 (e) corrections, with the reason.**

- `WorkspaceSchema.widgets` is `AnyWidgetSchema` (the one-line core change the contracts reserved): the store holds v1 and v2 widgets side by side during the coexistence, and the HTTP body schema, the executor and the web shell take `AnyWidget`.
- A migrated widget keeps its v1 `query` (as `migrateWidget` already did), and the executor falls back to it for `main` when one of the widget's recipe datasets fails. The design said "recipes carry the exact routes the kinds used, so every existing workspace renders unchanged", which is true once (a)'s routes exist; until they are merged, `ohlcv` through the recipe names `openbb equity/price/historical` and `yahoo chart`, neither of which the v1 connectors serve, and without the fallback every migrated chart would have shown an error. The fallback disappears with the kinds in phase 3.
- The editor opens a v1 widget with its `{ kind, params }` query as the `main` dataset rather than through `migrateWidget`: a user who edits the params would otherwise have been moved onto a recipe path that (a) has not landed, and a kind query is a valid dataset until phase 3. The save is a v2 widget that executes on the v1 path and renders through the v1 views (`asV1Widget`); widgets whose main data is a route, recipe or transform render as a table of their primary dataset until (d)'s preset renderers land.
- The ticker strip stores its symbols in the server's settings (`PUT /api/settings/ticker`), not the browser, so every client shows the same strip; the strip's own TTL floor is 15 s so six quotes do not poll at the 10 s quote TTL.
- Transform inputs in the widget model are inline queries (`inputs: Record<name, AnyQuery>`), not references, so the editor's graph edges are derived: an input named after a dataset of the widget follows that dataset's query (`syncTransformInputs`), and the data tab draws the arrow from that name.
- The Data page replaced the Connectors dialog with a full pane (`#data`; `#connectors` still opens it) because a catalog of a thousand routes and the recipe library do not fit a 520 px dialog.
- The web adds CodeMirror 6 (`codemirror`, `@codemirror/lang-python`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`) for the transform tab; the Pyodide dependency stays with (b).

**Phase 1 (a) done 2026-10-19** (connectors, descriptors, probe and liveness): `openbb.descriptors()` from the live `/openapi.json` (834 descriptors from OpenBB 5.0.0's 1,012 GET routes; the other 178 are not results envelopes), cached in `~/.terminal/catalog/openbb.json` and served from the cache when the API is down; `openbb.call` through `inferFrame` with a keyless default provider and the symbol fill-in; yahoo (5 routes) and finnhub (3 routes) descriptor files and `call`; the liveness rows written through (e)'s store (`Store.getLiveness/setLiveness`, with memory and JSON-file stores behind the same `LivenessStore` interface for the script and tests) and applied to the catalog at startup; the probe (`pnpm probe`, concurrency 8, keyless-provider retry, a pause while a connector is down, a quiet retry of timeouts, `--ci` against the fixture) wired into `startServer` so `POST /api/catalog/probe` and the Data page's button run it in-process. The live probe's numbers are in `docs/notes/openbb-probe.md` part 3. Corrections from (a), with the reason:

- `descriptors()` takes the connector's ctx (`descriptors(ctx?)`), passed by the registry: OpenBB's generator has to reach `${baseUrl}/openapi.json` with the configured http client and auth, and a connector-level function with no arguments could not.
- A connector's own route wins over a kind handler of the same name (`Connector.ownRoutes()`, used by `call` and by the registry's kind-validation rule): yahoo's and finnhub's v2 `quote` routes collide with the `quote` kind, and the recipes address them with the descriptor's params (`symbol`, not `symbols`) and columns (`regularMarketPrice`, not `price`). The v1 `{ kind }` path is unchanged.
- The generator narrows a param to providers only from OpenBB's `(provider: x)` markers: provider-keyed schema extras and the "multiple comma separated items allowed for provider(s)" note describe list-taking and widget config, not applicability, and had narrowed `symbol` on dividends to nasdaq, which would have dropped it from a yfinance call.
- `call` chooses a provider when the query names none (keyless ones first: yfinance, nasdaq, cboe, sec, finra, federal_reserve, …, else the route's first), because OpenBB 5 answers 422 "Field required" to a call without one when no default is configured on its side; the first live probe lost 21 routes to that.
- The OpenBB catalog cache is keyed by `info.version` plus a fingerprint of the document's GET paths and schema names, because OpenBB 5 reports `info.version: "1"` for every release and installing a provider extension must regenerate.
- The descriptor file is 2.4 MB, not the 300 KB estimated: OpenBB's field descriptions are long and there are 12,755 of them. It is read once per process; the registry memoises the result.
- OpenBB v2 frames drop union columns no row fills (`inferFrame` with `dropEmpty`): a route's fields are the union over its providers' models, and a yfinance quote would otherwise be 90 columns of null. An empty result keeps the descriptor's columns.
- yahoo `chart` with `events` returns the events as the rows (one per dividend or split, `date` plus `dividends.amount`), not bars with an events column: the dividends recipe needs a frame of dividends.
- The probe never records a `down` result and pauses until the connector's health probe passes, and retries timeouts two at a time once the main pass is over: OpenBB serves blocking provider calls on one event loop, so eight concurrent calls stall it for tens of seconds (and on the 8 GB box of the first run the process was OOM-killed), and a naive probe marked 677 live routes dead. `--concurrency=4` is the setting that finished cleanly here.

**Status: phase 2b (2026-10-19, PR "v2 phase 2b"): the agent half ran twice while the key had credit; two of the three required prompts pass the rubric, the third fails N only on two headline-quoted figures with the rule fix landed but unrun; the `v2` and `v1` groups did not run (the key ran dry after the twelve acceptance prompts each round). Phase 2 is therefore blocked on API credit for: the CRWV rerun, the six remaining `v2` rubric prompts and the fifteen `v1` regression prompts.** Agent round 1 (0 of 24 pairs; the conversation panel's step list truncating was 100 of 112 findings) and round 2 (12 of 12 at 1440 on every rendering column, three 1920 fills fixed after) are in `docs/notes/accept-v2-2026-10-19.md` with the rubric table. Corrections from 2b, with the reason: the server flattens the stored reply to plain prose (`plain.ts`), because rule 8 failed in three of twelve runs again; the verifier masks index, basket and indicator names ("S&P 500", "SMA 200"), tries a suffixed figure as written against a preview already in that unit ("$51.61B" against a pivot in billions) and reads string cells that are one numeric token (the nasdaq calendar's "2.6%", "199K"), because those were the only misses in nine of twelve verified replies; rule 1 forbids arithmetic on preview figures and headline figures; the prompt gains a comparison recipe (metrics, financials per symbol, estimates, pivoted to metrics-as-rows), the "S&P last week" recipe (band, calendar markers, sectors, movers) and screens through the screener's `sector`/`mktcap_min` filters, because the first agent round hand-picked universes, skipped financials and skipped the calendar; `ohlcv` and `index` take `start` through a `prefer:` template filter ("since 2020" cost three rejected ranges); `news` keeps the newest `limit` rows on every route (finnhub returned 248); `volatility` adds `iv_rank`; an unannotated number formats with two decimals (a transform's `rsi` printed 17 digits); a table shorter than its cell shares the height between its rows.

**Status: phase 2 done 2026-10-19** (PR "v2 phase 2c: rubric complete, v1 regression, cache numbers"). With prompt caching in place the loop finished: the CRWV prompt verifies every figure (the headline rule held), the six remaining `v2` prompts pass every rubric column with every figure verified and the checklist green at both viewports (7 of 7 with CRWV), and the fifteen `v1` prompts show no regression against the 2026-10-18 note with three of its fails fixed (the leaked planning line, the four-widget floor on "drop the quotes", the 2y range) and Pure Storage resolved; one `v1` reply wrote an approximate "less than 20%" that no frame holds and its rerun verified 16 of 16. The three user prompts, the twelve acceptance prompts (round 2b for nine, 2c for CRWV), the `v2` group and the `v1` group are green; the per-prompt rubric, checklist and cache tables are in `docs/notes/accept-v2-2026-10-19.md`. Cache: 70 to 78% of each run's input tokens are cache reads after the first turn (2.15M input over the seven `v2` runs with 1.54M read; 2.58M over the fifteen `v1` runs with 1.80M read); the first turn and each turn's new tool results are the writes. Corrections from 2c, with the reason: the transform allow-list gains `time`, `re`, `json`, `collections`, `itertools` and `functools`, because the model imported `time` in five of twenty-two runs and lost a tool call to the refusal each time and none of them reaches the filesystem or the network; a numeric column whose values reach a million reads compact whatever its declared format, because a transform's dollar lines printed as fourteen-digit cells; `DataTable` sheds its lowest-priority columns until the fixed widths fit the measured container (the container-query thresholds stay as the approximation), because a `table-layout: fixed` table whose widths exceeded the cell shrank every column and cut a six-letter header; a compact quote card's value is 3.8cqw and 24px at most, because "1,299.30" outgrew its card; every facts card's rows share the cell's height, because an eight-fact card sat centred at half of a tall 1920 cell. Left for phase 3 beyond the kinds: a sector field on screener rows, the IV term structure across expirations, a row and column cap on previews (the screener run cost 889k input tokens because its preview was 176 rows wide), ET formatting of `time` cells in the browser, a probe run against the build.

**Correction after phase 2b (PR "Agent: prompt caching and a smaller system prompt", 2026-10-19), with the reason.** The runner marks the system prompt with an Anthropic cache breakpoint (`providerOptions.anthropic.cacheControl: ephemeral` on a `SystemModelMessage`, which the provider also applies ahead of the tool definitions in its prefix order) and, through `prepareStep`'s `messages` override, moves a second breakpoint to the last message of every step, so each turn re-reads the previous turns' tool results from the cache instead of re-sending them; cache reads and writes already land in the run log row's `tokens`. Reason: the two agent rounds cost about 1.1M input tokens per twelve prompts with nothing cached (60k to 160k per run, five to ten turns each re-sending the whole prefix) and ran the key dry twice. The system prompt lost two of its seven worked examples (event diagnosis and valuation, whose lessons are the "why is X down" and comparison rules now): 27.6k to 25.1k characters in the fixture (about 6.9k to 6.3k tokens; the live prompt with the 24 recipe lines is about 3k characters more). The remaining input is the previews themselves (25 rows of every column, 41 on a yahoo quote), the next lever if cost still binds.

**Status: phase 2 rendering half done 2026-10-19; the rubric was blocked on API credits that day.** The merged tree ran as one for the first time (PRs #8 to #13 had been verified apart) and the seams were closed: the `widgets` server message carried v1 `WidgetSchema` so `app.ts` dropped every v2 widget set the agent emitted (now `AnyWidgetSchema`); `pnpm query` imported a helper the (c) rewrite had removed; the FINRA bond annotations, the dividends recipe on its yahoo route, `GET /api/widgets/:id/frame?workspace=`, the probe's FINRA samples and concurrency 4, the transform warm-up test, the bench's v2 crash. Then the first live smoke found four data defects the kinds had hidden: v2 `ohlcv` frames carried `date` where every kind, helper and the prompt's own P/E example read `time`; `macro`, `options` and `earnings` returned whole frames (every maturity, 4,842 contracts, 4,213 reports) because the v1 handlers' selection had been left "until a transform does"; OpenBB's quote has no day change; and the SQLite cache served pre-change recipe frames after a `recipes.yml` edit. The acceptance loop ran six rounds over the twelve cases at both viewports (`scripts/accept.mjs`, `docs/notes/accept-v2-2026-10-19.md`): 3, 14, 19, 23, 24, then 24 of 24 case-and-viewport pairs pass the section 17 checklist under a checker tightened after the human pass; the final screenshots are `docs/screenshots/accept-<case>-<viewport>.png`. The bench rubric could not be graded: the Anthropic API answered `Your credit balance is too low` for every prompt from the first run to the last (the only LLM credential on the machine), so the workspaces were hand-built from the case descriptions (`scripts/accept-cases.mjs`, the recipes, routes and transforms the prompt tells the agent to use) and the three reply columns of the checklist read n/a. When the account has credit: `BASE=… node scripts/prompt-bench.mjs --group v2-accept --out <dir>` then `node scripts/accept.mjs --runs <dir>` grades the agent's own workspaces with the same checklist, and the v1 and v2 groups give the regression and rubric runs. 787 tests.

**Phase 2 corrections to the design above, with the reason.**

- A recipe route may carry `rename` (`{ date: time }`), applied by the registry to the frame and its field config on whichever alternative answered: the providers send `date`, the kinds (and `ot.prev_close`, `ot.baseline`, `ot.corr`, the subtitles, the worked example) read `time`, and the frame convention has to hold on every route or the agent's first transform fails.
- A recipe's transforms receive the recipe's validated params as a reserved one-row `params` input (`params.at[0, "series"]`), and `options`, `earnings` and `macro` are data graphs whose `main` picks the expiration, side and strike window, the requested symbols, or the series (and computes the 10y-2y spread) in pandas. "The connector keeps one expiration" and "the caller filters by symbols" in the recipe notes were the kind handlers' logic with no v2 home; code templating in `code` was rejected because Python braces collide with it.
- The `quote` recipe asks yahoo first: OpenBB's yfinance quote carries no change, change percent or market state (v1 computed the change from `prev_close`), so a "today's move" stat had no change line and the agent would have had to compute the day move, an unverified figure. The stat preset picks its change column from the annotations (percent, format `change`), only under a price-like headline (under IV30 or a P/E the stock's day move misleads), so it works on every quote route; the recipe's `view` no longer names `last_price`.
- Recipe frames carry `lineage.recipeVersion` (a hash of the definition) and the registry treats a cached frame from an older definition as a miss; an empty frame is not cached, and a route that answers no rows yields to the next alternative. The persistent cache outlives restarts and `recipes.yml` edits, and yfinance's consensus answered `[]` once for TSLA and would have stood for an hour.
- Layout: a tall non-hero `md` chart is one column wide in a three-column grid of three or more widgets (two 2x2 charts cannot share a band with the hero, so every md chart took a full-width band and a six-widget workspace ran five bands deep; the Instinct reference tiles six charts three across); a one-row widget is not pulled up into a slot whose neighbouring cell only it could fill by growing taller; a hole goes to a chart, chain or long table before a short table, stat or facts card; and when a span set still cannot tile, the packer tries each tall chart at its size's own span and keeps the layout that stretches no short widget taller, then the fewest rows. The (d) finding ("a short table beside the hero still stretches to two rows") is closed by these four rules.
- Views: two or three table rows render as one card per row (28px rows cannot fill a 240px cell); a single-symbol stat shows up to six companions (a time series its start, high, low and change; a quote its range, volume and cap) and reads the newest row of a time series, not the first; `DataTable` date and time columns are 104px and prose cells, header labels, facts labels and sub-headers wrap to two lines at word boundaries rather than truncating mid-word (the bench v2 "2026-10…" defect); a fixed column is at least as wide as its header's longest word; the chain reads the v2 column names; chart marker kinds come from the dataset's recipe when the frame has no kind column (news → N) and same-bar markers of one kind merge with a count; the heatmap shares the cell's height between its rows; the conversation panel shows the reply verification under each agent message (the section 17 "flags unmatched figures in the reply UI" that phase 1 left out).
- The twelve cases as hand-built workspaces live in `scripts/accept-cases.mjs` and are also what the agent is expected to produce; two of them note data limits: "since 2020" for the SPY backtest is the `ohlcv` range enum's `5y` (2021-10 on), and "a heatmap of P/E by sector" in the screener case is a heatmap of the twenty cheapest names by trailing P/E, forward P/E and P/B, because yfinance's screener rows carry no `sector` column (the route takes `sector` as a filter only); a by-sector matrix needs `equity/profile` per name or a sector field on the screener, phase 3.

**Phase 0 corrections to the design above, with the reason.**

- A recipe may hold a data graph (`data: { income: { routes }, cash: …, main: { inputs, code } }`), not only an ordered route list; `routes` is the shorthand for `data.main`. The `financials` kind joined three statements and no single route answers it; a recipe that is "a saved widget" (the widget model section) has to carry what the widget carries. A route may also carry a `when` filter on the recipe params, because `macro` picks its route by series.
- The `macro` recipe takes one series per query; a v1 multi-series macro widget migrates to one `macro` dataset per series and the `compare` preset draws one line per time-series dataset. Several series were several OpenBB routes merged in the handler, which is a graph, not a route.
- `search` takes one query string (OpenBB's `equity/search` is one query per call); the agent batches by calling it in parallel.
- Transform `inputs` accept the v1 `{ kind, params }` query too until phase 3, so a transform can be built over a widget's existing dataset during the coexistence.
- Field roles gain `x` (a numeric axis field: maturity, strike) and units gain `count`, `days`, `years`, `bps` beside the five listed, because the yield curve, the chain and the short-interest fields needed them to format correctly.
- The non-chart presets (table, stat, facts, chain) expand to no panes; `controlFor(view, datasets)` gives their spec (columns, formats, labels, sort, key column). The renderer for a table is not panes and layers, and pretending otherwise would have put a table inside the layer model.
- Frame messages carry `workspaceId` and `dataset` as optional fields with the default applied by `frameKey`, not as a Zod default, so v1 emitters still typecheck during coexistence.
- yahoo's descriptor file is the five yahoo-finance2 endpoints (`search`, `quote`, `chart`, `options`, `quoteSummary` with `modules`), not about 15 entries; "one entry per endpoint they wrap" taken literally, and `inferFrame` flattens the quoteSummary modules to `module.field` columns that the annotations name.
- The OpenAPI generator skips routes whose 200 response is not a results envelope (`coverage/*`, HTML browsers), drops the `chart` param, and takes a per-provider `choices` list as an enum only when every provider constrains the value (the CPI `country` stays free text because imf takes any code).
- Two recipes beyond the 22 (`index`, `screener`) ship in `recipes.yml` because features 6 and 7 name them and they are two routes with no code.
- The default grid threshold moved to 960 px and the size-by-content rule lives in `effectiveSpan`, which `packLayout` calls; a widget without a `contentHint` packs exactly as before, so the web is unchanged until phase 1 (d) supplies hints.

### Why

Bench v2 (section 0, `docs/notes/prompt-bench-v2-2026-10-18.md`) failed six of seven prompts, and five of the six were data the OpenBB API on this machine already serves with no kind in front of it: corporate bond yields, a screener, sector performance, the full economic calendar, earnings reactions. The catalog model means every new question costs a day of kind-writing before the agent can even try, and the long tail never ends. OpenBB describes itself completely (1,012 GET routes, 5,031 parameters, 1,102 response models with 12,755 fields, 99% of them with a description, all in `/openapi.json`), so the description work is already done by the provider. What the product adds should be discovery, typing, and guarantees, not a second copy of the schema.

The user's decision: remove kinds and work directly on provider APIs, with infrastructure designed to grow. The two things kinds guaranteed, correct units and views that know their columns, are kept by two smaller mechanisms, annotations and shapes, described below.

### Vocabulary changes (section 3)

| Term | v2 definition |
|---|---|
| **Route** | One endpoint of a provider API, described by a **descriptor**: path, parameters (name, type, enum, default, description), providers, response fields (name, type, description), and a liveness record. Replaces **kind** as the unit of data. |
| **Connector** | A plugin that exposes routes and answers them. It publishes its descriptors (OpenBB: generated from its OpenAPI document at startup; yahoo and finnhub: a hand-written descriptor file in the same format, one entry per endpoint they wrap). Holds its config. Runs server-side. |
| **Query** | `{ connector, route, params }`. Params are validated against the descriptor, not a Zod schema per kind. |
| **Catalog** | The searchable union of every connector's descriptors, with liveness. Generated, never edited. What `find_route` searches and the Connectors page lists. |
| **Frame** | Unchanged: typed columns plus rows. Columns come from the descriptor's response fields, with runtime inference as the fallback. |
| **Shape** | What a frame has, detected from its columns: a time column, numeric columns, a group column (symbol, series, ticker), option columns (strike, expiration, option_type), one row per group. Views declare the shape they need. Replaces per-kind view wiring. |
| **Annotation** | A hand-written fact about one field of one route: unit (`fraction`, `percent`, `ratio`, `usd`, `shares`), display label, format, priority for narrow widgets. Lives in a data file, grown by the bench. The residue of kinds. |
| **Recipe** | A named, saved query with a title template, preferred view and size, and an ordered list of alternative routes (fallback). Data, not code. The 22 kinds become 22 recipes. The prompt lists the top recipes as examples; the agent may use any route. |

Widget, Workspace, View, Agent, preview, reply, chip and step are unchanged. Registry becomes the catalog plus a runner.

### The descriptor format

One JSON document per connector, `Descriptor[]`:

```ts
type Descriptor = {
  connector: string            // 'openbb' | 'yahoo' | 'finnhub' | ...
  route: string                // 'equity/price/historical', 'fixedincome/corporate/bond_prices', 'quote'
  summary: string              // one line from the schema
  description?: string
  params: Array<{ name: string; type: 'string'|'number'|'integer'|'boolean'|'date'|'string[]'; enum?: string[]; default?: unknown; required: boolean; description?: string; providers?: string[] }>
  providers: string[]          // [] for connectors without the concept
  fields: Array<{ name: string; type: 'number'|'string'|'time'|'boolean'; description?: string }>
  liveness?: { checkedAt: number; ok: boolean; rows?: number; ms?: number; error?: string; sampleColumns?: string[] }
}
```

`connectors/openbb/src/descriptors.ts` generates it from `/openapi.json`: one entry per GET route, parameter unions collapsed to one entry with a `providers` list, response model resolved to fields, `date`/`datetime` fields typed `time`. The 8.5 MB document becomes about 300 KB, cached in `~/.terminal/catalog/openbb.json` with the OpenBB version, regenerated when the version changes. yahoo and finnhub ship `descriptors.json` in the package (about 15 and 3 entries), so the same code path serves all three.

A new connector is therefore either: an OpenAPI URL plus auth plus an envelope rule (a generic `openapi` connector that OpenBB is the first instance of; any REST API with a schema becomes a connector by config), or a code connector that ships a descriptor file. `defineConnector` keeps its name and config schema and gains `descriptors()` and `call(route, params, ctx)` in place of per-kind `queries`.

### Catalog, search, liveness

- `packages/core/src/catalog.ts`: load every connector's descriptors, index them for keyword search (route path, summary, description, field names; BM25 over tokens, no embeddings, no network), `find(query, { limit })` returning compact entries (route, summary, required params, top fields). Ranked with a bias toward equity, options, fixed income, news, economy and index namespaces over commodity and agriculture series.
- Liveness: `scripts/probe-catalog.ts` calls every route once with default params and a sample symbol, records the liveness block. Runs on demand from the Connectors page ("Probe routes", a few minutes for 1,000 routes, concurrency 8) and in CI against a recorded OpenBB fixture. The agent only sees routes whose liveness is ok or unknown; dead routes are listed on the Connectors page with their error.
- The Connectors page shows the catalog per connector: route count, alive count, last probe, and a searchable table. This is the human view of the same index.

### Frames, shapes, annotations

- Column inference: descriptor fields first; if the response has fields the descriptor lacks, add them with the type inferred from the first non-null value; `time` when the field is typed date/datetime or every value parses as a date. Nested objects are flattened one level with dotted names; arrays of scalars are joined.
- Shape detection (`packages/core/src/shape.ts`): pure function of columns and row sample. `time`: first `time` column. `group`: first of `symbol`, `series`, `ticker`, `cusip`, `name` when the frame has several distinct values. `numeric`: all number columns. `options`: has strike + expiration + option_type (or type). `oneRowPerGroup`: group column with no duplicates.
- Views declare requirements: `series` needs time and at least one numeric; `chain` needs options; `stat` needs oneRowPerGroup and a numeric; `table` needs nothing. `view-for` picks by shape; the editor offers only views whose requirements the frame meets. Candle needs open, high, low, close by name; normalize needs a group.
- Annotations (`packages/core/annotations.yml`, loaded at startup, about 100 lines to start): `openbb.equity/price/quote.change_percent: { unit: fraction, label: "Chg %" }`, `openbb.*.market_cap: { unit: usd, format: compact }`, `*.volume: { format: integer, priority: 3 }`. Matching by connector, route glob, and field. The runner converts units to the product's conventions (fractions become percent) and stamps the column with its unit, so previews and views are consistent. A field without an annotation is shown as-is with its description available in the tooltip and the preview, and the prompt tells the agent that unannotated numbers carry no unit guarantee.

### Transforms: deriving frames from frames

The user wants the agent to manipulate, merge and modify what it fetched, with "P/E over time" as the example: daily closes joined to trailing-twelve-month EPS, which no provider route returns. A **transform** is a Python script over one or more frames that returns one DataFrame. It is the fourth kind of thing a widget can hold, and the result goes through the same inference, annotations, preview and view path as a route's frame, so product rule 4 is untouched: every number in a reply still comes from a preview.

**Why pandas, and why in WebAssembly.** The prompts that need derivation split in two. Joins, windows and aggregates (P/E over time, rebasing, spreads, drawdown, rolling volatility, earnings reactions, put/call ratios) are fine in SQL. The other quarter is not: every technical indicator is recursive (EMA, RSI, MACD), implied volatility and yield to maturity need a solver, pairs trades need cointegration, expected moves need distributions, backtests need state, and a correlation matrix is one line of pandas and a self-join mess in SQL. Those are the prompts that make the product feel like a real tool, so the engine must cover them, and that means Python. Running the agent's Python as a native process on the user's machine is not acceptable for a local-first product (arbitrary code with the user's privileges, sandboxing that differs per OS, a Python install to manage). Pyodide runs CPython, pandas, numpy and scipy in WebAssembly inside the Node process: no filesystem or network unless handed in, nothing to install, about 30 MB vendored in the npm package, 2 to 4 s of warm-up once per server start, then tens of milliseconds per run on widget-sized data. One engine; DuckDB was considered and dropped to keep one prompt rule, one lineage format and one worker to maintain. It can return behind the same contract if the refresh loop ever needs it.

- **Contract:** `{ inputs: Record<name, Query>, code: string, columns?: Record<name, Annotation> }`. Each input is bound as a DataFrame of that name (time columns as tz-aware datetimes, ET); the script must assign `result`, a DataFrame. The `columns` block lets the agent declare the unit and label of columns it created (`pe: { unit: ratio, label: "P/E (TTM)" }`); columns that keep an input's name keep its annotation. A widget's query may be a route, a recipe, or a transform.
- **Agent tool:** `transform(inputs, code, columns?)`. Inputs are queries the agent already ran (cache hits) or new ones (run first, in parallel). The tool returns the preview of the result, or the Python traceback on failure so the agent can fix it in the next step. The prompt gets one rule and one worked example:

  ```python
  # P/E over time: close / trailing-twelve-month EPS as of each trading day
  e = eps.sort_values("date")
  e["eps_ttm"] = e.groupby("symbol")["eps_actual"].transform(lambda s: s.rolling(4).sum())
  e = e.dropna(subset=["eps_ttm"]).rename(columns={"date": "time"})
  p = price.sort_values("time")
  m = pd.merge_asof(p, e[["symbol", "time", "eps_ttm"]], on="time", by="symbol")
  m = m[m.eps_ttm > 0]
  m["pe"] = m.close / m.eps_ttm
  result = m[["symbol", "time", "close", "eps_ttm", "pe"]]
  ```

  with inputs `price = ohlcv NVDA 1d 2y` and `eps = eps_history NVDA limit 12`. The result has a time column and a numeric `pe`, so the series view renders it as a line, and the stat view shows the latest value.
- **Widgets refresh their derivations.** A transform widget re-runs its inputs on their TTLs (cache hits when nothing changed) and the script after, so a derived chart stays live. The editor shows the inputs and the code and lets the user edit both; the subtitle reads "derived from 2 queries".
- **Lineage in previews.** The preview of a transform carries the code and the input queries, so a reply can say "P/E (TTM) is 42.1, derived from closes and reported EPS" and the chip opens a widget that shows exactly that derivation.
- **Guardrails.** One warm Pyodide worker per server, restarted on any breach; imports limited to pandas, numpy, scipy, math, datetime and a small `ot` helper module (trading calendar, rebase, returns); 10 s CPU and 512 MB per run; input rows capped at 250k and output at 50k; no `fetch`, no filesystem mounted. The bench grades derivations by recomputing one value by hand, as it did for trailing P/E in v2.
- **Helpers (`ot` module):** `ot.trading_days(start, end)`, `ot.last_week()`, `ot.prev_close(df)`, `ot.rebase(df, by="symbol")`, `ot.returns(df)`, `ot.ema/rsi/macd/bollinger`, `ot.bs_iv(price, S, K, t, r, kind)`. Thin, tested, documented in the prompt; the agent may ignore them and write pandas directly.
- **Scope:** joins, windows, aggregation, resampling, rebasing, spreads, ratios, filters, indicators, solvers, statistics, simple backtests. Not in v2: user-defined packages, plotting from Python (views render), network from Python.

Transforms are workstream (f) in phase 1 and get their own bench prompts in phase 2: P/E over time, 10y minus 2y from two macro series, an equal-weighted basket index, net debt from the balance sheet, RSI and MACD on a daily chart, implied volatility from a quoted option price, a 20-name correlation matrix, and an SMA-crossover backtest with the equity curve.

### The widget model: datasets, fields, layers, presets

The features below must be configurations of one model, not ten features. The model borrows from the three designs that have aged best: Grafana (data source, then transformations, then a panel with field config and overrides, with annotations as separate queries drawn over time series), Vega-Lite (a chart is layers of marks bound to fields), and lightweight-charts 5 itself (panes, several price scales, series markers, price lines, primitives for custom drawing, yield-curve and options charts with a numeric x-axis). Four parts:

1. **Datasets.** A widget holds a named data graph, not one query: `data: { price: Route|Recipe, eps: Route|Recipe, pe: Transform(price, eps), events: Recipe }`. Every node is a frame with lineage. Markers, overlays, a second pane's series and a comparison's second table are datasets of the same widget, fetched and cached by the same runner, refreshed on their own TTLs. A plain widget is a graph with one node.
2. **Fields.** Every column carries a field config: role (`time`, `group`, `measure`, `label`, `level`, `x`), unit, label, format, colour, priority, key. It comes from three layers, later ones overriding: shape detection (roles), annotations by route and field (units, labels), and per-widget overrides (`fields: { pe: { label: "P/E (TTM)", unit: ratio } }`). Table control, stat key column, marker labels, heatmap value, subtitle, column priority and the preview's unit stamps all read field config; nothing reads a kind.
3. **Layers.** A chart is panes, a pane is layers, a layer is one mark bound to one dataset's fields: `{ mark: line|area|candle|bar|histogram|marker|level|band|cell, data: 'price', x: 'time', y: 'close', group: 'symbol', scale: left|right }`. Panes stack with relative heights; the x-axis is `time` or `number`. Markers are a `marker` layer over an `events` dataset (time, label, kind). Horizontal levels are a `level` layer with a constant or a dataset (strikes, 52-week high, target). Shaded ranges are a `band` layer. Volume is a `histogram` layer in a second pane. RSI is a line in its own pane with fixed levels at 30 and 70. A yield curve is a `line` layer with `x: maturity_years` on a number axis. A heatmap is a `cell` layer with x, y and a value field. The renderer knows marks and panes only; it never knows what the data means.
4. **Presets.** The agent and the editor do not write layer specs. They name a preset with options: `view: { preset: 'price', candle: true, volume: true, events: 'earnings' }`, `{ preset: 'compare', normalize: true }`, `{ preset: 'curve' }`, `{ preset: 'indicator', rsi: 14 }`, `{ preset: 'table', columns: [...], sort: ... }`, `{ preset: 'stat', column: 'pe' }`, `{ preset: 'heatmap' }`. A preset is a pure function from (options, field config of the datasets) to panes and layers, defined in data where possible and in a small TypeScript module otherwise, with tests. Presets bind by role, so `compare` works on any dataset with time, group and a measure, whether it came from a route or a transform. Users and advanced agents may write layers directly; the editor shows the expanded spec.

Each feature on the list, through the model: markers are a dataset plus a layer; panes and axes are the pane list and `scale`; numeric x is the axis type; table control is field config plus the `table` preset's options; the compare pivot is a transform plus `table`; the heatmap is one mark; steerable previews are a preview spec on the query (rows, sort, slice, columns) with time bounds and event rows always included; time semantics are one `clock` module used by the runner, the `ot` helpers, previews and the prompt; index, sector and screener are recipes; a recipe is a saved widget (data graph, preset, title template, param schema, fallbacks), so promote-to-recipe serialises the widget the user has; frames are keyed by workspace, widget and dataset in the web state. Further out, an alert is a transform with a condition over a dataset, a user drawing is a hand-authored layer, and streaming is a dataset update channel; none of them touches the model.

What this costs: a renderer rewrite of the series view around panes and layers (lightweight-charts 5.2 has every primitive needed: `addPane`, `priceScaleId`, `createSeriesMarkers`, `createPriceLine`, `attachPrimitive`, histogram series, `createYieldCurveChart`), the field config pipeline in core, and the preset module. The table, stat, chain and facts card views become presets over the same field config with their current renderers.

### Views and features for v2

Bench v2's fails were as much about what the user could not *see* as about data. Ranked, with the fail each one clears:

1. **Markers on charts.** A series view takes an optional `events` input: any frame with a time column, a label and a kind, rendered as markers on the price line (lightweight-charts series markers) with a tooltip and a legend entry. Recipes supply the common ones: earnings dates with the reaction, dividends, insider trades, splits, macro releases, the news cluster the reply names. The agent can also place its own: `events: [{ time, label }]` typed by hand ("the drop"), for the reply to point at. Also horizontal levels (strikes, 52-week high and low, a target price) and shaded ranges (the earnings window, last week). Clears: TSLA earnings reactions ("the chart marks the reactions" becomes true), CRWV "what moved it".
2. **Panes and axes.** A series view can stack panes (price above, volume or RSI below), put a second series on a right axis (price against a yield), and use a numeric x-axis instead of time (a yield curve by maturity, the IV term structure, open interest by strike). The transform engine produces these frames; the view must be able to draw them. Clears: rates week (curve view), options (term structure), any indicator prompt.
3. **Table control by the agent.** `view.columns` (which, in what order), `view.sort`, a highlighted row, and conditional colour on percent columns. A compare prompt renders metrics × symbols as a pivot with best and worst marked. Clears: neoclouds (debt and FCF were fetched but hidden), cheap-tech (40-row dump).
4. **Previews the agent can steer.** Default stays 25 rows plus stats; the agent can ask for a slice (`tail`, a time range, top-N by a column) through a transform, and previews of a frame with a time column always include the first and last timestamps and the row dates that fall on recipe-known events. Clears: S&P last week (PPI and retail sales were past row 25), rates week (Friday's rows).
5. **Time semantics in one place.** `ot.last_week()`, `prev_close`, ET session awareness, weekday labels in calendar frames, baseline from the close before the period (bench v1's TSMC finding). Used by recipes, transforms and the prompt. Clears: wrong weekdays, 1mo change from the first bar, "last week" meaning the last 30 days.
6. **Index and sector recipes.** "The S&P" resolves to `^GSPC` with SPY as the tradable; sector performance derived from the eleven sector ETFs; constituents from holdings; leaders and laggards from movers filtered to an index. Clears: S&P last week.
7. **Screener recipe.** The yfinance screener route with the agent's filters, then a transform for anything the route cannot filter. Clears: cheap-tech.
8. **Frames keyed by workspace.** Widget ids repeat across workspaces; the web state keys frames by workspace and widget, and the `frameMatches` guard stays as belt and braces. A defect, not a feature; first in phase 1(d).
9. **No one-row tables (product rule 8).** A table's job is comparison, and one row compares nothing. Two layers: the table view renders a one-row frame as a **facts card** (label over value, wrapped to the width, same formats and mono numbers), so hand-built widgets and frames that shrink on refresh never show a lonely row under ten headers; and `set_workspace`, which sees preview row counts, rejects a table over a one-row frame with the rule: stat for one or two headline numbers, the facts card for a snapshot with several, the reply or a chart marker for a single date or fact, a pivot through a transform for one symbol's financials. The prompt carries the same table. Clears: the 73%-blank cells in the TSLA puts and CRWV workspaces.
10. **Heatmap view.** A matrix frame (correlations, sector × week returns, holdings by weight) as a coloured grid. Small, and the transform engine makes the frames trivial to produce.
11. **Promote to recipe.** A transform or query the user likes can be saved as a recipe from the widget menu, with a name and a title template, into `~/.terminal/recipes.yml`; the agent sees user recipes beside the built-in ones. This is how the catalog grows from use.

Deferred past v2, each with a reason: histogram and distribution views (one prompt in the bench set, pandas can tabulate for now), text or note widgets (the reply is the narrative), alerts and conditions (section 9), user drawing on charts (markers are data-driven first), streaming (polling on TTL holds).

### Caching and TTL

Cache key is `connector + route + canonical params`. TTL by route pattern in a small table: `*/quote*` and `*/price/quote` 10 s, `*/historical*` with intraday intervals 1 min else 10 min, `news/*` 5 min, `*/calendar/*` 1 h, fundamentals and ownership 1 day, default 10 min. Recipes can override.

### Agent

Tools: `find_route(query: string)` returns up to five catalog entries; `query(connector, route, params)` validates against the descriptor and returns a preview as today; `transform(inputs, code, columns?)` as above; `set_workspace` unchanged except widgets hold `{ connector, route, params }`, a `recipe` name with params, or a transform. Prompt: the recipe list with one example query each (about 25 lines, replacing the kind guidance), the rule "use a recipe when one fits; search the catalog when none does; never write a figure that is not in a preview", the unit rule above, and the worked examples rewritten with routes. Expected cost: one extra tool call on prompts that leave the recipes, about two seconds.

### Migration

- Stored widgets with `{ kind, params }` are read as `{ recipe: kind, params }` by a one-time migration in the store; recipes carry the exact routes the kinds used, so every existing workspace renders unchanged.
- `pnpm query` takes `<connector> <route> key=value…` and keeps `pnpm query <recipe> …`.
- The bench and its notes are unchanged; bench v2 is the acceptance test.

### Removed

`packages/core/src/kinds.ts` and its 22 schemas; per-kind handlers in all three connectors (OpenBB's 600-line `index.ts` becomes the descriptor generator plus a 60-line caller); `formatsFor`, `KIND_PRIORITY`, `subtitleFor` per kind (replaced by shape and annotations: subtitle is route summary plus the params that matter); `STAT_KEY_COLUMN` (replaced by annotation `key: true` or the first numeric). Section 7.1's table becomes the recipe list in `recipes.yml`.

Done in phase 3a (2026-10-19), with one departure: the subtitle stays keyed by recipe name over the dataset's params and frame (route and transform datasets describe themselves), because the recipe wording was better than a route path; see the 3a corrections under the status line.

### UI changes from the Instinct reference (ss.png, 2026-10-18)

The user's screenshot of Instinct's "CL market summary" workspace sets the bar. What it does and what v2 takes from it:

- **Three columns beside the open panel.** Its grid is about 1,470 CSS px wide with a 380 px panel, six widgets in two rows of three, each about 480 px wide and 450 px tall, filling the viewport with no vertical scroll. Our packer gives three columns from 1,100 px of grid width; v2 lowers that to 960 px (widgets about 320 px wide), so a 1,440 px laptop with the panel open gets three columns. Charts, stat cards and facts cards work at 320; tables shed columns by priority as they do now.
- **Size by content, not by the agent's guess.** Instinct's widgets are uniform; ours vary by an agent-chosen size that does not know the data. v2 keeps lg, md and sm as hints but lets the packer demote: a table with six rows or fewer, a stat, a facts card and a one-symbol quote are one row tall; charts are two rows tall unless there are more than six widgets. The rule lives in `packLayout` beside the no-holes rule and is what removes the blank space inside tables.
- **Charts before tables.** Every one of Instinct's six widgets is a chart. The prompt's widget guidance flips its default: a chart or a stat for anything with a time column or a headline number; a table only for comparison across rows (more than one row, more than two columns). The bench's widgets criterion grades it.
- **Presets the screenshot uses that we lack**: signed bars (funding rate: positive green, negative red, zero line), a diverging colour scale with a legend (monthly returns), a horizontal volume profile beside the price, event markers on the line with icons by kind, last-value badges on the price axis in the series colour, legend chips inside the plot's top-left. All are marks or options in the layer model; the first three are new marks (`bar` with signed colour, `cell` with a diverging scale, `profile`).
- **Shell**: a ticker strip under the tabs with four to six live quotes the user chooses (SPX, NDX, 10y, VIX, oil, gold by default) and a market strip in the status bar; the conversation panel header shows "Worked for 16 s · 4 steps" with the steps expandable, which our run log provides. Not taken: drag handles (rule 3 stands), a Feed or Home page (rule 2), alerts (section 9).

### Visual acceptance: test cases and the iteration loop

Every phase 1 workstream that touches what the user sees ships with screenshots, and phase 2 does not end until the cases below look right. "Look right" is a checklist a headless browser can score, plus a human look at the final set.

Checklist per workspace, measured in headless Chromium at 1440x900 and 1920x1080 with the panel open: no element with `scrollWidth > clientWidth`; no empty grid cell; no widget whose content box fills less than 60% of its height (tables and cards) or 80% (charts); no table with one row; three columns at 1440 with the panel open; every widget has a title and a sub-header; every chart has a legend and a last-value label; no text clipped mid-word; the reply has no unverified number (reply verification) and at least one chip per cited widget. Plus a human pass on the set for taste: alignment, density, colour, that it reads like a terminal.

Cases (prompt, then what the workspace must contain):

1. "Why is CRWV down?" — price with the drop marked and news markers; bond yields line (FINRA) with the 2030 notes; peers compare; a stat for today's move; the reply names the catalyst.
2. "Compare the neoclouds" — rebased performance chart; a compare table (metrics by symbol, best and worst marked) with growth, margins, debt, FCF, valuation; estimates; no table under seven rows.
3. "What's happening to the S&P last week?" — `^GSPC` for exactly last week with macro-release markers; sector performance bars for the week; leaders and laggards; the calendar rows for that week in the reply.
4. "TSLA puts for next Friday" — the chain with the underlying from the quote; IV term structure on a numeric axis; a stat for IV rank; the implied move in the reply.
5. "TSLA earnings reactions" — candle chart with every report marked and its reaction; a table of reports with the reaction column; the reply gives all seven.
6. "Large-cap tech under 20x" — the screener as a table sorted by P/E, virtualised; a stat for the count; a heatmap of P/E by sector.
7. "P/E over time for NVDA" — the derived line with the EPS dates marked; the current value as a stat; the transform visible in the editor.
8. "RSI and MACD on AMD" — price pane, RSI pane with 30/70 levels, MACD pane with histogram, one widget.
9. "10y minus 2y and the curve today" — the spread line from two macro series with recession-style shading when negative; the yield curve on a numeric axis.
10. "Morning check on my watchlist" — a ticker strip, a quote stat row, reporting-today markers, overnight news; three columns, two rows, no scroll.
11. "Correlation of the Mag 7 over 6 months" — a heatmap with a diverging scale and the pairs named in the reply.
12. "Backtest a 50/200 SMA cross on SPY since 2020" — equity curve against buy-and-hold, trade markers, a facts card with the summary statistics.

The loop: a bot builds the workspace through the agent on its own server, screenshots it, runs the checklist, fixes what fails (preset, prompt rule, packer rule, annotation), and repeats until the checklist passes; then a second bot, briefed only with the screenshot and the case, grades taste and lists what it would change; the first bot addresses that once more. The PR carries the final screenshots in a before/after table against production, and the bench note records the checklist results. No case is marked done on a bot's say-so; the user looks at the final set.

### Also in v2

Changes outside the data and view model that v2 should carry, because the schema migration makes them cheapest now or because the model makes them nearly free.

Must:

- **Reply verification on the server.** Rule 4 was enforced only by the prompt, and bench v2 caught it failing. The server extracts every number from the streamed reply, matches each against that run's previews with unit-aware tolerance (percent vs fraction, rounding), flags unmatched figures in the reply UI and records the result in the run log. The bench reads the log instead of re-verifying by hand.
- **Store on SQLite** (`node:sqlite`, Node 22, no native dependency): workspaces, widgets with their data graphs, recipes, the catalog cache, probe results, run logs, and a persistent frame cache keyed by route and params so a restart does not refetch two years of bars. One-time migration from the JSON store.
- **Run log.** Each prompt records steps, timings, tokens, cost, and the verification result; shown as the steps in the conversation panel, kept for the bench and for "why did it do that".
- **Editor with three tabs**: data (the graph, each dataset's preview), transform (CodeMirror 6 with the traceback inline), view (preset options and the expanded layers). The expand dialog shows the same plus the whole frame.
- **Data page** replaces the Connectors page: catalog browser with search, liveness and a probe button, keys, per-route provider overrides, and the recipe library with promote and edit.
- **Virtualised tables** for transform and screener outputs in the thousands of rows.
- **The rename**: `@openterminal/*` scope, `openterminal` bin, `~/.openterminal` config directory with migration from `~/.terminal`, npm publish. v2 is a migration anyway.

Should:

- **Workspace export and import** as one JSON file carrying data graphs, transforms, presets and recipes; how workspaces get shared and how bug reports arrive.
- **Widget-scoped prompts**: "make this weekly" edits one widget's graph or preset without rewriting the workspace, same agent with a smaller context.
- **Beyond US equities for data** (routes already serve crypto, FX and non-US listings); the clock module stays on the US calendar in v2, per-exchange calendars follow.
- **Docs rewrite**: adding a data source by descriptor, writing a recipe, writing a preset; architecture and vocabulary pages updated for the new nouns.

Deferred with a reason: Arrow for frames over the socket and into Pyodide (until a measured prompt is slow from serialisation); scheduling and alerts (section 9); a Pyodide worker pool (until one worker measurably queues).

### Phases

0. **Trunk** (one agent, sequential): descriptor type, catalog with search, shape detection, annotations loader, unit conversion, the runner, and tests with a recorded `openapi.json` fixture. Nothing user-visible changes.
1. **Parallel**: (a) OpenBB descriptor generator, caller, probe script and liveness; (b) yahoo and finnhub descriptor files and callers; (c) agent tools and prompt with recipes; (d) web: views by shape, editor from descriptors, Connectors page catalog, subtitles from routes; (e) SQLite store and migration, persistent cache, run log, `pnpm query`, docs (`writing-a-connector.md` rewritten around descriptors, the README kinds table replaced by "any route, plus these recipes"); (f) transforms: the Pyodide worker, the `ot` helpers, the tool, the widget type, editor and subtitle; (h) shell: the three-tab editor, the Data page, virtualised tables, export and import, widget-scoped prompts, the rename; (i) reply verification; (g) views: the field config pipeline, presets, the pane-and-layer chart renderer (markers, levels, bands, histogram, numeric x), table control, facts card and the one-row rule, heatmap.
2. **Integrate and accept**: bench v2 rerun and the twelve visual cases above through the iteration loop; the target is the three user prompts passing, the checklist green on all twelve at both viewports, and no regression on bench v1; new annotations added for every unit mistake found.
3. **Remove**: delete the kind code once the bench passes; PLAN.md sections 7.1, 14 marked superseded. Done 2026-10-19 as phase 3a (see the status line), ahead of the bench rerun the API credit blocks, since the recipe path had been serving every production workspace since phase 2 and the kind path was dead weight in every file.

### Risks and answers

- *Wrong units in replies.* Annotations for every field the recipes touch before phase 2; the preview shows the unit per column; the prompt forbids stating a unit the column does not carry. The bench grades it.
- *The agent picks a bad route.* Liveness filters dead ones; ranking prefers the trading namespaces; recipes cover the common 80%. Measured by bench v2.
- *Views that render garbage.* Shapes gate the views; the table is the floor and always renders.
- *Prompt latency.* One extra tool call only off the recipe path.
- *Fixtures.* Tests run against a recorded `openapi.json` and a dozen recorded responses, never the network, as today.
- *Losing the typed contributor contract.* A contributor adds a REST API by descriptor file, which is simpler than 50 lines per kind, and the catalog validates it at load.

### Out of scope

Write routes (orders), authentication flows beyond API keys and basic auth, embeddings for search, streaming routes, user-installed Python packages, plotting or network from transforms.
