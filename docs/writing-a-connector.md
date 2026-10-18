# Writing a connector

A connector is a plugin that answers one or more **kinds** (22 in the catalog, from `quote` to `yield_curve`) from an external source and returns a **frame**. It runs inside the server process, holds its own config (usually an API key), and is about 50 lines per kind. This page is everything you need; the only other file worth opening is `packages/core/src/kinds.ts`, which the catalog below is copied from.

Contents: [the contract](#the-contract) · [the ctx](#the-ctx) · [frames and toFrame](#frames-and-toframe) · [kind catalog](#kind-catalog) · [adding a handler for a new kind](#adding-a-handler-for-a-new-kind) · [errors and fallback](#errors-and-fallback) · [column validation](#how-the-registry-validates-a-frame) · [config](#config) · [testing with fixtures](#testing-with-recorded-fixtures) · [worked example](#worked-example-a-quote-connector) · [package layout and registration](#package-layout-and-registration) · [v1 limits](#v1-limits)

## The contract

One helper, `defineConnector`, imported from `@terminal/core`. It takes a name, a Zod config schema, and a `queries` object keyed by kind. The default export of your package is the result.

```ts
// connectors/shape/src/index.ts
import { z } from 'zod'
import { defineConnector, toFrame } from '@terminal/core'

export default defineConnector({
  // Unique, lowercase kebab-case. Used in config.yml and stamped into frame.meta.connector.
  name: 'shape',
  // Zod schema for the connector's config. Use z.object({}) when it needs none.
  config: z.object({ apiKey: z.string().min(1) }),
  // One async handler per kind you answer. Params arrive already validated against the catalog.
  queries: {
    quote: async (params, ctx) => {
      const rows = params.symbols.map((symbol) => ({ symbol, price: 1, change_pct: 0, volume: 0, market_state: 'CLOSED' }))
      return toFrame('quote', rows, { connector: 'shape' })
    },
  },
})
```

What `defineConnector` does:

- Checks the name against `/^[a-z][a-z0-9-]*$/` and throws otherwise.
- Derives `kinds` (the list of kinds you answer, in catalog order) from the keys of `queries`. Answering no kinds is an error.
- Types each handler: `queries.quote` receives `{ symbols: string[] }`, `queries.ohlcv` receives `{ symbols, interval, range }`, `queries.options` receives `{ symbol, expiration?, strikes, type }`, `queries.macro` receives `{ series, range }`, and so on, with defaults already applied (`news.limit` is always a number, `options.type` is always set). `ctx.config` is typed by your config schema.

The exact types, from `packages/core/src/connector.ts`:

```ts
type Handler<P, C> = (params: P, ctx: Ctx<C>) => Promise<Frame>

type ConnectorDef<C> = {
  name: string
  config: z.ZodType<C, any>
  queries: { [K in Kind]?: Handler<KindParams<K>, C> }
}

function defineConnector<C>(def: ConnectorDef<C>): Connector<C>   // Connector = ConnectorDef & { kinds: Kind[] }
```

You do not call the handlers yourself. The server builds a registry, registers each configured connector with its config, and the registry calls your handler when a query for that kind arrives.

## The ctx

The second argument to every handler.

```ts
type Ctx<C> = {
  http: { get(url: string, init?: RequestInit): Promise<unknown> }
  config: C
  log(msg: string): void
  signal?: AbortSignal
}
```

- **`http.get(url, init?)`**: GET the URL and parse the body as JSON; returns the raw text when the body is not JSON. Throws `HttpError` (`status`, `url`, `body` truncated to 500 chars) on any non-2xx status. Use it for every request so tests can swap in a fake (see [testing](#testing-with-recorded-fixtures)). Put headers in `init` (`{ headers: { 'X-Token': config.apiKey } }`). The return type is `unknown`; cast or validate it to your API's shape.
- **`config`**: the parsed output of your config schema. Keys live here and nowhere else.
- **`log(msg)`**: one line to the server log, prefixed with your connector name. Use it for per-symbol failures and anything you would otherwise `console.log`.
- **`signal`**: an `AbortSignal` when the run can be cancelled (the user hit cancel, or the registry gave up). Pass it through: `http.get(url, { signal })`.

If your source has an official SDK (yahoo-finance2, for example) you may use it instead of `http.get`; then your tests need to mock the SDK rather than `http`. Prefer `http.get` for plain JSON APIs.

## Frames and toFrame

A frame is the only data shape that crosses from a connector to a view:

```ts
type Column = { name: string; type: 'string' | 'number' | 'time' | 'boolean' }
type Frame = { columns: Column[]; rows: unknown[][]; meta: { connector: string; fetchedAt: number; ttl: number } }
```

Build one with `toFrame(kind, rows, meta?)`, where `rows` is an array of plain objects keyed by column name:

- Columns come from the catalog for that kind, in catalog order. You cannot add, rename, or reorder columns.
- A missing or `undefined` field becomes `null`. Extra fields are dropped.
- `meta.connector` defaults to `'unknown'`, so pass `{ connector: '<your name>' }`; `meta.fetchedAt` defaults to now; `meta.ttl` defaults to the kind's catalog TTL. The registry restamps `connector` and `ttl` anyway, so the meta you pass matters only for frames used outside the registry (tests, scripts).

Conventions every frame must follow (`packages/core/src/frame.ts`):

| Convention | Meaning |
|---|---|
| Long format | Multi-symbol results are one row per (symbol, …) with a `symbol` column. Never one column per symbol. `macro` is one row per (series, time) with a `series` column instead. |
| `symbol` column | The symbol as the user asked for it, upper case (`MU`, `BRK-B` as given). Every `symbols[]` kind is keyed on it; `options` repeats its one `symbol` on every row; `holdings` puts the ETF in `etf` and each constituent in `symbol`. |
| Percent columns | Percent is percent: `5.63` means 5.63%, never `0.0563`. This covers `change_pct`, `extended_change_pct`, `upside_pct`, `surprise_pct`, every margin, growth, `roe` and `dividend_yield` in `metrics`, `iv` and everything in `volatility`, `weight` in `holdings`, and the rates, CPI and unemployment series in `macro` and `yield_curve`. Scale in the connector; the views and the agent do not. |
| `time` is epoch ms | Columns of type `time` hold a JavaScript number (`date.getTime()`), never a `Date`, an ISO string, or seconds. Convert at the edge; `toFrame` does not convert for you and the registry does not check cell types, so a `Date` will reach the view and break it. |
| Null cells | Any cell may be `null` when the source has no value. The column type is the nominal type. Use `null`, not `undefined`, `NaN`, `0`, or `''`. |
| `ohlcv` sorted | Rows sorted by symbol, then by time ascending. Drop bars with a null `close`. |
| `news` newest first | Rows sorted by `time` descending across all symbols. Respect `limit` as a total, not per symbol. |
| `earnings.date` | `YYYY-MM-DD` in America/New_York. `session` is `'bmo'`, `'amc'`, or `null`. Other date-only columns (`period_ending`, `ex_date`, `expiration`, `eps_history.date`, `yield_curve.date`) are `YYYY-MM-DD` strings too. |
| Newest first | `financials`, `eps_history`, `dividends`, `insiders`, `institutions`, `short_interest` are sorted newest first and cut to `limit` per symbol. |
| `options` | One expiration, `strikes` strikes each side of `underlying_price`, sorted by `type` then `strike`. Snap `expiration` forward to the first listed date on or after it; when omitted, use the nearest expiration at least 7 days out. |
| `macro` and `yield_curve` | `macro` rows sorted by series then time; `yield_curve` sorted by `years` ascending, with `maturity` the source's label (`1M`, `2Y`, `10Y`). |
| `quote.market_state` | Use `PRE`, `REGULAR`, `POST`, `CLOSED`. `extended_price` and `extended_change_pct` are the pre- or post-market values when the source has them, else `null`. |
| `search` | One row per input term with `query` set to the term as given, so the caller can match results back. US equities and ETFs only; first hit wins. |

Sort and filter in the connector. The registry and the views assume the conventions hold.

## Kind catalog

Copied from `packages/core/src/kinds.ts` (PLAN.md section 7.1). Each kind is a param schema plus the exact columns of its frame. Most kinds take `symbols[]` (1 to 50). `options` and `holdings` take exactly one `symbol`. `search` takes `q[]`; `calendar`, `ipos`, `movers`, `macro` and `yield_curve` take no symbols at all. `limit` is per symbol, newest first.

**v1**

| Kind | What it answers | Params (type, constraints, default) | Columns (name: type, in order) | Cache TTL |
|---|---|---|---|---|
| `search` | Resolve free-text names or tickers to symbols. One call per batch of terms. | `q: string[]` (1–50 terms, each trimmed and non-empty) | `query: string`, `symbol: string`, `name: string`, `exchange: string` | 1 day |
| `quote` | Latest price, day change, volume, market state, extended-hours price per symbol. | `symbols: string[]` (1–50, each 1–16 chars) | `symbol: string`, `price: number`, `change_pct: number`, `volume: number`, `market_state: string`, `extended_price: number`, `extended_change_pct: number` | 10 s |
| `ohlcv` | Price bars per symbol over a range at an interval. | `symbols: string[]`; `interval: '1m' \| '5m' \| '15m' \| '1h' \| '1d' \| '1w'`; `range: '1d' \| '5d' \| '1mo' \| '3mo' \| '6mo' \| '1y' \| '2y' \| '5y'` | `symbol: string`, `time: time`, `open: number`, `high: number`, `low: number`, `close: number`, `volume: number` | 60 s for `1m 5m 15m 1h`; 10 min for `1d 1w` |
| `news` | Recent headlines per symbol, newest first. | `symbols: string[]`; `limit: number` (integer 1–100, default 20) | `time: time`, `headline: string`, `source: string`, `url: string`, `symbol: string` | 2 min |
| `earnings` | Earnings dates per symbol inside a date window. | `symbols: string[]`; `from: 'YYYY-MM-DD'`; `to: 'YYYY-MM-DD'` (inclusive) | `symbol: string`, `date: string`, `session: string`, `eps_estimate: number` | 1 hour |

**company**

| Kind | What it answers | Params | Columns (name: type, in order) | Cache TTL |
|---|---|---|---|---|
| `profile` | Who the company is. | `symbols: string[]` | `symbol: string`, `name: string`, `exchange: string`, `sector: string`, `industry: string`, `market_cap: number`, `employees: number`, `beta: number`, `description: string` | 1 day |
| `metrics` | Valuation and quality snapshot: multiples, margins, growth, returns, leverage, yield. | `symbols: string[]` | `symbol: string`, `market_cap: number`, `pe: number`, `forward_pe: number`, `peg: number`, `ev_ebitda: number`, `ps: number`, `pb: number`, `gross_margin: number`, `operating_margin: number`, `profit_margin: number`, `revenue_growth: number`, `earnings_growth: number`, `roe: number`, `debt_to_equity: number`, `dividend_yield: number` | 1 hour |
| `financials` | Statement lines per fiscal period, newest first. Amounts in the reporting currency, not scaled. | `symbols: string[]`; `period: 'annual' \| 'quarter'` (default quarter); `limit: number` (1–5, default 4) | `symbol: string`, `period_ending: string`, `revenue: number`, `gross_profit: number`, `operating_income: number`, `net_income: number`, `eps: number`, `operating_cash_flow: number`, `capex: number`, `free_cash_flow: number`, `cash: number`, `debt: number`, `shares: number` | 1 day |
| `estimates` | Analyst consensus: recommendation, count, price targets, EPS estimates. | `symbols: string[]` | `symbol: string`, `recommendation: string`, `analysts: number`, `target_low: number`, `target_consensus: number`, `target_high: number`, `upside_pct: number`, `eps_estimate_q: number`, `eps_estimate_y: number`, `eps_growth_y: number` | 1 hour |
| `eps_history` | Past EPS against the estimate, newest first. Future dates carry the estimate only. | `symbols: string[]`; `limit: number` (1–20, default 8) | `symbol: string`, `date: string`, `eps_actual: number`, `eps_estimate: number`, `surprise_pct: number` | 1 day |
| `dividends` | Dividend history, newest first. | `symbols: string[]`; `limit: number` (1–60, default 12) | `symbol: string`, `ex_date: string`, `amount: number` | 1 day |

**ownership**

| Kind | What it answers | Params | Columns (name: type, in order) | Cache TTL |
|---|---|---|---|---|
| `insiders` | Insider transactions, newest first. `action` is `buy`, `sell`, `grant`, or `other`; `value` is shares times price. | `symbols: string[]`; `limit: number` (1–100, default 20) | `symbol: string`, `date: string`, `name: string`, `title: string`, `action: string`, `shares: number`, `price: number`, `value: number`, `url: string` | 1 hour |
| `institutions` | Largest institutional holders from the latest filings. | `symbols: string[]`; `limit: number` (1–50, default 20) | `symbol: string`, `date: string`, `holder: string`, `shares: number`, `change_pct: number`, `value: number` | 1 day |
| `short_interest` | Twice-monthly short interest, newest first. | `symbols: string[]`; `limit: number` (1–60, default 12) | `symbol: string`, `date: string`, `short_interest: number`, `change_pct: number`, `avg_volume: number`, `days_to_cover: number` | 1 day |

**options**

| Kind | What it answers | Params | Columns (name: type, in order) | Cache TTL |
|---|---|---|---|---|
| `options` | Option chain for one symbol at one expiration, the `strikes` nearest strikes each side of the underlying. | `symbol: string`; `expiration?: 'YYYY-MM-DD'`; `strikes: number` (1–30, default 10); `type: 'call' \| 'put' \| 'both'` (default both) | `symbol: string`, `expiration: string`, `type: string`, `strike: number`, `bid: number`, `ask: number`, `last: number`, `volume: number`, `open_interest: number`, `iv: number`, `delta: number`, `gamma: number`, `theta: number`, `vega: number`, `underlying_price: number`, `dte: number` | 60 s |
| `volatility` | Implied and realized volatility snapshot, all percent. | `symbols: string[]` | `symbol: string`, `iv30: number`, `iv30_high: number`, `iv30_low: number`, `iv_rank: number`, `hv30: number`, `hv30_high: number`, `hv30_low: number`, `year_high: number`, `year_low: number` | 10 min |

**market-wide** (no `symbols[]`)

| Kind | What it answers | Params | Columns (name: type, in order) | Cache TTL |
|---|---|---|---|---|
| `calendar` | Economic calendar inside a date window for one country. `actual`, `consensus`, `previous` as the source prints them. | `from`, `to: 'YYYY-MM-DD'`; `country: string` (default United States) | `time: time`, `country: string`, `event: string`, `actual: string`, `consensus: string`, `previous: string` | 1 hour |
| `ipos` | IPOs priced or expected inside a date window. | `from`, `to: 'YYYY-MM-DD'` | `symbol: string`, `date: string`, `name: string`, `exchange: string`, `price: number`, `offer_amount: number`, `status: string` | 1 hour |
| `movers` | Today's top gainers, losers, or most active US stocks. | `list: 'gainers' \| 'losers' \| 'active'` (default gainers); `limit: number` (1–50, default 20); `min_price: number` (default 5, 0 for the raw list) | `symbol: string`, `name: string`, `price: number`, `change_pct: number`, `volume: number` | 60 s |
| `holdings` | Top holdings of one ETF. | `symbol: string` (the ETF) | `etf: string`, `symbol: string`, `name: string`, `weight: number` | 1 day |
| `macro` | Daily or monthly macro series over a range, one row per (series, time). | `series: MacroSeries[]` (1–6 of `treasury_3m`, `treasury_2y`, `treasury_10y`, `treasury_30y`, `spread_10y_2y`, `fed_funds`, `sofr`, `cpi_yoy`, `unemployment`, `m2`); `range` (default 1y) | `series: string`, `time: time`, `value: number` | 1 hour |
| `yield_curve` | US Treasury yield curve on one date (the latest when omitted), shortest first. | `date?: 'YYYY-MM-DD'` | `date: string`, `maturity: string`, `years: number`, `rate: number` | 1 hour |

`change_pct` and `extended_change_pct` in a `quote` are the day change (`-1.3` means down 1.3%); the agent uses them for "down X% today" and uses `ohlcv` previews for changes over a range. `volume` is shares.

Notes on `ohlcv` ranges: `1d` means the last trading session, not the last 24 hours (after the close, now minus 24 h spans two sessions). Return regular-session bars only unless your source cannot separate them. A live, partial last bar is fine.

The TTLs are the registry's, not yours: the cache holds a frame for the kind's TTL and your handler is not called again until it expires or the user hits refresh.

## Adding a handler for a new kind

To make an existing connector answer one more kind, add one entry to `queries`. Nothing else changes: `kinds` is derived from the keys, the registry starts routing that kind to you in config order, and the agent's prompt lists it as answerable.

1. Read the kind in `packages/core/src/kinds.ts`: its params (what you receive, defaults applied) and its columns (what you must return, in order). The catalog is the contract; do not add, rename, or reorder columns.
2. Find the source route and record one real response into `test/fixtures/<kind>-<SYMBOL>.json` (or `<kind>.json` for a symbol-less kind).
3. Write the handler. Map every column explicitly, `null` for what the source lacks. Scale percents (a source that prints `0.0563` becomes `5.63`). Convert times to epoch ms and dates to `YYYY-MM-DD`. Sort as the conventions table says and cut to `limit` per symbol.
4. Write the fixture test through a `ConnectorRegistry` so column validation runs, plus one failure case.
5. Run `pnpm query <kind> key=value …` against the live source (`pnpm query options symbol=NVDA strikes=5`, `pnpm query macro series=treasury_10y,treasury_2y`), then add the kind to the connector's row in PLAN.md section 7.3.

Three rules that decide the shape of a handler:

**Symbol-less and single-symbol kinds.** `calendar`, `ipos`, `movers`, `macro` and `yield_curve` have no `symbols[]`: one request, one frame, no fan-out. `options` and `holdings` take one `symbol`: one request each; repeat the symbol on every row (`options.symbol`, `holdings.etf`). `macro` takes `series[]` and fans out per series the way a `symbols[]` kind fans out per symbol; its rows carry `series` instead of `symbol`, and the preview and the `series` view group by it.

**Throw vs partial.** For a `symbols[]` (or `series[]`) kind, a partial frame is a valid answer: fan out with `Promise.allSettled`, `ctx.log` each failure, return the rows you got, and throw only when every symbol failed. For a symbol-less or single-symbol kind there is nothing to be partial about: return the frame when the source answered (an empty frame is a correct "nothing in this window") and throw when it did not, so the registry can fall through to the next connector. Never turn a source error into an empty frame; it gets cached for the TTL and stops the fallback.

**Percent convention.** Every percent column is percent, scaled in the connector. The agent reads previews literally and the table formats append `%`; a fraction would show as `0.06%` and be quoted that way.

## Health (optional)

A connector that depends on a local service can add a `health` probe next to `queries`:

```ts
health: async (ctx) => {
  await ctx.http.get(`${ctx.config.baseUrl}/api/v1/coverage/providers`, { signal: ctx.signal })
  return `OpenBB API at ${ctx.config.baseUrl}` // one line for the Connectors page, or return nothing
},
```

The registry runs it with a 2 s timeout when the Connectors page loads, never on the query path. Resolve with a short detail string or nothing; throw with a message that tells the user what to do (`connectors/openbb` throws the two install commands). A connector without a probe is simply `ok` once its config parses. The page shows a failing probe as `not running`.

## Errors and fallback

The registry tries connectors in config order and falls back to the next one when a handler throws. So:

- **One symbol failing must not sink the others.** Fan out per symbol with `Promise.allSettled`, `ctx.log` each failure, and return the rows you got. A frame with fewer symbols than asked is a valid answer.
- **Throw when you cannot answer at all**: every symbol failed, the key was rejected (`HttpError` with status 401 or 403), the source is down. Throw an `Error` with a message a human can read; it is logged as `[<name>] <kind> failed: <message>` and shown on the widget if every connector fails.
- **Do not catch and return an empty frame** when the source errored. An empty frame is a successful "nothing matched" (no earnings in the window, no news), gets cached for the TTL, and stops the fallback.
- **Do not retry forever.** One retry on a 429 or 5xx is reasonable; more than that holds up the whole workspace. Respect `ctx.signal`.
- **Do not throw on an unknown symbol** when other symbols worked; log it and skip the row.

What the registry does with your handler's result or error (`packages/core/src/registry.ts`):

1. Parses and normalizes the query. Invalid params never reach you.
2. Serves from cache when a fresh frame exists (unless the caller bypassed the cache, which refresh does).
3. For each connector with status `ok` that answers the kind, in config order: calls the handler with `{ ...ctx, signal }`; on success validates the frame (below) and caches it; on a throw, records the cause, logs it, and moves on. If the signal is already aborted it stops.
4. If every connector failed, throws `RegistryError` whose message lists every cause (`quote failed on every connector: finnhub: HTTP 401 … | yahoo: …`).

A frame that fails column validation counts as a throw, so a wrong shape falls through to the next connector too.

## How the registry validates a frame

`validateFrame` checks that your frame's `columns` match the catalog exactly: same length, same names, same types, same order. Then it checks that every row has exactly as many cells as there are columns. It does not check cell types (a string in a `number` column passes validation and breaks the view), so keep the conventions above yourself. Finally it restamps `meta`: `connector` becomes your connector's name, `ttl` becomes the catalog TTL for the query, `fetchedAt` is kept.

Using `toFrame` makes the column check pass by construction. Only hand-built frames can fail it.

## Config

Connectors are listed in `~/.terminal/config.yml` (override the directory with `TERMINAL_HOME`). Order is routing priority: for each kind, the first listed connector that answers it is tried first.

```yaml
# ~/.terminal/config.yml
llm:
  provider: anthropic           # or openai
  model: <a current Claude Sonnet model id>
  apiKey: sk-ant-...            # or set ANTHROPIC_API_KEY in the environment
connectors:
  - name: yahoo                 # no config needed
  - name: finnhub
    config:
      apiKey: your-finnhub-key
```

On startup the server imports each listed connector, calls `registry.register(connector, entry.config ?? {})`, and the registry parses the config with your schema:

- Parse succeeds → status `ok`; your kinds become answerable.
- Parse fails → status `missing_config` with the Zod issues as the error text (`apiKey: Invalid input: expected string, received undefined`). The connector is listed but never called, and its kinds are not advertised to the agent unless another connector answers them. The connectors page shows this as **missing key** next to a key field.
- Status `error` is reserved for a connector the server could not load or that is failing at runtime; the registry itself only produces `ok` and `missing_config`.

So "a key is required" is expressed entirely by the schema: `z.object({ apiKey: z.string().min(1) })`. An empty string counts as missing. A connector with `z.object({})` is always `ok` with no key.

The connectors page (`GET /api/connectors`, `PUT /api/connectors/:name/config`) saves the key into `config.yml` under that connector's `config` and the process restarts, so the connector is registered again with the new config. Keys never leave the machine. Optional settings (a base URL, a rate limit) go in the same schema with `.optional()` or `.default()`.

## Testing with recorded fixtures

Tests never hit the network. Record a real response once into `test/fixtures/`, then inject a fake `ctx.http.get` that serves it. Run through a `ConnectorRegistry` so the test also exercises column validation, or call the handler directly with a hand-built `Ctx` when you want to assert on a thrown error.

A fixture, recorded from the API in the worked example below:

```json
{ "symbol": "MU", "last": 101.2, "prevClose": 102.53, "volume": 12345678, "session": "open" }
```

The test:

```ts
// connectors/example/test/quote.test.ts
import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, type Ctx, type Http } from '@terminal/core'
import example from '../src/index.js'
import quoteMU from './fixtures/quote-MU.json'

/** An Http whose get() serves recorded bodies by exact URL and throws on anything else. */
function fakeHttp(responses: Record<string, unknown>): Http {
  return {
    async get(url) {
      if (url in responses) return responses[url]
      throw new Error(`unexpected request: ${url}`)
    },
  }
}

const URL_MU = 'https://api.example-quotes.dev/v1/quote/MU?token=test-key'

describe('example quote', () => {
  it('maps the recorded response to a quote frame', async () => {
    const registry = new ConnectorRegistry({ http: fakeHttp({ [URL_MU]: quoteMU }) })
    expect(registry.register(example, { apiKey: 'test-key' }).status).toBe('ok')

    const frame = await registry.run({ kind: 'quote', params: { symbols: ['MU'] } })

    expect(frame.columns.map((c) => c.name)).toEqual(['symbol', 'price', 'change_pct', 'volume', 'market_state', 'extended_price', 'extended_change_pct'])
    expect(frame.rows).toEqual([['MU', 101.2, -1.3, 12345678, 'REGULAR', null, null]])
    expect(frame.meta.connector).toBe('example')
  })

  it('skips a symbol that fails and keeps the rest', async () => {
    const logs: string[] = []
    const ctx: Ctx<{ apiKey: string }> = { http: fakeHttp({ [URL_MU]: quoteMU }), config: { apiKey: 'test-key' }, log: (m) => logs.push(m) }

    const frame = await example.queries.quote!({ symbols: ['MU', 'NOPE'] }, ctx)

    expect(frame.rows.map((r) => r[0])).toEqual(['MU'])
    expect(logs[0]).toContain('NOPE')
  })

  it('throws when no symbol can be answered', async () => {
    const ctx: Ctx<{ apiKey: string }> = { http: fakeHttp({}), config: { apiKey: 'test-key' }, log: () => {} }
    await expect(example.queries.quote!({ symbols: ['NOPE'] }, ctx)).rejects.toThrow(/every symbol/)
  })

  it('reports a missing key as missing_config', () => {
    const registry = new ConnectorRegistry()
    expect(registry.register(example, {}).status).toBe('missing_config')
    expect(registry.kinds()).toEqual([])
  })
})
```

`pnpm test` at the repo root runs every `connectors/*/test/**/*.test.ts` through Vitest (the root `vitest.config.ts` lists `connectors/*` as projects). Nothing to configure.

To record fixtures, write a one-off script under `scripts/` that calls the live API with a real key and writes the JSON body to `test/fixtures/<kind>-<SYMBOL>.json`. Keep fixtures small (trim intraday bars to a few dozen) and strip anything personal from them. Never commit a key.

## Worked example: a quote connector

A complete connector for a hypothetical JSON API. `GET https://api.example-quotes.dev/v1/quote/<SYMBOL>?token=<key>` returns `{ symbol, last, prevClose, volume, session }` where `session` is `pre`, `open`, `post`, or `closed`.

```ts
// connectors/example/src/index.ts
import { z } from 'zod'
import { defineConnector, toFrame } from '@terminal/core'

const BASE = 'https://api.example-quotes.dev/v1'

type ApiQuote = { symbol: string; last: number; prevClose: number; volume: number; session: 'pre' | 'open' | 'post' | 'closed' }

const MARKET_STATE: Record<ApiQuote['session'], string> = { pre: 'PRE', open: 'REGULAR', post: 'POST', closed: 'CLOSED' }

export default defineConnector({
  name: 'example',
  config: z.object({ apiKey: z.string().min(1) }),
  queries: {
    quote: async ({ symbols }, { http, config, log, signal }) => {
      // One request per symbol, in parallel. allSettled so one bad symbol does not sink the rest.
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => {
          const q = (await http.get(`${BASE}/quote/${symbol}?token=${config.apiKey}`, { signal })) as ApiQuote
          return {
            symbol,
            price: q.last,
            change_pct: q.prevClose ? round2(((q.last - q.prevClose) / q.prevClose) * 100) : null,
            volume: q.volume,
            market_state: MARKET_STATE[q.session] ?? null,
            extended_price: null, // this API has no extended-hours data
            extended_change_pct: null,
          }
        }),
      )

      const rows: Record<string, unknown>[] = []
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') rows.push(r.value)
        else log(`quote ${symbols[i]} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      })
      if (rows.length === 0) throw new Error(`quote failed for every symbol: ${symbols.join(', ')}`)

      return toFrame('quote', rows, { connector: 'example' })
    },
  },
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
```

Things to notice:

- The handler destructures its validated params (`symbols` is a non-empty `string[]`) and the ctx.
- The key comes from `config.apiKey`, typed by the schema. If the user has not set it, the registry marks the connector `missing_config` and this handler is never called. On the connectors page that shows as **missing key** with a field to paste one; saving it writes `config.yml` and the connector comes up `ok`.
- Every cell is a number, a string, or `null`. `time` columns (not present in `quote`) would be `date.getTime()`.
- The same pattern answers `ohlcv` (one chart call per symbol, concatenate, sort by symbol then time), `news` (one call per symbol, merge, sort newest first, slice to `limit`), `earnings` (filter to the window, format the date), and every `symbols[]` kind added in v1.2. Finnhub's connector is a real example of the first three: `connectors/finnhub/src/index.ts`; the openbb connector (`connectors/openbb/src/index.ts`) has a handler for every kind, including the symbol-less ones.

## Package layout and registration

Connector packages live under `connectors/<name>` and are named `@terminal/connector-<name>`. The default export of `src/index.ts` is the connector.

```
connectors/example/
  package.json
  tsconfig.json
  src/index.ts                 default export: defineConnector({...})
  test/quote.test.ts
  test/fixtures/quote-MU.json
  scripts/record.ts            optional: live call that writes fixtures
