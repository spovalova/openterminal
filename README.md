<div align="center">

# Open Terminal

**The open-source, AI-native terminal for traders.**

Ask a question. Get a live workspace of charts, tables and option chains, and an answer that points at them.<br/>
Runs on your machine, with your keys, on data sources anyone can add.

[![License: MIT](https://img.shields.io/badge/license-MIT-0a0a0a.svg?style=flat-square)](LICENSE)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-0a0a0a.svg?style=flat-square)](package.json)
[![Local-first](https://img.shields.io/badge/local--first-no%20accounts%2C%20no%20backend-0a0a0a.svg?style=flat-square)](#quick-start)
[![Any route](https://img.shields.io/badge/data-any%20route%20%C2%B7%2024%20recipes%20%C2%B7%209%20presets-0a0a0a.svg?style=flat-square)](#data)

[Quick start](#quick-start) · [Why](#why) · [How it works](#how-it-works) · [Data](#data) · [Extend](#extend) · [Compare](#how-it-compares) · [Roadmap](#roadmap) · [Contributing](#contributing)

</div>

<br/>

![Ask "what's happening with memory?" and watch a workspace of five widgets build, then a reply that cites them](docs/recordings/a.gif)

<br/>

Cursor made the code editor conversational without taking the editor away. Open Terminal does the same for the trading terminal. The prompt builds and rewrites the workspace, and the workspace stays a real terminal: every widget is a query you can open, edit and re-run by hand.

## Why

- **Ask, don't click.** "Is NVDA's drop today news or just the market?" becomes four live widgets and a two-sentence diagnosis. A follow-up rewrites the workspace. You never assemble the answer from eight tabs again.
- **Every number is traceable.** The agent cannot type a price. It can only run queries, and the reply links each claim to the widget that shows it. Figures in the reply are checked against the frames it saw.
- **Open and local.** MIT licensed. One process on localhost plus your browser. No accounts, no hosted backend, no telemetry. Keys never leave the machine.
- **Any route, not a fixed catalog.** A connector publishes its routes as descriptors (OpenBB's 834 routes ship built in, answered in process by TypeScript ports of its providers); the agent searches them, runs them, and derives new frames from them with pandas. Twenty-four recipes cover the common questions; hand-written annotations keep the units honest.
- **Model-agnostic.** Anthropic or OpenAI through the Vercel AI SDK. The default is Claude Opus 5.5; change one line of config to swap it.
- **Works before you add a key.** OpenBB's keyless data providers are built in, ported to TypeScript: prices, option chains with Greeks and implied volatility, fundamentals, SEC filings, insider and institutional holdings, earnings and economic calendars, Treasury yields, Fed, BLS, OECD and IMF data, all with nothing to install. Yahoo is the fallback; a free Finnhub key adds another.

## How it works

```mermaid
flowchart LR
  P["Prompt"] --> A["Agent"]
  A -- "find_route" --> K["Catalog"]
  A -- "query {recipe | route}" --> R["Registry"]
  A -- "transform (pandas)" --> R
  R --> C1["openbb"]
  R --> C2["yahoo"]
  R --> C3["finnhub"]
  C1 & C2 & C3 -- "frame" --> R
  R -- "preview" --> A
  A -- "set_workspace" --> W["Workspace<br/>4 to 6 widgets"]
  A -- "reply + chips" --> W
```

1. You type a prompt. The agent has four tools: `find_route` searches the catalog of every connector's routes, `query` runs a recipe or a route, `transform` runs a pandas script over frames it already has, `set_workspace` replaces the widgets.
2. A query goes to the registry. A **recipe** names its route alternatives in order (OpenBB first, Yahoo as the fallback) and may hold a small data graph (fetch the whole chain, keep one expiration); a **route** is one endpoint of one connector, its params validated against the connector's descriptor. Results are frames: typed columns plus rows, annotated with units, cached per route.
3. The agent sees a preview of every frame it ran: the columns with their units, the first rows, and per-symbol stats. Numbers in the reply must come from here, and the server verifies them.
4. It emits a workspace, four to six widgets by default or the one or two you asked for, each a data graph rendered by a **preset**: `price`, `compare`, `curve`, `indicator`, `table`, `stat`, `facts`, `chain`, `heatmap`. Then a short reply that begins with the answer and carries chips linking to the widgets it drew on.
5. Widgets keep polling on a per-route TTL. Ask a follow-up and the workspace is rewritten. Everything is a workspace, including the one you keep for your morning check.

The nouns (workspace, widget, dataset, query, route, descriptor, catalog, recipe, transform, frame, shape, annotation, preset) are defined once in [docs/vocabulary.md](docs/vocabulary.md) and used exactly, in code, docs and commits.

<table>
<tr>
<td width="50%">

**"Is NVDA's drop today news or just the market?"**

NVDA against SPY and SMH on 5-minute bars, a candle chart, a quote table for the peers, and 24 hours of news. Reply: how much of the move is sector, and the one NVDA-specific headline.

![Use case B](docs/recordings/b.gif)

</td>
<td width="50%">

**"Morning check on my watchlist"**

A workspace you keep. Re-run the same prompt each day: pre-market quotes, who reports today, overnight news, SPY and QQQ for the week. The watchlist carries over from the last run.

![Use case C](docs/recordings/c.gif)

</td>
</tr>
</table>

## Quick start

The desktop app, for macOS, Windows and Linux:

```sh
curl -fsSL https://terminal.spova.ai/install | sh          # macOS, Linux
```

```powershell
irm https://terminal.spova.ai/install.ps1 | iex             # Windows (PowerShell)
```

Nothing else to install: the app carries its own runtime, the server, the web app, OpenBB's data providers (ported to TypeScript, below) and the Python runtime for transforms (Pyodide with pandas, numpy and scipy). Or download it from [Releases](https://github.com/spovalova/openterminal/releases/latest): `OpenTerminal-mac-arm64.dmg` (Apple silicon), `-mac-x64.dmg` (Intel), `-win-x64-setup.exe`, `-linux-x86_64.AppImage`, `-linux-amd64.deb` and the arm64 builds. The builds are not signed: the install script avoids the macOS and Windows warnings a browser download gets. The app works with no data keys: OpenBB's providers and Yahoo answer quotes, charts, search, option chains, fundamentals, filings, news and macro from inside it. The first time, it asks for an Anthropic or OpenAI key so the agent can answer; skip it to start with a sample workspace. Closing the window keeps it in the tray or menu bar; it updates itself from GitHub Releases.

With Node 22.13 or later, the same app runs in your browser:

```sh
npx openterminal
```

It opens `http://localhost:4242`. (The `openterminal` package is built and tested but not on npm yet; until it is, run it from source below.) The first start in a terminal asks for an Anthropic API key, hidden as you type; Enter skips. Then it says where everything is:

```
Anthropic API key for the agent (Enter to skip):
Saved to ~/.openterminal/config.yml (readable only by you).

  Open Terminal 0.1.0  http://127.0.0.1:4242

  connectors  openbb, yahoo, finnhub (off: add it on the Data page)
  agent       claude-opus-5-5 (anthropic)
  data        ~/.openterminal
  log         ~/.openterminal/openterminal.log

  ctrl-c to stop
```

Once a day it asks GitHub whether a newer release is out and says so in one line (no identifiers sent; `OPENTERMINAL_NO_UPDATE_CHECK=1` turns it off). `openterminal --help` lists the flags (`--port`, `--no-open`, `--verbose`, `--version`).

**From source**, with Node 22.13+ and pnpm: `git clone https://github.com/spovalova/openterminal && cd openterminal && pnpm install && pnpm --filter @openterminal/web build && node packages/cli/bin/openterminal.js`, or `pnpm dev` while you work on it.

**Add an LLM key** later, or an OpenAI one: paste it on the start screen, set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in your environment, or write it to `~/.openterminal/config.yml`:

```yaml
llm:
  provider: anthropic           # or openai
  model: claude-opus-5-5
  apiKey: sk-ant-...
```

Without one, the app explains how to add it and you can still build workspaces by hand in the widget editor (a recipe, a route from the catalog, or a transform).

**Add Finnhub** (optional) with a free [Finnhub](https://finnhub.io) key on the Data page in the app. It is saved to the same file and adds a second source for news, quotes and the earnings calendar.

**OpenBB's data, built in.** The `openbb` connector answers OpenBB Platform's routes itself: its providers are ported to TypeScript in [connectors/openbb-native](connectors/openbb-native/README.md) (Apache-2.0, like OpenBB since V5), so nothing is installed and no Python runs. 883 of OpenBB 5.0.0's 912 route-provider pairs are native, checked against OpenBB's own answers by parity tests that are recorded and replayed offline in CI (the FRED and EIA routes that need a key are checked against OpenBB's Python on sample responses until one is available). yfinance, nasdaq, cboe, sec, finra, federal_reserve, bls, oecd, imf, ecb, tmx and the rest need no key. FRED, EIA and older Congress.gov data need yours, in `config.yml`:

```yaml
connectors:
  - name: openbb
    config:
      credentials: { fred_api_key: ..., eia_api_key: ... }   # or FRED_API_KEY / EIA_API_KEY in the environment
```

The few routes not ported (CFTC's DTCC swap data, three Nasdaq Nordic fact-sheet routes, and pages that only answer a real browser) still work when a local [OpenBB Platform](https://docs.openbb.co/platform) API runs at `http://127.0.0.1:6900` (`pip install "openbb[routers]" openbb-yfinance`, then `openbb-api`); the connector sends them there and answers everything else itself. Details and per-route provider overrides: [connectors/openbb/README.md](connectors/openbb/README.md).

**Your data stays in `~/.openterminal`**: `config.yml`, the SQLite store (workspaces, your recipes, the frame cache) and the catalog cache. Set `OPENTERMINAL_HOME` to use another directory. A `~/.terminal` from before the rename is copied there on the first start and left in place.

## Data

Three connectors ship in the box. Each publishes the routes it answers as **descriptors** (path, params, providers, response fields), and the registry's **catalog** is the searchable union of them with a liveness record per route from `pnpm probe`.

| Connector | Key | Routes |
|---|---|---|
| `openbb` | none for the keyless providers | OpenBB Platform's 834 routes, answered in process by TypeScript ports of its 20 providers (883 of 912 route-provider pairs); a running OpenBB API adds the rest and any extension you install |
| `yahoo` | none | the five yahoo-finance2 endpoints: `search`, `quote`, `chart`, `options`, `quoteSummary` (with its modules), and `news` (the search module's news list) |
| `finnhub` | free | `quote`, `company-news`, `calendar/earnings` |

A query is a **route** (`{ connector, route, params }`), a **recipe** (`{ recipe, params }`), or a **transform** (`{ inputs, code }`, pandas in a Pyodide sandbox). Frames carry a field config per column (unit, label, format, priority) from the **annotations** in `packages/core/annotations.yml`, so a fraction from one provider and a percent from another both render and read as percent. Any route, plus these recipes:

<!-- recipes:start -->
| Recipe | Params | View | Reads | What it answers |
|---|---|---|---|---|
| `search` | q | table | openbb `equity/search`, yahoo `search` + transform | Resolve a free-text name or ticker to symbols. One query per call; batch by calling it in parallel. |
| `quote` | symbols[] | stat | yahoo `quote`, openbb `equity/price/quote`, finnhub `quote` | Latest price, day change, volume, market state and extended-hours price per symbol. |
| `ohlcv` | symbols[], interval?=1m\|5m\|15m\|1h\|…, range?=1d\|5d\|1mo\|3mo\|…, start? | price | openbb `equity/price/historical`, yahoo `chart` | Price bars per symbol over a range at an interval, long format with a symbol column. |
| `news` | symbols[], limit? | table | openbb `news/company`, yahoo `news`, finnhub `company-news` + transform | Recent headlines per symbol, newest first. |
| `earnings` | symbols[], from, to | table | openbb `equity/calendar/earnings`, yahoo `quoteSummary`, finnhub `calendar/earnings` + transform | Earnings dates inside a date window; session is bmo, amc or null. The market-wide calendar, cut to the symbols. |
| `profile` | symbols[] | facts | openbb `equity/profile`, yahoo `quoteSummary` | Who the company is: name, exchange, sector, industry, market cap, employees, beta, description. |
| `metrics` | symbols[] | table | openbb `equity/fundamental/metrics`, yahoo `quoteSummary` | Valuation and quality snapshot per symbol: multiples, margins, growth, returns, leverage, yield. |
| `financials` | symbols[], period?=annual\|quarter, limit? | table | openbb `equity/fundamental/income`, openbb `equity/fundamental/cash`, openbb `equity/fundamental/balance` + transform | Statement lines per fiscal period, newest first: income, cash flow and balance sheet joined on period_ending. |
| `estimates` | symbols[] | table | openbb `equity/estimates/consensus`, yahoo `quoteSummary`, openbb `yfinance/estimates/earnings` + transform | Analyst consensus per symbol: recommendation, analyst count, price targets with upside, EPS estimates. |
| `eps_history` | symbols[], limit? | table | openbb `equity/fundamental/historical_eps`, yahoo `quoteSummary` | Past earnings per symbol, newest first: reported EPS against the estimate and the surprise. |
| `dividends` | symbols[], limit? | table | openbb `equity/fundamental/dividends`, yahoo `chart` + transform | Dividend history per symbol, newest first: ex-dividend date and cash amount per share. |
| `insiders` | symbols[], limit? | table | openbb `equity/ownership/insider_trading`, yahoo `quoteSummary` + transform | Insider transactions per symbol, newest first. |
| `institutions` | symbols[], limit? | table | openbb `equity/ownership/institutional`, yahoo `quoteSummary` + transform | Largest institutional holders per symbol from the latest filings. |
| `short_interest` | symbols[], limit? | table | openbb `equity/shorts/short_interest`, yahoo `quoteSummary` + transform | Twice-monthly short interest per symbol, newest first: shares short, change, average volume, days to cover. |
| `options` | symbol, expiration?, strikes?, type?=call\|put\|both | chain | openbb `derivatives/options/chains`, yahoo `options` + transform | Option chain for one symbol at one expiration, a strike window around the underlying. |
| `volatility` | symbols[] | stat | openbb `equity/price/quote` + transform | Implied and realized volatility snapshot per symbol: 30-day IV with its one-year range, the hv30 range, the 52-week price range. |
| `calendar` | from, to, country? | table | openbb `economy/calendar` | Economic calendar inside a date window for one country. |
| `ipos` | from, to | table | openbb `equity/calendar/ipo` | IPOs priced or expected inside a date window. |
| `movers` | list?=gainers\|losers\|active, limit?, min_price? | table | openbb `equity/screener`, openbb `nasdaq/markets/movers` | Today's top gainers, losers or most active US stocks. |
| `holdings` | symbol | table | openbb `etf/holdings`, yahoo `quoteSummary` | Top holdings of one ETF: constituent symbol, name and weight. |
| `macro` | series=treasury_3m\|treasury_2y\|treasury_10y\|treasury_30y\|…, range?=1d\|5d\|1mo\|3mo\|… | compare | openbb `fixedincome/government/treasury_rates`, openbb `fixedincome/rate/effr`, openbb `fixedincome/rate/sofr`, openbb `economy/money_measures`, openbb `economy/cpi`, openbb `economy/unemployment` + transform | One macro series over a range: treasury yields, the 10y-2y spread, fed funds, SOFR, CPI YoY, unemployment, M2. One series per dataset; compare several as datasets of one widget. |
| `yield_curve` | date? | curve | openbb `fixedincome/government/yield_curve` + transform | US Treasury yield curve on one date (the latest when omitted): maturity, years and rate, shortest first. |
| `index` | symbol?, interval?=1m\|5m\|15m\|1h\|…, range?=1d\|5d\|1mo\|3mo\|…, start? | price | openbb `index/price/historical`, yahoo `chart` | An index's price history (^GSPC for the S&P 500, ^NDX, ^VIX); SPY, QQQ are the tradables. |
| `screener` | sector?, industry?, mktcap_min?, mktcap_max?, preset?, limit?, price_min? | table | openbb `equity/screener` | The whole market screened on yfinance: a sector (technology, healthcare, financial-services, energy, …), an industry, a market-cap floor or ceiling in dollars and a price floor, or a preset (day_gainers, most_actives, undervalued_large_caps, …). No P/E filter on the route: cut on trailingPE with a transform. |
<!-- recipes:end -->

The table is generated from `packages/core/recipes.yml` by `pnpm readme:recipes`; a test fails when it drifts. Recipes are data: a title template, a param schema, a preset, ordered route alternatives with param mappings, and optionally a data graph with a pandas step. Promote any widget you like to a user recipe from the Data page; it lands in `~/.openterminal/recipes.yml`.

Nine **presets** render any frame whose shape fits: `price` (candles or a line, volume, event markers, levels, bands), `compare` (lines, optionally rebased to 100), `curve` (a numeric x axis: yield curve, IV by strike), `indicator` (RSI, MACD, moving averages in their own panes), `table`, `stat` (one headline number per symbol with its change), `facts` (a one-row card), `chain` (calls, strikes, puts), `heatmap`.

## Extend

The whole plugin surface is one function. A connector is a package whose default export is `defineConnector`, with `descriptors()` (the routes it answers, as a JSON file or generated) and `call(route, params, ctx)`. Params arrive validated against the descriptor; `inferFrame` builds the frame from the provider's rows; the annotations say what the columns mean.

```ts
import { z } from 'zod'
import { defineConnector, inferFrame, parseDescriptors } from '@openterminal/core'
import descriptors from './descriptors.json' with { type: 'json' }

export default defineConnector({
  name: 'shape',
  config: z.object({ apiKey: z.string().min(1) }),
  descriptors: () => parseDescriptors(descriptors),
  call: async (route, params, ctx) => {
    const rows = (await ctx.http.get(`https://api.shape.dev/${route}?symbol=${params.symbol}`, { headers: { 'X-Token': ctx.config.apiKey }, signal: ctx.signal })) as Record<string, unknown>[]
    return inferFrame(rows, { connector: 'shape' }, { descriptor: descriptors.find((d) => d.route === route) })
  },
})
```

Register it in `~/.openterminal/config.yml`, and its routes are in the catalog on the next prompt. Tests run against recorded fixtures, never the network. The full guide, including the descriptor format, annotations, the OpenAPI generator, errors and fallback, and a worked example, is [docs/writing-a-connector.md](docs/writing-a-connector.md).

What else is open to change:

- **Models.** Any Anthropic or OpenAI model id the installed provider packages know. The agent prompt lives in `packages/server/src/agent/prompt.ts` and is plain text.
- **Recipes and annotations.** Data files: `packages/core/recipes.yml` and `packages/core/annotations.yml`, plus your own under `~/.openterminal/`. A new question that one route answers is a recipe, not code.
- **Presets.** In `packages/core/src/presets.ts`, a pure function from options and field config to panes and layers; the renderers in `packages/web/src/views` know marks and panes only.

## Development

Node 22 and pnpm.

```sh
pnpm install
pnpm dev          # server on :4242, web on :5173, UI preview on :5174
pnpm typecheck
pnpm lint
pnpm test         # Vitest; connectors run against recorded fixtures, never the network
pnpm query ohlcv symbols=AAPL,MSFT range=3mo                  # print a recipe's frame without the app
pnpm query options symbol=NVDA strikes=5
pnpm query openbb equity/price/quote symbol=NVDA provider=yfinance   # one route of one connector
pnpm query openbb --routes bond                               # search a connector's routes
pnpm probe        # call every route once and record liveness (OpenBB: about ten minutes at --concurrency=4)
pnpm bench        # run scripts/prompts.json against a running server and score the replies
pnpm release:bundle   # dist/release/lib: the whole app in one directory that runs on Node alone
pnpm release:npm      # dist/release/npm-pack/openterminal-<version>.tgz from that bundle (packed, not published)
pnpm release:smoke dist/release/lib   # start it on a spare port: health, the web app, one pandas transform
pnpm --filter @openterminal/desktop start     # the desktop app on that bundle (Electron, from source)
pnpm --filter @openterminal/desktop package   # its installers for this machine in packages/desktop/release
```

| Path | What lives there |
|---|---|
| `packages/core` | the contract: frames, descriptors, catalog, queries, recipes, annotations, shapes, presets, registry, protocol |
| `packages/server` | loader, HTTP and WebSocket API, SQLite store, transform engine (Pyodide), agent |
| `packages/ui` | design system |
| `packages/web` | React app, the editor and the Data page, views |
| `packages/cli` | the `npx openterminal` entry point |
| `packages/desktop` | the desktop app: Electron around the release bundle, its installers and updates |
| `connectors/*` | `openbb`, `yahoo`, `finnhub` |
| `deploy/` | systemd units for an always-on instance |
| `docs/` | [architecture](docs/architecture.md), [vocabulary](docs/vocabulary.md), [writing a connector](docs/writing-a-connector.md), probe and bench notes |

The plan, the decisions behind it, and the handoff for whoever works on it next are in [PLAN.md](PLAN.md). How a change becomes a PR, for people and agents alike, is in [docs/shipping.md](docs/shipping.md).

## How it compares

| | Open Terminal | Bloomberg | ChatGPT / Perplexity | OpenBB | Instinct |
|---|---|---|---|---|---|
| Ask a question, get live views | yes | no | no | partly | yes |
| Every number traceable to data | yes | yes | no | yes | unclear |
| Open source | yes (MIT) | no | no | partly | no |
| Runs locally, your keys | yes | no | no | partly | no |
| Add a data source yourself | yes | no | no | yes | no |
| Price | free | ~$25k/yr | $20/mo | free + paid | waitlist |

## Roadmap

Cut on purpose, each checked against the three use cases above. Add nothing back without a use case that needs it.

- Diff or accept/reject of agent edits: a prompt overwrites the workspace
- Dragging and resizing widgets: a CSS grid auto-packs widgets by size and content
- Real-time streaming (widgets poll on a per-route TTL)
- Plugin spine for views and agents: the loader is swappable later, `defineConnector` does not change
- Alerts (a transform with a condition over a dataset), automations, scheduling
- Order execution and broker connectors
- Crypto connectors and non-US tickers
- Auth, hosting, multi-user

## Contributing

The easiest contribution is a connector: a descriptor file and a `call`, tested against recorded fixtures. The next easiest is a recipe or an annotation: a few lines of YAML. Start with [docs/writing-a-connector.md](docs/writing-a-connector.md). Use the words in [docs/vocabulary.md](docs/vocabulary.md) exactly, in code, docs and commit messages. [docs/architecture.md](docs/architecture.md) is the tour for everything else.

## License

MIT.

Type: UI text is [Geist](https://vercel.com/font) (OFL, via Fontsource); numbers and code are [Ioskeley Mono](https://github.com/ahatem/IoskeleyMono) (OFL), an [Iosevka](https://typeof.net/Iosevka/) build vendored in `packages/ui/src/fonts`. A locally installed Berkeley Mono is used first when you have it.
