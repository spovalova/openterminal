# yahoo-finance2 probe (Phase 0, 2026-10-16)

Package: `yahoo-finance2@4.0.4` (ESM, `import YahooFinance from 'yahoo-finance2'; const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })`).
Script: `connectors/yahoo/scripts/probe.ts`. Run from `connectors/yahoo` with `pnpm exec tsx scripts/probe.ts`. Live network; not a test.

From this machine (Azure, no browser UA) the raw chart endpoint returned 429 on query1 but 200 on query2; the library handled it (crumb + cookie) with no config. Expect occasional 429s and retry once.

## search → `search`

`yf.search('micron', { quotesCount: 5, newsCount: 0 })` returns `quotes[]` with `symbol`, `shortname`, `longname`, `exchange` (code: NMS, NYQ, PCX, CME, TOR, GER), `exchDisp` (NASDAQ, NYSE, NYSEArca…), `quoteType` (EQUITY, ETF, FUTURE, …), `isYahooFinance`. Also non-finance hits with only `name`/`permalink`.

Mapping: keep `isYahooFinance && quoteType in (EQUITY, ETF)` and US exchanges (NMS, NYQ, PCX, NGM, NCM, ASE, BTS); first hit wins. One call per query term, so `search` with q[] fans out and runs in parallel. Columns: `query` = the input term, `symbol`, `name` = longname ?? shortname, `exchange` = exchDisp.

## quote → `quote`

`yf.quote(['MU','SNDK','SPY'])` returns one object per symbol with: `regularMarketPrice`, `regularMarketChangePercent`, `regularMarketVolume`, `marketState` (PRE, REGULAR, POST, CLOSED, PREPRE, POSTPOST), `preMarketPrice` / `preMarketChangePercent` (present only in PRE), `postMarketPrice` / `postMarketChangePercent` (present in POST), `regularMarketTime` (Date), `hasPrePostMarketData`.

Mapping: `price` = regularMarketPrice, `change_pct` = regularMarketChangePercent, `volume` = regularMarketVolume, `market_state` = marketState, `extended_price` = preMarketPrice ?? postMarketPrice ?? null, `extended_change_pct` likewise.

Also on the quote (useful for `earnings` without quoteSummary): `earningsTimestamp`, `earningsTimestampStart`, `earningsTimestampEnd`, `isEarningsDateEstimate`, `epsForward`, `epsCurrentYear`.

## chart → `ohlcv`

`yf.chart(symbol, { period1, period2?, interval })`. **`range` is not accepted** (schema error), so the connector maps range → period1 = now − range. Intervals accepted include `1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo`: map our `1w` → `1wk`; `1h` is accepted as-is. `meta.validRanges` lists `1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max`.

Returns `quotes[]` of `{ date: Date, open, high, low, close, volume, adjclose? }`, ascending. Intraday:
- 5m over 2 days returned 385 bars and **includes pre/post bars** by default (first bar 20:35Z, after the close). Pass `includePrePost: false` for regular-session bars, which is what use case B wants.
- The last intraday bar is the live partial bar with `volume: 0`.
- 1m intraday is limited to ~7 days; 5m/15m/1h to 60 days. For `range: 1d` use period1 = start of the last trading day (not now − 24h, which spans two sessions after the close).
- Daily bars are stamped at session open (13:30Z); weekly at Monday 04:00Z.

Mapping: `time` = date.getTime() (epoch ms), one call per symbol, run in parallel, concatenate sorted by symbol then time. Drop bars whose close is null.

## quoteSummary calendarEvents → `earnings`

`yf.quoteSummary('MU', { modules: ['calendarEvents'] })` returns `calendarEvents.earnings = { earningsDate: Date[], earningsCallDate: Date[], isEarningsDateEstimate, earningsAverage, earningsLow, earningsHigh, revenueAverage… }`. One symbol per call.

Mapping: `date` = earningsDate[0] formatted YYYY-MM-DD in America/New_York, `session` = null (Yahoo gives a 20:00Z timestamp whether or not the time is known), `eps_estimate` = earningsAverage. Filter to [from, to]. Cheaper alternative for a basket: one `quote()` call and `earningsTimestamp` + `isEarningsDateEstimate`, but it has no quarterly EPS estimate (`epsForward` is annual), so use calendarEvents and fan out.

## Not probed

`news`: yahoo-finance2 has no news module beyond `search().news` (5–10 recent stories per term, with `providerPublishTime`, `publisher`, `link`, `relatedTickers`). Finnhub is the v1 news connector; a yahoo `news` via search is a possible fallback later.
