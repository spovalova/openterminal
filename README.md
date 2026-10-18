# terminal

> "terminal" is a working name. The real name is undecided; the placeholder lives in one place (package scope and CLI bin) so renaming is one change.

An open-source, local-first, AI-native terminal for retail traders. You type a question. An agent turns it into a **workspace**: a set of **widgets** (four to six by default, or the one or two you asked for), each a live query against a **connector** rendered by a **view** (a chart, a table, or an option chain), plus a short reply that begins with the answer and links to the widgets it is drawing on. Ask a follow-up and the workspace is rewritten. Everything runs on your machine with your own API keys. Connectors are plugins anyone can write in about 50 lines.

## What it looks like

Three prompts that v1 is built around. Each recording below is a real run against the live connectors and `claude-sonnet-5-5`, captured in headless Chromium.

### "What's happening with memory?"

Theme research. The agent resolves the basket (MU, SNDK, WDC, STX) and builds:

- Memory names, 3 months rebased (daily bars, normalized to 100, the hero widget)
- MU daily (candles, 6 months)
- Basket snapshot (quote table)
- Upcoming earnings (next 60 days)
- Memory news

Reply: "Over three months MU is up A%, SNDK B%, WDC C%, STX D%. MU reports on DATE. Recent news clusters around HBM demand and contract pricing." with chips to the chart and the news table. Every figure comes from a query the agent ran.

![Use case A: a memory theme workspace being built from the prompt](docs/recordings/a.gif)

### "Is NVDA's drop today news or just the market?"

Event diagnosis. The agent names the peers (AMD, AVGO, TSM, SMH, SPY) and builds:

- NVDA vs SPY vs SMH today (5-minute bars, normalized)
- NVDA today (5-minute candles)
- Semis today (quote table for NVDA, peers, SPY, SMH)
- NVDA news, 24h

Reply: "NVDA is down X% today against SMH down Y% and SPY down Z%, so most of the move is sector. The only NVDA-specific headline in the last 24h is ..." with chips.

![Use case B: NVDA against SPY and SMH, intraday, with a diagnosis](docs/recordings/b.gif)

### "Morning check on my watchlist"

Recurring monitoring. You keep a workspace named Morning and re-run the same prompt each day; the watchlist is the symbols in the prompt or already in the workspace. It builds:

- Watchlist pre-market (quote table, plus SPY and QQQ)
- Reporting today (earnings)
- Overnight news
- SPY and QQQ, 5 days

Reply: "Three names are moving pre-market: ... X reports before the open. SPY and QQQ are flat pre-market." with chips.

![Use case C: a watchlist morning check](docs/recordings/c.gif)

## Quick start

```sh
npx terminal
```

This starts one local process and opens `http://localhost:4242`. It works with no keys: price, chart, search, and earnings data come from Yahoo through the built-in `yahoo` connector.

To get the agent, add an LLM key. Either set `ANTHROPIC_API_KEY` in your environment or write it to `~/.terminal/config.yml`:

```yaml
llm:
  provider: anthropic           # or openai
  model: <a current Claude Sonnet model id>
  apiKey: sk-ant-...
```

Without an LLM key the app explains how to add one and you can still build workspaces by hand with the add-widget form.

For news, add a free Finnhub key on the connectors page in the app (it is saved to the same `config.yml`). Finnhub also answers quotes and earnings, so price tables survive a Yahoo outage.

### More data with OpenBB

