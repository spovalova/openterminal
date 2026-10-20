# @openterminal/connector-yahoo

The five [yahoo-finance2](https://github.com/gadicc/node-yahoo-finance2) endpoints, and `news`, as routes (pinned, no API key, config `{}`), answered through core's `inferFrame`. `src/descriptors.json` is the catalog entry for each; `src/call.ts` answers them.

| Route | Params | What comes back |
|---|---|---|
| `search` | `q` | up to ten hits with the query first: `symbol`, `shortname`, `longname`, `exchange`, `exchDisp`, `quoteType` (US exchanges only in practice) |
| `quote` | `symbols[]` | one row per requested symbol in requested order, the descriptor's columns only (`regularMarketPrice`, `regularMarketChangePercent`, `marketState`, the pre- and post-market price and move, volume, market cap, 52-week range); a symbol Yahoo does not know is logged and skipped, none at all is an error |
| `chart` | `symbol[]`, `period1`, `period2?`, `interval`, `includePrePost?`, `events?` | bars per symbol with a `symbol` column (`date`, `open`, `high`, `low`, `close`, `volume`), one chart call per symbol; with `events: div` the dividend events as rows (`date`, `dividends.amount`) instead of bars |
| `options` | `symbol`, `date?` | every contract of one expiration (`type`, `strike`, `bid`, `ask`, `lastPrice`, `impliedVolatility`, `openInterest`, `expiration`, `underlyingPrice`), calls before puts per strike; `date` snaps forward to a listed expiration, omitted means the nearest at least seven days out |
| `quoteSummary` | `symbol[]`, `modules[]` | scalar modules flattened to `module.field` columns, one row per symbol (`financialData.targetMeanPrice`, `price.regularMarketPrice`, `defaultKeyStatistics.forwardPE`, …); list modules (`insiderTransactions`, `institutionOwnership`, `earningsHistory`, `earningsTrend`, `topHoldings`) explode to one row per item carrying the base columns |
| `news` | `symbol[]`, `limit?` | the `search` module's news list with no quotes asked for, one search per symbol, merged newest first and de-duplicated by link, in the OpenBB news routes' columns: `date`, `title`, `publisher`, `url`, `symbols` (the tickers Yahoo relates to the story, comma separated); `limit` stories per symbol (default 20). What the `news` recipe reads when OpenBB is not configured |

No unit conversion: fractions stay fractions and the annotations in `packages/core/annotations.yml` (`yahoo:quote:*`, `yahoo:quoteSummary:*`, `yahoo:options:*`) say what each field is. Times are epoch ms; Yahoo's 00:00Z stamps (expirations, fiscal quarters, filing dates) are read as UTC dates.

The recipes name these routes as fallbacks behind OpenBB (and first for `quote`, since Yahoo's quote carries the day change and the market state): `ohlcv` and `index` read `chart`, `dividends` reads `chart` with `events: div`, `profile`, `metrics`, `estimates`, `eps_history`, `insiders`, `institutions`, `short_interest`, `holdings` and `earnings` read `quoteSummary` with the modules each needs, `options` reads `options`, `news` reads `news` (second, after OpenBB and before finnhub, which needs a key). What a route does not do (one expiration and a strike window, the newest `limit` rows, the insider action words) the recipe does in its pandas step.

Limits: Yahoo's data is unofficial and may change or rate-limit without notice (a 429 is retried once); no exchange-holiday calendar; Yahoo caps intraday history (`1m` to about 7 days, `5m`/`15m`/`1h` to 60 days), so long ranges at fine intervals fail per symbol; the live partial bar is included when it has a close; `quoteSummary`'s statement modules are empty since 2024, so `financials` has no Yahoo fallback.

```sh
pnpm --filter @openterminal/connector-yahoo test     # fixtures recorded by scripts/record.ts and scripts/record-catalog.ts; no network
pnpm --filter @openterminal/connector-yahoo smoke    # one frame per route, live
pnpm query yahoo quoteSummary symbol=MU modules=financialData,earningsTrend
```
