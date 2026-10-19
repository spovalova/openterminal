# Vocabulary

The words used in code, docs, commit messages, and the UI. Use them exactly; do not introduce synonyms. The definitions come from PLAN.md sections 3 and 17; the examples come from the three use cases in PLAN.md section 5.

## The nouns

| Term | Definition | Example |
|---|---|---|
| **Workspace** | A named tab holding a set of widgets and the conversation that produced them. Everything in the app is a workspace, including one created from a ticker. | The user keeps a workspace named **Morning** and re-runs "Morning check on my watchlist" in it every day. |
| **Widget** | A data graph of named **datasets** rendered by one **preset**, with a title and a size (`lg`, `md`, `sm`) the grid may demote. A plain widget is a graph with one dataset, `main`. Editable by hand or by the agent. | "Memory names, 3 months rebased": `data: { main: { recipe: 'ohlcv', params: {…} } }`, `view: { preset: 'compare', normalize: true }`, size `lg`. |
| **Dataset** | One node of a widget's data graph: a named query whose frame the preset binds by role. Markers, levels, a second pane's series and a comparison's second table are datasets of the same widget, fetched and refreshed on their own TTLs. | `events: { recipe: 'earnings', … }` beside `main`, drawn as markers on the price chart. |
| **Query** | What a dataset holds: a **route** (`{ connector, route, params }`), a **recipe** (`{ recipe, params }`) or a **transform** (`{ inputs, code, columns? }`). | `{ connector: 'openbb', route: 'equity/price/historical', params: { symbol: ['NVDA'], start_date: '2026-07-18', provider: 'yfinance' } }` |
| **Route** | One endpoint of a provider API, described by a **descriptor**: path, params (name, type, enum, default, required), providers, response fields, and a liveness record. The unit of data. | `openbb equity/price/quote`, `yahoo quoteSummary`, `finnhub company-news` |
| **Descriptor** | The description of a route in the one format every connector uses (`packages/core/src/descriptor.ts`): hand-written for a REST API, generated from an OpenAPI document for one that describes itself. | `connectors/yahoo/src/descriptors.json`; OpenBB's 834 generated from `/openapi.json`. |
| **Connector** | A plugin that publishes its descriptors and answers its routes (`defineConnector({ name, config, descriptors, call })`). Holds its config (API key). Runs server-side. Converts nothing: provider values plus annotations. | `yahoo` answers five yahoo-finance2 endpoints with no key; `finnhub` three REST paths with a free key; `openbb` every GET route of a local OpenBB Platform API. |
| **Catalog** | The searchable union of every connector's descriptors, with liveness from the last **probe**. Generated, never edited. What `find_route` searches and the Data page lists. | "corporate bond prices issuer" → `openbb fixedincome/corporate/bond_prices`. |
| **Recipe** | A named, saved query: a title template, a param schema, a preset and size, ordered route alternatives with param mappings (fallback), optionally a data graph with a pandas step. Data, not code (`packages/core/recipes.yml`, `~/.terminal/recipes.yml`). The 22 v1 kinds became the first 22 recipes. | `quote`: yahoo `quote`, then openbb `equity/price/quote`, then finnhub `quote`; `options`: the whole cboe chain, then a pandas step that keeps one expiration and a strike window. |
| **Transform** | A pandas script over one or more input frames that returns one DataFrame, run in a Pyodide sandbox; the result goes through the same inference, annotations, preview and view path as a route's frame. | P/E over time: daily closes joined to trailing-twelve-month EPS. |
| **Frame** | The only data shape that crosses from a connector or a transform to a view: typed columns plus rows, plus `meta` (connector, TTL, lineage, the field config per column). Long format, with a group column (`symbol`, `series`) where there are several. | The `quote` frame behind "Semis today": `symbol, regularMarketPrice, regularMarketChangePercent, …`, one row per symbol. |
| **Shape** | What a frame has, detected from its columns and a row sample: a time column, numeric columns, a group column, option columns, one row per group. Presets declare the shape they need; the editor offers only presets the frame fits. | A frame with `time` and `close` grouped by `symbol` fits `price` and `compare`; one with `strike`, `expiration`, `option_type` fits `chain`. |
| **Annotation** | A hand-written fact about one field of one route (`packages/core/annotations.yml`): unit (`fraction`, `percent`, `ratio`, `usd`, `shares`, `count`, `days`, `years`, `bps`), label, format, priority, key, role. The runner scales fractions to percent and stamps the unit on the column. The residue of kinds. | `"openbb:equity/price/quote:change_percent": { unit: fraction, format: change, label: "Chg %", priority: 2 }` |
| **Field config** | What every column carries into a view: role (`time`, `group`, `measure`, `label`, `level`, `x`), unit, label, format, priority, key. Three layers, later ones overriding: shape detection, annotations, the widget's own `fields`. Nothing reads a kind. | `fields: { pe: { label: "P/E (TTM)", unit: ratio } }` on a transform widget. |
| **Preset** | A pure function from view options and the datasets' field config to panes and layers (charts) or a control spec (tables, stats, facts, chains). The agent and the editor name a preset; the renderer knows marks and panes only. | `price`, `compare`, `curve`, `indicator`, `table`, `stat`, `facts`, `chain`, `heatmap`. |
| **View** | The preset with its options, as a widget stores it; also the React component that renders it. | `{ preset: 'price', candle: true, volume: true, events: 'events' }` |
| **Agent** | The planner that turns a prompt into a workspace with four tools: `find_route`, `query`, `transform`, `set_workspace`. | Given "Is NVDA's drop today news or just the market?", it runs `search`, then `ohlcv`, `quote` and `news` in parallel, then calls `set_workspace`. |

