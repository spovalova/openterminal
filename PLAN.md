# Open Terminal — v1 plan and handoff

Repository: https://github.com/spovalova/openterminal (moved from williammtan/terminal on 2026-10-18). Until code exists, this file is the single source of truth. The product is called **Open Terminal** (decided 2026-10-18). `terminal` remains the package scope, CLI bin and config directory until the rename commit; `open-terminal` on npm is held by an unrelated 2022 package, so the published name is `openterminal` unless the user prefers a scoped `@open-terminal/cli`.

## 0. Handoff

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

v1 shipped the first five. v1.2 (section 14) added the rest over routes the keyless OpenBB providers already serve. Every kind is still "a param schema plus exact columns"; the source of truth is `packages/core/src/kinds.ts`.

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

**Verification.** `pnpm test` offline; `pnpm --filter @terminal/connector-openbb smoke` live; use cases A, B, C with the API running, every widget frame `meta.connector: openbb`; the same prompt with the API stopped answered by yahoo; Connectors page screenshots in both states.

## 14. v1.2: the catalog grows to 22 kinds

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
- No horizontal scroll: DataTable is `overflow-x: hidden`, `table-layout: fixed`, with fixed widths for numeric, date and time columns so text columns share the rest. Each kind lists its columns in priority order (`TableView`); the first three always show and each later one needs the widget body about 60px wider, enforced by `@container widget` rules in `@terminal/ui` styles.css, so a lg table in a narrow grid sheds columns the same way a sm one does. The chain measures its own width (a ResizeObserver, because its `colSpan` group headers cannot follow display:none cells) and keeps 7, 5, 4, 3 or 2 columns per side.

**Verification.** 368 tests (core packer exhaustively over every size mix at 1, 2 and 3 columns; DataTable overflow classes; chain tiers), typecheck and lint green; before and after screenshots of two production workspaces at 1280x800 with the sidebar open in `docs/screenshots/layout-*.png`, with a DOM check that no element inside a widget scrolls sideways and every grid cell is covered.

**Out of scope, noted for later.** One-row tables in a full-height cell (a stat card would fit better), human column labels with units, the chart legend over the plot, tab widths, and the sidebar width. All proposed in the same conversation; none needed for the two defects above.

## 16. Chat markdown and legend labels

**Why.** Two cosmetic defects reported from production. The reply was rendered as raw text in a `white-space: pre-wrap` div, so the markdown the model emits anyway (bold labels, bullet lists, inline code, the odd table) showed as literal `**`, `-` and backticks; the section 14 status already noted "replies sometimes use bold labels despite the no-markdown rule". And a series legend could only ever show the symbol (or the macro short name): nothing on the widget let a person or the agent call SPY "S&P 500".

**Decisions.**

- The reply is markdown. `Reply` renders it with react-markdown and remark-gfm (bold, lists, inline code, tables, strikethrough), no rehype-raw, so raw HTML is shown as text and never rendered; links open in a new tab. `[[widget:<id>]]` tokens are rewritten to links on `#widget:<id>` before the markdown pass and the link renderer turns those back into chips, so chips stay inline in sentences and lists. Styles live in `@terminal/ui` styles.css under `.markdown`, on the tokens, compact: one unit between blocks, headings at body size, hairline table rows. The prompt rule against headings, lists and tables stays: the reply should still read as two to four sentences, and rendering is the safety net, not an invitation.
- A series view takes `labels?: Record<string, string>`: a legend label per symbol (ohlcv) or series (macro), trimmed, 1 to 32 characters, and every key must be one of the query's own symbols or series so a label never outlives its line. The legend shows the override in place of the symbol and keeps the symbol as the row's `title`; numbers are unchanged. The widget editor shows one input per line of the query (placeholder: the default label), derived from the params as typed, so adding a symbol adds an input and removing one drops its label. The field flows into `set_workspace` through `WidgetSchema`, with one line in the prompt telling the agent to use it only when the user names a line. Hiding a line is not part of this: that would be a query change, not a label.

**Verification.** 382 tests on the branch, 415 after merging the design system (schema accept/reject, legend override, editor inputs and round trip, reply with bold, list, code, chips, table, raw HTML), typecheck and lint green; before and after screenshots of the same production workspace in `docs/screenshots/chat-markdown-*.png` and `legend-*.png`.
