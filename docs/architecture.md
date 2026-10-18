# Architecture

A one-page tour for contributors. Everything here restates PLAN.md sections 6 and 7; when the two disagree, PLAN.md wins and this page is wrong.

## Repo layout

pnpm monorepo, TypeScript strict, Node 22.

```
packages/
  core/       Frame, Widget, Workspace types; kind catalog; defineConnector; registry; cache; protocol
  server/     connector loader, HTTP + WebSocket API, JSON file store, agent loop (src/agent)
  ui/         design system: tokens, components, chart theme, preview page
  web/        React app: shell, state, WebSocket client, palette, connectors page, views (src/views)
  cli/        `npx terminal` → starts the server on localhost, opens the browser
connectors/
  openbb/     no key; every kind, through a local OpenBB Platform API (listed first, free when not running)
  yahoo/      no key; search, quote, ohlcv, earnings, plus the yahoo-finance2 fallbacks listed in PLAN.md section 14
  finnhub/    free key; quote, news, earnings
docs/
  vocabulary.md, writing-a-connector.md, architecture.md, notes/
scripts/
  query.ts            `pnpm query <kind> key=value …` prints a frame for any kind
  prompt-bench.mjs    `pnpm bench` runs scripts/prompts.json against a running server
```

`packages/core` is the shared contract: every other package compiles against it and it changes only with the plan (the v1.2 catalog in PLAN.md section 14 was one such change). The stack is Zod for every schema, Hono for HTTP and WebSocket, Vite + React, Tailwind for tokens, lightweight-charts, cmdk for the palette, the Vercel AI SDK for the agent, Vitest for tests.

## The data path: prompt to pixels

```
prompt ─▶ agent ─▶ query tool ─▶ registry ─▶ connector ─▶ frame
                      │                                     │
                      ◀──────────── preview ────────────────┤
                                                            │
          set_workspace ─▶ widgets ─▶ (server executes) ────┼─▶ frame ─▶ view ─▶ widget
                                                            │
          reply with chips ◀────────────────────────────────┘
```

1. **Prompt.** The user types in the PromptBox. The web app sends `{ t: 'prompt', workspaceId, text }` over the socket.
2. **Agent.** The server's `AgentRunner` runs the loop (Vercel AI SDK, provider and key from config). The system prompt holds the kind catalog with param schemas generated from core, the kinds the registry can currently answer, the current workspace JSON, today's date and market state, and the rules (run queries before writing numbers, four to six widgets by default and fewer when asked, first widget is the hero, short titles, a prompt overwrites the workspace, the reply begins with the answer, period changes are measured from the close before the period), plus six worked examples. The `query` tool takes `params` as an open object that `parseQuery` validates against the kind. Hard cap of ten tool calls per prompt. Symbol lookup is `query('search', { q: [...] })`, batched.
3. **`query(kind, params)` tool.** Calls the registry. The registry validates the query against the catalog, serves from cache when fresh, else tries connectors in config order and falls back on error, then validates the returned frame's columns against the catalog (name, type, order) and caches it for the kind's TTL.
4. **Connector.** A plain module made with `defineConnector`. It receives validated params and a `Ctx` (`http.get`, `config`, `log`, `signal`) and returns a `Frame` via `toFrame`. See `writing-a-connector.md`.
5. **Frame → preview (to the agent).** The tool returns a `preview(frame)`: columns, row count, rows (all when 25 or fewer, else the first 25), and per-symbol (per-series for `macro`) per-numeric-column stats (`first`, `last`, `min`, `max`, `changePct`). The agent may only write numbers that appear in a preview. The full frame stays in the cache so rendering does not refetch.
6. **`set_workspace({ name?, widgets })` tool.** Validates every widget against the kind and view schemas (`WidgetSchema`: `series` requires an `ohlcv` or `macro` query, `candle` and `normalize` are only for `ohlcv` and mutually exclusive, `candle` requires exactly one symbol, `chain` requires an `options` query), replaces the workspace's widgets, and starts executing their queries. The server emits `widgets` immediately and a `frame` or `frameError` per widget as each query settles.
7. **Frame → view → widget (to the browser).** The web app matches each `frame` message to its widget by id and renders it with the widget's view: `series` on lightweight-charts (one line per symbol, or per series for `macro`; options `candle` or `normalize`; the legend shows each line's last value and change over the range), `table` (typed formatting per kind and column sort), or `chain` (calls on the left, strikes in the middle, puts on the right, the underlying price marked). A widget is a skeleton until its frame lands and shows an error state on `frameError`.
8. **Reply with chips.** The agent's final text streams as `delta` messages and lands as `done` with the full `Message`. `[[widget:<id>]]` tokens in the text render as chips that scroll to and flash the widget.

Widgets keep polling after the reply: the cache TTL per kind (quote 10 s, intraday ohlcv, options and movers 60 s, daily ohlcv and volatility 10 min, news 2 min, earnings, estimates, metrics, insiders, calendar, ipos, macro and yield_curve 1 h, the rest 1 d; the full list is in `kinds.ts`) bounds how often a connector is hit, and only the focused workspace polls (`{ t: 'focus', workspaceId }`).

## Message sequence over the socket

One WebSocket per client at `/ws`. For one prompt (PLAN.md 7.4):

```
client  ──  prompt { workspaceId, text }  ──▶  server

server  ──  started { workspaceId }                      web app: Empty → Active
server  ──  step { workspaceId, step }        × n        one per tool call
server  ──  widgets { workspaceId, widgets, name? }      grid renders skeletons
server  ──  frame { widgetId, frame }         per widget
        ──  frameError { widgetId, error }    per widget   interleaved with
server  ──  delta { workspaceId, text }       × n          the streaming reply
server  ──  done { workspaceId, message }                 message = { role: 'agent', text, steps }
```

