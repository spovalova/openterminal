# Vocabulary

The words used in code, docs, commit messages, and the UI. Use them exactly; do not introduce synonyms. The definitions come from PLAN.md section 3; the examples come from the three use cases in PLAN.md section 5.

## The seven nouns

| Term | Definition | Example |
|---|---|---|
| **Workspace** | A named tab holding a set of widgets and the conversation that produced them. Everything in the app is a workspace, including one created from a ticker. | The user keeps a workspace named **Morning** and re-runs "Morning check on my watchlist" in it every day. |
| **Widget** | One query rendered by one view, with a title and a size (`lg`, `md`, `sm`). Editable by hand or by the agent. | "Memory names, 3 months rebased": an `ohlcv` query for MU, SNDK, WDC, STX rendered by the `series` view with `normalize`, size `lg`. |
| **Query** | `{ kind, params }`. The kind names one contract from the catalog: a param schema plus the columns of the resulting frame. Widgets hold queries; connectors answer them. | `{ kind: 'ohlcv', params: { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' } }` |
| **Frame** | The only data shape that crosses from connector to view: typed columns plus rows, in long format with a `symbol` column. | The `quote` frame behind "Semis today": columns `symbol, price, change_pct, volume, market_state, extended_price, extended_change_pct`, one row per symbol. |
| **View** | A renderer for a frame: `series` or `table` in v1. Built into the web app. | "NVDA today" uses `series` with `candle`; "NVDA news, 24h" uses `table`. |
| **Connector** | A plugin that answers one or more kinds from an external source. Holds its own config (API key). Runs server-side. | `yahoo` answers `search`, `quote`, `ohlcv`, `earnings` with no key; `finnhub` answers `quote`, `news`, `earnings` with a free key. |
| **Agent** | The planner that turns a prompt into a workspace. | Given "Is NVDA's drop today news or just the market?", it runs `search`, then `ohlcv`, `quote`, and `news` in parallel, then calls `set_workspace`. |

## Four more words contributors will meet

| Term | Definition | Example |
|---|---|---|
| **Preview** | The part of a frame the agent sees: columns, row count, the rows (all of them when there are 25 or fewer, otherwise the first 25), and per-symbol, per-numeric-column stats (`first`, `last`, `min`, `max`, `changePct`). Every number in a reply must come from a preview. | "Over three months MU is up A%": A is `stats.MU.close.changePct` from the 3-month `ohlcv` preview. |
| **Reply** | The agent's final text answer for a prompt. | "NVDA is down X% today against SMH down Y% and SPY down Z%, so most of the move is sector." |
| **Chip** | A link in the reply to a widget. Written by the agent as `[[widget:<id>]]`; the web app renders it as a chip that scrolls to and flashes the widget. | The `[Memory names]` and `[Memory news]` links at the end of use case A's reply. |
| **Step** | One tool call shown in the conversation: tool, args, a one-line summary, duration, and an error if it failed. | `ohlcv MU, SNDK, WDC, STX 1d 3mo · 252 rows`, listed under the collapsible "Worked for 12s · 5 steps" header. |

## What users see vs what contributors need

Users meet three words: **workspace** (the tab), **widget** (the chart or table), and **connector** (the thing on the connectors page that needs a key). The UI also shows **steps**, the **reply**, and **chips**, but never names them.

Contributors need all of the above plus **query**, **frame**, **view**, **agent**, and **preview**, because those are the seams between packages:

- A connector author works with **query** (what comes in) and **frame** (what goes out). See `writing-a-connector.md`.
- A view author works with **frame** (what comes in) and **widget** (the title, size, and view options).
- The agent works with **previews**, writes **replies** with **chips**, and emits **widgets** through `set_workspace`.

Related terms with fixed meanings in code: a **kind** is one entry in the catalog (`search`, `quote`, `ohlcv`, `news`, `earnings`); the **registry** maps each kind to the ordered list of connectors that answer it; the **cache** holds frames by kind plus params for the kind's TTL.
