# Architecture

A one-page tour for contributors. Everything here restates PLAN.md section 17 (v2); when the two disagree, PLAN.md wins and this page is wrong. Sections 7.1 and 14 of the plan describe the v1 kind catalog that phase 3a removed and are kept for history.

## Repo layout

pnpm monorepo, TypeScript strict, Node 22.

```
packages/
  core/       the contract: frames, descriptors and the OpenAPI generator, catalog, queries, recipes (recipes.yml),
              annotations (annotations.yml), fields and shapes, presets and layers, clock, transform contract,
              frame inference, defineConnector, registry, cache, protocol
  server/     connector loader, HTTP + WebSocket API, SQLite store, persistent frame cache, transform engine
              (Pyodide), probe and liveness, agent loop (src/agent)
  ui/         design system: tokens, components, chart theme, preview page
  web/        React app: shell, state, WebSocket client, palette, Data page, the three-tab editor, views (src/views)
  cli/        `npx openterminal` → starts the server on localhost, opens the browser; first-run key prompt, banner,
              daily update check
  desktop/    the desktop app: Electron around the release bundle (server in a utility process, window, tray,
              updates), electron-builder, its smoke test
connectors/
  openbb/     no key; every GET route of a local OpenBB Platform API, descriptors generated from its openapi.json
  yahoo/      no key; the five yahoo-finance2 endpoints as routes (descriptors.json)
  finnhub/    free key; quote, company-news, calendar/earnings as routes (descriptors.json)
docs/
  vocabulary.md, writing-a-connector.md, architecture.md, shipping.md, notes/
scripts/
  query.ts            `pnpm query <recipe> key=value …` and `pnpm query <connector> <route> key=value …`
  probe-catalog.ts    `pnpm probe` calls every route once and records liveness
  readme-recipes.ts   `pnpm readme:recipes` regenerates the README's recipe table from recipes.yml
  prompt-bench.mjs    `pnpm bench` runs scripts/prompts.json against a running server
  accept.mjs          the visual acceptance loop over the twelve section 17 cases
  release/            `pnpm release:bundle`, `release:npm`, `release:smoke`: the release bundle (dist/release/lib), the npm
                      package from it, and the smoke test (PLAN.md section 18)
```

`packages/core` is the shared contract: every other package compiles against it and it changes only with the plan. The stack is Zod for every schema, Hono for HTTP and WebSocket, Vite + React, Tailwind for tokens, lightweight-charts 5, cmdk for the palette, the Vercel AI SDK for the agent, Pyodide (CPython, pandas, numpy, scipy in WebAssembly) for transforms, `node:sqlite` for the store, Vitest for tests.

## The data path: prompt to pixels

```
prompt ─▶ agent ─▶ find_route ─▶ catalog (descriptors + liveness)
             │
             ├──▶ query { recipe | connector+route } ─▶ registry ─▶ connector.call ─▶ inferFrame ─▶ annotations ─▶ frame
             ├──▶ transform { inputs, code } ─▶ registry ─▶ inputs ─▶ Pyodide worker ─▶ frame
             │                                                                            │
             ◀───────────────────────────── preview (columns, units, rows, stats) ───────┤
             │                                                                            │
             └──▶ set_workspace ─▶ widgets ─▶ executor runs each dataset ─▶ frame per dataset ─▶ preset ─▶ view
                  reply with chips, verified against the previews
```