`failed { workspaceId, error }` can replace anything after `started`. The client can also send `cancel { workspaceId }` (aborts the run via the `AbortSignal` passed to the agent and connectors), `refresh { widgetId }` (re-runs one widget's query, bypassing the cache, and answers with `frame` or `frameError`), and `focus { workspaceId }` (which workspace polls).

The schemas are `ClientMsgSchema` and `ServerMsgSchema` in `packages/core/src/protocol.ts`.

HTTP, under `/api`: `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/:id`, `GET /api/widgets/:id/frame`, `GET /api/connectors`, `PUT /api/connectors/:name/config`.

## The three web app states

- **Empty.** A new workspace shows only a centered PromptBox (max width 640px) with the three example prompts as chips beneath it and a hint for the palette. The tab bar is at the top but quiet.
- **Active.** On `started`, the PromptBox moves to the bottom of a right sidebar (380px) that holds the conversation: the user's message, a collapsible Steps header ("Worked for 12s · 5 steps"), and the reply with chips. The center fills with the grid as `widgets` and then `frame` messages arrive; each widget is a skeleton until its frame lands.
- **Transition.** The View Transitions API with a `view-transition-name` on the PromptBox, so the box slides from center to sidebar. No animation library; browsers without support just switch.

Also: the sidebar toggles with ⌘\ and overlays the grid below 1100px. The grid is CSS grid, three columns, `grid-auto-flow: dense`; lg spans 2x2, md 2x1, sm 1x1; the first widget is placed first. `/` or ⌘K opens the palette (new workspace, jump to workspace, ticker shortcut). A connectors page lists each connector with status (ok, missing key, error) and a key field. A NoKeys state explains how to add an LLM key. Dark theme only.

## Where each concern lives

| Concern | Lives in |
|---|---|
| Kind catalog (params, columns, TTL) | `packages/core/src/kinds.ts` |
| Frame shape and conventions | `packages/core/src/frame.ts` |
| Widget, view, size schemas | `packages/core/src/widget.ts` |
| Workspace, message, step schemas; chip token | `packages/core/src/workspace.ts` |
| `defineConnector`, `toFrame`, `Ctx`, `createHttp` | `packages/core/src/connector.ts` |
| Registry (routing, fallback, column validation) | `packages/core/src/registry.ts` |
| Cache (in-memory, keyed by kind + stable params) | `packages/core/src/cache.ts` |
| `preview()` | `packages/core/src/preview.ts` |
| Socket and HTTP message schemas, `AgentRunner` interface | `packages/core/src/protocol.ts` |
| v2 (PLAN.md section 17, phase 0; beside the kinds until phase 3): descriptors and the OpenAPI generator | `packages/core/src/descriptor.ts`, `descriptor-openapi.ts` |
| v2 catalog (BM25 search, liveness) | `packages/core/src/catalog.ts` |
| v2 queries (route, recipe, transform; `canonicalKey`) | `packages/core/src/query.ts` |
| v2 field config, shapes, annotations (`annotations.yml`), recipes (`recipes.yml`) | `packages/core/src/fields.ts`, `shape.ts`, `annotations.ts`, `recipes.ts` |
| v2 widget model: datasets, presets, panes and layers | `packages/core/src/widget.ts`, `presets.ts`, `layers.ts` |
| v2 clock (ET sessions, NYSE calendar), transform contract, frame inference | `packages/core/src/clock.ts`, `transform.ts`, `infer.ts` |
| Phase 1 seams (who owns and consumes what) | `docs/notes/v2-contracts.md` |
| Config loading, built-in connector map, registry wiring | `packages/server/src` (`connectors.ts` holds the map) |
| HTTP and WebSocket routes, widget execution, polling | `packages/server/src` |
| Workspace store (`~/.terminal/workspaces/<id>.json`) | `packages/server/src` |
| Agent loop, the two tools, system prompt builder | `packages/server/src/agent` |
| Stub agent (fixed use-case-A widget set when no LLM key) | `packages/server/src/stub-agent.ts` |
| Tokens, components, chart theme, series palette | `packages/ui` |
| Shell, states, socket client, palette, connectors page | `packages/web` |
| `series`, `table` and `chain` views | `packages/web/src/views` |
| `npx terminal` | `packages/cli` |
| Connectors | `connectors/<name>/src/index.ts` |
| Config and workspaces on disk | `~/.terminal/config.yml`, `~/.terminal/workspaces/` (override the directory with `TERMINAL_HOME`) |

Ports: server `http://localhost:4242` (`/api`, `/ws`); web dev server `http://localhost:5173`, proxying `/api` and `/ws` to 4242; UI preview page `http://localhost:5174`.

## Decisions that shape the code

From PLAN.md section 0, so nobody reopens them by accident:

- A prompt overwrites the workspace. No diff, no accept/reject. A follow-up re-emits the widgets it wants to keep.
- Layout is automatic. The agent assigns sizes, never positions. No dragging.
- Five kinds, two views, two agent tools, two connectors in v1; v1.2 grew the catalog to 22 kinds and added the `chain` view (PLAN.md section 14) because the top data gaps were all keyless routes one connector already served. Still two tools. Add nothing without a use case that needs it.
- Local-first, bring your own keys. One process on localhost plus the browser. No accounts, no hosted backend.
- US equities only. No streaming; TTL polling instead.
- cordis is deferred. Contributors only see `defineConnector`, so the loader can be swapped later without touching a connector.