The `openbb` connector answers every kind in the catalog through a locally running [OpenBB Platform](https://docs.openbb.co/platform) API, which is the on-ramp to its providers: yfinance, nasdaq, cboe and sec with no key; FMP, Polygon, Intrinio, Tiingo and others with keys you keep on the OpenBB side. It is listed first in the default config, so when the API is running every query goes to it and yahoo and finnhub become fallbacks; when it is not, the miss costs nothing. Two commands:

```sh
pip install "openbb[routers]" openbb-yfinance
openbb-api
```

Python 3.10 to 3.12. The Connectors page shows `not running` with those commands until the API answers at `http://127.0.0.1:6900`. OpenBB is AGPL-3.0 and runs as its own process; this repo only sends it HTTP requests. Details and per-kind provider overrides: [connectors/openbb/README.md](connectors/openbb/README.md).

Keys never leave your machine. There are no accounts and no hosted backend.

## Development

Node 22 and pnpm.

```sh
pnpm install
pnpm dev          # server on :4242, web on :5173, UI preview on :5174
pnpm typecheck
pnpm test         # Vitest; connectors run against recorded fixtures, never the network
pnpm query ohlcv AAPL 1d 3mo    # print a frame from the registry without the app
pnpm query options symbol=NVDA strikes=5
pnpm query macro series=treasury_10y,treasury_2y range=2y
pnpm bench                      # run scripts/prompts.json against a running server
```

`pnpm query <kind> key=value …` works for every kind (comma lists become arrays, numbers become numbers; `pnpm query --help` lists the params of each kind). The five v1 kinds also keep their positional forms: `search <terms…>`, `quote <symbols…>`, `ohlcv <symbols…> <interval> <range>`, `news <symbols…> [limit]`, `earnings <symbols…> <from> <to>`.

Repo layout: `packages/core` (the contract: frame, kinds, widgets, registry, protocol), `packages/server` (loader, HTTP and WebSocket API, store, agent), `packages/ui` (design system), `packages/web` (React app and views), `packages/cli` (`npx terminal`), `connectors/openbb`, `connectors/yahoo` and `connectors/finnhub`. The full tour is in [docs/architecture.md](docs/architecture.md); the plan and the decisions behind it are in [PLAN.md](PLAN.md).

## Kinds and views

A **query** is `{ kind, params }`. A kind is one contract from the catalog in `packages/core/src/kinds.ts`: a param schema plus the exact columns of the resulting **frame**. 22 kinds, grouped as in PLAN.md section 14:

| Group | Kind | Params | Frame columns |
|---|---|---|---|
| v1 | `search` | q[] | query, symbol, name, exchange |
| | `quote` | symbols[] | symbol, price, change_pct, volume, market_state, extended_price, extended_change_pct |
| | `ohlcv` | symbols[], interval (1m 5m 15m 1h 1d 1w), range (1d 5d 1mo 3mo 6mo 1y 2y 5y) | symbol, time, open, high, low, close, volume |
| | `news` | symbols[], limit | time, headline, source, url, symbol |
| | `earnings` | symbols[], from, to | symbol, date, session, eps_estimate |
| company | `profile` | symbols[] | symbol, name, exchange, sector, industry, market_cap, employees, beta, description |
| | `metrics` | symbols[] | symbol, market_cap, pe, forward_pe, peg, ev_ebitda, ps, pb, gross_margin, operating_margin, profit_margin, revenue_growth, earnings_growth, roe, debt_to_equity, dividend_yield |
| | `financials` | symbols[], period (annual, quarter), limit | symbol, period_ending, revenue, gross_profit, operating_income, net_income, eps, operating_cash_flow, capex, free_cash_flow, cash, debt, shares |
| | `estimates` | symbols[] | symbol, recommendation, analysts, target_low, target_consensus, target_high, upside_pct, eps_estimate_q, eps_estimate_y, eps_growth_y |
| | `eps_history` | symbols[], limit | symbol, date, eps_actual, eps_estimate, surprise_pct |
| | `dividends` | symbols[], limit | symbol, ex_date, amount |
| ownership | `insiders` | symbols[], limit | symbol, date, name, title, action, shares, price, value, url |
| | `institutions` | symbols[], limit | symbol, date, holder, shares, change_pct, value |
| | `short_interest` | symbols[], limit | symbol, date, short_interest, change_pct, avg_volume, days_to_cover |
| options | `options` | symbol, expiration?, strikes, type (call, put, both) | symbol, expiration, type, strike, bid, ask, last, volume, open_interest, iv, delta, gamma, theta, vega, underlying_price, dte |
| | `volatility` | symbols[] | symbol, iv30, iv30_high, iv30_low, iv_rank, hv30, hv30_high, hv30_low, year_high, year_low |
| market-wide | `calendar` | from, to, country | time, country, event, actual, consensus, previous |
| | `ipos` | from, to | symbol, date, name, exchange, price, offer_amount, status |
| | `movers` | list (gainers, losers, active), limit, min_price (default 5) | symbol, name, price, change_pct, volume |
| | `holdings` | symbol (an ETF) | etf, symbol, name, weight |
| | `macro` | series[] (treasury_3m, treasury_2y, treasury_10y, treasury_30y, spread_10y_2y, fed_funds, sofr, cpi_yoy, unemployment, m2), range | series, time, value |
| | `yield_curve` | date? | date, maturity, years, rate |

Frames are long format: multi-symbol results carry a `symbol` column; `macro` carries `series` instead. `search`, `calendar`, `ipos`, `movers`, `macro` and `yield_curve` take no symbols; `options` and `holdings` take exactly one. Percent columns are percent (5.63, not 0.0563).

Three **views**: `series` (for `ohlcv` and `macro`; `candle` and `normalize` only for `ohlcv`), `table` (any kind), `chain` (only `options`: calls on the left, strikes in the middle, puts on the right, the underlying price marked).

## How it compares

- **Bloomberg** connects everything, for $25k a year, behind a 1980s UI. This is free, local, and open.
- **ChatGPT / Perplexity** answer in prose with no live views and numbers you cannot trust. Here every number in the reply comes from a query the agent ran, and the reply links to the live widget that shows it.
- **OpenBB** open-sourced the data layer but sells the workspace and is drifting to institutions. Here the workspace is the open part.
- **Instinct** is the right shape but closed, waitlisted, and crypto-first. This is open, local, and starts with US equities.

## Not in v1

Deliberately cut, each checked against the three use cases above. Add nothing back without a use case that needs it.

- Diff or accept/reject of agent edits: a prompt overwrites the workspace instead
- Home and Feed pages, a Save button, a watchlist feature: everything is a workspace
- Dragging and resizing widgets: a CSS grid auto-packs them by size
- More views (`stat`, `heatmap`, `text`, `list`, area series) and kinds beyond the catalog below (`peers`, options flow, filings, transcripts, screeners with arbitrary conditions, technical indicators)
- Multi-query widgets
- Real-time streaming: widgets poll on a per-kind TTL
- Plugin spine (cordis), views and agents as plugins: the loader is swappable later, `defineConnector` does not change
- Alerts, automations, scheduling
- Order execution and broker connectors
- Crypto connectors and non-US tickers
- Auto-generated settings forms: the connectors page has one key field per connector
- Desktop packaging, auth, hosting, multi-user

## Contributing

The easiest contribution is a connector: one file, about 50 lines, tested against recorded fixtures. Start with [docs/writing-a-connector.md](docs/writing-a-connector.md). Use the words in [docs/vocabulary.md](docs/vocabulary.md) exactly, in code, docs, and commit messages. [docs/architecture.md](docs/architecture.md) is the tour for everything else.

Kinds are fixed per release. To propose a new one, open an issue with a use case the current 22 cannot serve, the param schema, and the columns.

## License

MIT.