1. **Prompt.** The user types in the PromptBox. The web app sends `{ t: 'prompt', workspaceId, text }` over the socket.
2. **Agent.** The server's `AgentRunner` runs the loop (Vercel AI SDK, provider and key from config, prompt caching on). The system prompt holds the recipe list (`recipeSummaryLines`), the connectors and the catalog size, the rules from section 17 (use a recipe when one fits, search when none does, never a figure outside a preview, unannotated numbers carry no unit, charts before tables, the one-row rule), the current workspace, today's date and market state from `clock.ts`, and worked examples including the P/E transform. Hard cap of ten tool calls per prompt.
3. **Tools.** `find_route({ query, namespaces? })` searches the catalog (BM25 over path, summary, description, params and fields; dead routes hidden) and returns up to five routes plus recipe names that match. `query` runs a recipe or a route. `transform({ inputs, code, columns? })` runs a pandas script over frames. `set_workspace({ name?, widgets })` validates every widget (`WidgetV2Schema`; recipe params; route params against the descriptor; for datasets the run previewed, that the preset can draw the frame and that no table sits over one row) and replaces the widgets.
4. **Registry.** A **route** query: the descriptor validates the params, `connector.call` answers, the registry stamps the TTL (`ttlForRoute`) and the lineage and applies the annotations (fractions become percent, units and labels land in `frame.meta.fields`). A **recipe** query: the recipe's params are validated against its JSON schema, each dataset's route alternatives are tried in order with fallback on error or an empty frame, a route's `rename` keeps the column names the recipe expects, and transform datasets run after their inputs with the validated params bound as the reserved `params` input; the frame carries the recipe name and a hash of its definition in the lineage, so a persistent cache from an older definition is a miss. A **transform** query: inputs run in parallel (cache hits when fresh), then the engine. Frames are cached by `canonicalKey` in memory and in SQLite.
5. **Connector.** A plain module made with `defineConnector`: `descriptors()` (a file, or generated from an OpenAPI document) and `call(route, params, ctx)` → `inferFrame`. See `writing-a-connector.md`. No unit conversion, no selection: a faithful window onto the source.
6. **Transform engine.** One warm Pyodide worker per server (pandas 3, numpy, scipy, the `ot` helpers with the NYSE calendar), booted in the background after listen (15 to 25 s cold, tens of milliseconds warm). Imports limited to an allow-list, CPU and memory caps, input and output row caps, a timeout that interrupts first and kills only a script that swallows it.
7. **Frame → preview (to the agent).** `preview(frame)`: columns with their units, row count, rows (all when 25 or fewer, else the first 25), per-group per-numeric-column stats (`first`, `last`, `min`, `max`, `change`, `changePct`), lineage. The agent may only write numbers that appear in a preview; `verify.ts` checks the reply's figures against the run's previews and the result travels on the `done` message.
8. **Executor.** The server runs every dataset of every widget (`widgetQueries`) and emits `frame` / `frameError` per dataset, keyed by workspace, widget and dataset; only the focused workspace polls, on each frame's TTL.
9. **Frame → preset → view (to the browser).** For each dataset, field config is `mergeFieldConfig(detectShape(columns, rows), frame.meta.fields, widget.fields)`. A preset (`expandPreset` for charts, `controlFor` for tables, stats, facts and chains) is a pure function from the view's options and the datasets' field config to panes and layers or a control spec. `ChartView` draws panes and layers on lightweight-charts (lines, candles, histograms, markers, levels, bands, a numeric x axis for curves); `TableView`, `StatView`, `FactsCard`, `ChainView`, `HeatmapView` render their controls. A table over one row renders the facts card (product rule 8). The grid packs widgets by size and content hint.
10. **Reply with chips.** The agent's final text streams as `delta` messages and lands as `done` with the full `Message` and its `verification`. `[[widget:<id>]]` tokens render as chips that scroll to and flash the widget.

## Message sequence over the socket

One WebSocket per client at `/ws`. For one prompt:

```
client  ──  prompt { workspaceId, text }  ──▶  server

server  ──  started { workspaceId }                             web app: Empty → Active
server  ──  step { workspaceId, step }        × n               one per tool call (find_route, query, transform, set_workspace)
server  ──  widgets { workspaceId, widgets, name? }             grid renders skeletons
server  ──  frame { workspaceId, widgetId, dataset?, frame }    per dataset
        ──  frameError { workspaceId, widgetId, dataset?, error }
server  ──  delta { workspaceId, text }       × n               the streaming reply
server  ──  done { workspaceId, message }                       message = { role: 'agent', text, steps, verification }
```

`failed { workspaceId, error }` can replace anything after `started`. The client can also send `cancel { workspaceId }`, `refresh { widgetId, workspaceId?, dataset? }` (re-runs a widget bypassing the cache) and `focus { workspaceId }` (which workspace polls). The schemas are `ClientMsgSchema` and `ServerMsgSchema` in `packages/core/src/protocol.ts`.

HTTP, under `/api`: `GET /api/health` (connectors, recipes, llm); workspaces CRUD, export and import; `GET /api/widgets/:id/frame?workspace=&dataset=`; `GET /api/connectors`, `PUT /api/connectors/:name/config`; `GET/PUT /api/llm` (the onboarding key: saved to config.yml, never returned); `GET /api/catalog?q=`, `GET /api/catalog/:connector`, `POST /api/catalog/probe`; `GET/PUT /api/recipes`; `POST /api/query`; `GET/PUT /api/settings/:key` (`ticker`, `providers`); `GET /api/runs`; `GET /api/store`.

## The web app

- **Empty.** A new workspace shows a centered PromptBox with the three example prompts as chips. **Active.** On `started`, the PromptBox moves to a right sidebar that holds the conversation (steps, the reply with chips, the verification), and the grid fills as `widgets` and `frame` messages arrive. The View Transitions API slides the box.
- **Grid.** CSS grid, three columns from 960 px, `grid-auto-flow: dense`; `packLayout` sizes by content (a short table, a stat or a facts card is one row; charts two; a non-hero md chart one column wide) and repairs holes.
- **Editor.** Three tabs per widget: data (the graph: datasets added as a recipe, a route from the catalog or a transform, with a preview per dataset), transform (CodeMirror with the traceback inline), view (the preset and its options generated from `ViewV2Schema`, the expanded panes read-only).
- **Data page** (`#data`): the catalog per connector with search, liveness and the probe button, keys, per-route provider overrides, the recipe library with promote and edit, the store's state. Also the ticker strip (six `quote` datasets, saved server-side) and the market strip from `describeMarketTime`.