```

```json
{
  "name": "@terminal/connector-example",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "@terminal/core": "workspace:*", "zod": "^4.6.7" },
  "devDependencies": { "@types/node": "^22.0.0", "typescript": "~5.9.0", "vitest": "^5.0.5" }
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "*.ts"]
}
```

Then `pnpm install` from the repo root links the workspace package.

**Registration in v1.** The server does not discover connectors; it holds a built-in map from config name to module in `packages/server/src/connectors.ts`. To make `example` loadable from `config.yml`, add it there and add `"@terminal/connector-example": "workspace:*"` to `packages/server/package.json`:

```ts
// packages/server/src/connectors.ts (excerpt)
import yahoo from '@terminal/connector-yahoo'
import finnhub from '@terminal/connector-finnhub'
import example from '@terminal/connector-example'

export const BUILTIN_CONNECTORS = { yahoo, finnhub, example }
```

Discovery through a plugin loader (cordis) is planned for later; `defineConnector` is the stable contract, so a connector written today will load unchanged when the loader swaps.

Checklist before opening a pull request:

1. `pnpm typecheck` and `pnpm test` are green from the repo root.
2. Fixture tests cover every kind you answer, plus one failure case and the missing-key case.
3. `pnpm query <kind> key=value …` prints a frame from your connector with a real key (add it to `config.yml` first). For example `pnpm query quote MU SNDK` or `pnpm query insiders symbols=MU limit=10`; `pnpm query --help` lists every kind.
4. Every `time` cell is epoch ms; every absent value is `null`; every percent column is percent; `ohlcv` is sorted; `news` and the history kinds are newest first.
5. The connector's row in the table in PLAN.md section 7.3 (key, kinds, notes) is filled in.

## v1 limits

- **US equities and ETFs only.** Do not return non-US listings from `search`.
- **No streaming.** Widgets poll on the kind's TTL. A connector answers one request and returns.
- **Kinds are fixed per release.** You cannot add a kind from a connector; the catalog in `packages/core/src/kinds.ts` (22 kinds in v1.2) is the contract between connectors, the agent, and the views. To propose a new kind (`peers`, `filings`, options flow, …), open an issue with a use case that the existing kinds cannot serve, the param schema, and the columns.
- **No execution.** Research and monitoring only; no broker connectors.
- **Keys never leave the machine.** A connector may call only the source it is for, with the key the user gave it.
