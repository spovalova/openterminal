# terminal

> "terminal" is a working name. The real name is undecided; the placeholder lives in one place (package scope and CLI bin) so renaming is one change.

An open-source, local-first, AI-native terminal for retail traders. You type a question. An agent turns it into a **workspace**: four to six **widgets**, each a live query against a **connector** rendered as a chart or table, plus a short reply that links to the widgets it is drawing on. Ask a follow-up and the workspace is rewritten. Everything runs on your machine with your own API keys. Connectors are plugins anyone can write in about 50 lines.

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

Keys never leave your machine. There are no accounts and no hosted backend.

## Development

Node 22 and pnpm.

```sh
pnpm install
pnpm dev          # server on :4242, web on :5173, UI preview on :5174
pnpm typecheck
pnpm test         # Vitest; connectors run against recorded fixtures, never the network
pnpm query ohlcv AAPL 1d 3mo    # print a frame from the registry without the app
```

`pnpm query` takes `search <terms…>`, `quote <symbols…>`, `ohlcv <symbols…> <interval> <range>`, `news <symbols…> [limit]`, or `earnings <symbols…> <from> <to>`.

Repo layout: `packages/core` (the contract: frame, kinds, widgets, registry, protocol), `packages/server` (loader, HTTP and WebSocket API, store, agent), `packages/ui` (design system), `packages/web` (React app and views), `packages/cli` (`npx terminal`), `connectors/yahoo` and `connectors/finnhub`. The full tour is in [docs/architecture.md](docs/architecture.md); the plan and the decisions behind it are in [PLAN.md](PLAN.md).

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
- More views (`stat`, `heatmap`, `text`, `list`, area series) and more kinds (`peers`, fundamentals, options flow, filings, economic calendar)
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

Kinds are fixed in v1. To propose a new one, open an issue with a use case the current five cannot serve, the param schema, and the columns.

## License

MIT.