## Where each concern lives

| Concern | Lives in |
|---|---|
| Frame shape and conventions | `packages/core/src/frame.ts` |
| Descriptors, params validation, the OpenAPI generator | `packages/core/src/descriptor.ts`, `descriptor-openapi.ts` |
| Catalog (BM25 search, liveness) | `packages/core/src/catalog.ts` |
| Queries (route, recipe, transform; `canonicalKey`) | `packages/core/src/query.ts` |
| Recipes (`recipes.yml`), templates and filters, the README table | `packages/core/src/recipes.ts`, `packages/core/recipes.yml` |
| Annotations (`annotations.yml`), field config, shapes | `packages/core/src/annotations.ts`, `fields.ts`, `shape.ts` |
| Widget model: datasets, presets, panes and layers; the v1 JSON migration | `packages/core/src/widget.ts`, `presets.ts`, `layers.ts` |
| Clock (ET sessions, NYSE calendar, ranges), transform contract, frame inference | `packages/core/src/clock.ts`, `transform.ts`, `infer.ts` |
| Workspace, message, step schemas; chip token | `packages/core/src/workspace.ts` |
| `defineConnector`, `Ctx`, `createHttp` | `packages/core/src/connector.ts` |
| Registry (routes, recipes, transforms, fallback, annotations, TTLs) | `packages/core/src/registry.ts` |
| Cache (in-memory; SQLite in the server) | `packages/core/src/cache.ts`, `packages/server/src/cache-sqlite.ts` |
| `preview()` | `packages/core/src/preview.ts` |
| Socket and HTTP message schemas, `AgentRunner` interface | `packages/core/src/protocol.ts` |
| Config loading, built-in connector map, registry wiring | `packages/server/src/config.ts`, `connectors.ts` |
| The home directory (`OPENTERMINAL_HOME`, else `~/.openterminal`) and its one-time copy from the pre-rename `~/.terminal` | `packages/core/src/node.ts`, `packages/server/src/home.ts` |
| HTTP and WebSocket routes, data routes, widget execution, polling | `packages/server/src/app.ts`, `routes-data.ts`, `executor.ts` |
| Store (SQLite at `~/.openterminal/terminal.db`, the one-time JSON migration) | `packages/server/src/store/` |
| Transform engine, `ot.py`, vendored wheels | `packages/server/src/transform/`, `packages/server/pyodide/` |
| Probe and liveness | `packages/server/src/probe.ts`, `liveness.ts`, `scripts/probe-catalog.ts` |
| Agent loop, the four tools, system prompt, reply verification, run log | `packages/server/src/agent`, `verify.ts`, `runlog.ts` |
| Stub agent (fixed use-case-A widget set when no LLM key) | `packages/server/src/stub-agent.ts` |
| Tokens, components, chart theme, series palette | `packages/ui` |
| Shell, state (frames keyed by workspace, widget, dataset), socket client, palette, Data page, editor | `packages/web` |
| Field config pipeline and the views | `packages/web/src/views` |
| `npx openterminal`: flags, first-run key prompt, banner, update check | `packages/cli` |
| Where runtime files are (recipes, annotations, web app, Pyodide, wheels, the transform worker), from source or the release bundle | `packages/core/src/resources.ts` (`resources()`) |
| The release bundle, the npm package, the smoke test | `scripts/release/` |
| Only this machine's pages may call the server (Host and Origin checks) | `packages/server/src/guard.ts` |
| The desktop app (main process, its pure parts, electron-builder config, smoke test) and the release workflow | `packages/desktop`, `.github/workflows/release.yml` |
| Connectors | `connectors/<name>/src` |
| Config, store, catalog cache, user recipes and annotations on disk | `~/.openterminal/config.yml`, `terminal.db`, `catalog/`, `recipes.yml`, `annotations.yml` (override the directory with `OPENTERMINAL_HOME`) |

Ports: server `http://localhost:4242` (`/api`, `/ws`); web dev server `http://localhost:5173`, proxying `/api` and `/ws` to 4242; UI preview page `http://localhost:5174`.

## Decisions that shape the code

From PLAN.md section 0 and section 17, so nobody reopens them by accident:

- A prompt overwrites the workspace. No diff, no accept/reject. A follow-up re-emits the widgets it wants to keep.
- Layout is automatic. The agent assigns sizes, never positions. No dragging.
- Routes replace kinds (section 17). The two things kinds guaranteed, correct units and views that know their columns, are kept by annotations and shapes. A recipe is data, not code; a question one route answers becomes a recipe, not a connector change.
- Connectors convert nothing: provider values plus annotations. Selection and derivation are pandas in a recipe's data graph or a transform, in a Pyodide sandbox, never a native Python process.
- Every number in a reply comes from a preview, and the server verifies it.
- Local-first, bring your own keys. One process on localhost plus the browser. No accounts, no hosted backend.
- US equities only. No streaming; TTL polling instead.
- cordis is deferred. Contributors only see `defineConnector`, so the loader can be swapped later without touching a connector.