## More words contributors will meet

| Term | Definition | Example |
|---|---|---|
| **Preview** | The part of a frame the agent sees: columns with their units, row count, the rows (all when 25 or fewer, else the first 25), per-group per-numeric-column stats (`first`, `last`, `min`, `max`, `change`, `changePct`), lineage. Every number in a reply must come from a preview. | "Over three months MU is up A%": A is `stats.MU.close.changePct` from the 3-month `ohlcv` preview. |
| **Reply** | The agent's final text answer for a prompt, plain prose, beginning with the answer. | "NVDA is down X% today against SMH down Y% and SPY down Z%, so most of the move is sector." |
| **Verification** | The server's check of every figure in the reply against the run's previews, shown under the message. | `{ ok: true, checked: 4, matched: 4, unmatched: [] }` |
| **Chip** | A link in the reply to a widget. Written by the agent as `[[widget:<id>]]`; the web app renders it as a chip that scrolls to and flashes the widget. | The `[Memory names]` and `[Memory news]` links at the end of use case A's reply. |
| **Step** | One tool call shown in the conversation: tool, args, a one-line summary, duration, and an error if it failed. | `recipe ohlcv symbols=MU,SNDK,WDC,STX interval=1d range=3mo · 252 rows` |
| **Lineage** | Where a frame came from, in `meta.lineage`: connector, route, params and provider for a route; the recipe name and definition hash for a recipe; the code and the inputs' lineage for a transform. | A chip's widget shows exactly the derivation a reply quoted. |
| **Probe** | `pnpm probe` (or the Data page's button): one call per route with sample params, recording liveness; dead routes are hidden from the agent until the next probe. | 569 of 877 routes alive on the 2026-10-19 run. |
| **Registry** | The runner: validates a query, serves from cache, calls the connector or resolves the recipe's alternatives or runs the transform, applies annotations, stamps TTL and lineage. | `registry.run({ recipe: 'quote', params: { symbols: ['MU'] } })` |
| **Cache** | Frames by `canonicalKey` (`route:…`, `recipe:…`, `transform:…`) for the route's TTL, in memory and in SQLite. | A refreshed widget bypasses it. |

## What users see vs what contributors need

Users meet four words: **workspace** (the tab), **widget** (the chart or table), **recipe** (the saved queries on the Data page they can promote a widget to), and **connector** (the thing on the Data page that needs a key). The UI also shows **steps**, the **reply**, its **verification** and **chips**, but never names them.

Contributors need all of the above plus **route**, **descriptor**, **catalog**, **query**, **dataset**, **frame**, **shape**, **annotation**, **field config**, **preset**, **transform**, **agent** and **preview**, because those are the seams between packages:

- A connector author works with **descriptors** (what the connector answers), **routes** and **frames** (what `call` returns), and adds **annotations** for the fields a recipe will name. See `writing-a-connector.md`.
- A recipe author works with **routes** and their params, a **preset**, and pandas when the route's frame needs selecting or joining.
- A view author works with **field config** and **shapes** (what comes in) and **presets** (panes, layers, controls).
- The agent works with the **catalog**, **recipes**, **previews**, writes **replies** with **chips**, and emits **widgets** through `set_workspace`.

Related terms with fixed meanings in code: the **group column** is the column that splits a frame into lines or legend entries and keys the preview stats (`symbol` for most frames, `series` for macro, detected by the shape); percent columns are percent (`5.63`, not `0.0563`) once the annotations have run; **kind** was the v1 unit of data (a param schema plus exact columns), removed in v2 phase 3a (2026-10-19): the word survives only in the layout's `ContentHint.kind` (what a view renders: table, chart, stat, facts, chain), the chart marker kind, and the store's `kind` (sqlite, json).
