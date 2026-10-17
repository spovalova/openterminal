# OpenBB Platform probe (2026-10-17)

What the OpenBB Platform REST API returns for our five kinds. Probed against `openbb` 5.0.0 (`openbb-core` 2.0.1, `openbb-yfinance` 2.0.0) on Python 3.12, Ubuntu 24.04. Source for the constants in `connectors/openbb/src/openbb-api.ts`.

## Install and launch

- `pip install openbb` alone (5.0) gives the core, the Workspace API launcher and the keyless data providers (bls, cboe, cftc, deribit, ecb, eia, famafrench, federal_reserve, finra, fred, imf, jodi, nasdaq, tmx, oecd, sec, congress_gov, usda, us_treasury) but **no unified `equity/...` routes and no yfinance**. Only provider-namespaced routes exist (`/api/v1/nasdaq/equity/quote`, `/api/v1/cboe/equity/historical`, ...).
- `pip install "openbb[routers]" openbb-yfinance` adds the unified routers (`openbb-equity`, `openbb-news`, `openbb-etf`, ...) and yfinance. `fmp`, `polygon`, `intrinio`, `tiingo`, `benzinga` are separate `openbb-<name>` packages with keys in `~/.openbb_platform/user_settings.json`.
- `openbb-api` builds the static assets on start (skip with `--no-build`) and serves FastAPI on `http://127.0.0.1:6900`. Startup takes 20 to 40 s on this VM. `--login` turns on basic auth. `/openapi.json` is about 1,000 paths; `/api/v1/coverage/providers` is a small `{ provider: [routes] }` map and is what the health probe uses.
- Validation errors are 422 with `detail: [{ msg, loc, ... }]`; a provider that is not installed is one of those ("Input should be 'cboe', 'nasdaq', 'tmx' or 'yfinance'").
- Every data route answers `{ id, results, provider, warnings, chart, extra }`. A route with nothing to say answers **204 No Content** with an empty body (yfinance company news does this for every symbol tried).

## Routes used, with the provider choices installed here

| Kind | Route | Providers | Chosen default |
|---|---|---|---|
| search | `GET /api/v1/equity/search?query=&provider=` | cboe, finra, nasdaq, sec, tmx (no yfinance) | nasdaq: `symbol`, `name`, `"Listing Exchange"` code (Q, N, A, P, Z, V) |
| quote | `GET /api/v1/equity/price/quote?symbol=A,B&provider=` | cboe (one symbol per call), nasdaq, tmx, yfinance | yfinance: `symbol`, `last_price`, `prev_close`, `volume`, no change or market-state fields |
| ohlcv | `GET /api/v1/equity/price/historical?symbol=A,B&start_date=&interval=&provider=` | cboe (1m, 1d), nasdaq, tmx, yfinance | yfinance: `1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1W 1M 1Q`; rows carry `symbol` only when several were asked |
| news | `GET /api/v1/news/company?symbol=A,B&limit=&provider=` | nasdaq, tmx, yfinance | nasdaq: `date` (day resolution, `T00:00:00`), `title`, `url`, `symbols` (comma list), `publisher`, `topic` |
| earnings | `GET /api/v1/equity/calendar/earnings?start_date=&end_date=&provider=` | nasdaq, tmx, yfinance | nasdaq: whole market, `report_date`, `symbol`, `eps_consensus`, `reporting_time` (`pre-market`, `after-hours`, `not-supplied`) |

Samples (MU on 2026-10-16, after the close):

- cboe quote: `last_price 875.41, change_percent -0.056269, last_timestamp 2026-10-16T15:59:59` plus bid/ask and implied-volatility fields. **`change_percent` is a fraction.**
- nasdaq quote: `last_price 878.84, change_percent -0.0563, market_status "Closed", last_timestamp 2026-10-15T00:00:00` (a day behind), plus market cap and dividend fields.
- yfinance quote: `last_price 878.84, prev_close 931.24, volume 30145042, exchange "NMS"`, no change, no state; the connector computes `change_pct`.
- yfinance historical 1d for `MU,SNDK` from 2026-10-01: 24 rows, `{ date "2026-10-01", open, high, low, close, volume, dividend, symbol }`.
- yfinance historical 5m for NVDA from 2026-10-13: 312 rows, `date "2026-10-13T09:30:00"` with no zone: exchange (New York) time.
- yfinance historical 1W: `date "2026-01-01"`, weekly rows with no `symbol` field.
- nasdaq earnings 2026-10-17 to 2026-12-16: 4,491 rows in 2.2 s; `SNDK 2026-10-29 after-hours 45.22`, `WDC 2026-10-22 after-hours 3.97`, `NVDA 2026-11-18 not-supplied 2.48`.
- yfinance earnings: `timing "AMC"/"BMO"`, but Yahoo caps the window at 100 rows, which is useless for a symbol filter over 60 days.
- Unknown symbol (`ZZZZZZ`) on yfinance quote: 200 with `results: []`.
- **ETFs on yfinance quote have no `last_price`**: `SPY` comes back with `asset_type "ETF"`, bid, ask, open, high, low, volume and `prev_close` only. nasdaq quote answers 204 for `SPY,QQQ`. The connector treats a missing price as "cannot answer this table" and throws, so yahoo (which quotes ETFs) answers the whole quote.

## Decisions taken from this

- Defaults per kind: search nasdaq, quote yfinance, ohlcv yfinance, news nasdaq, earnings nasdaq. Any installed provider can replace them per kind in config.
- Percent fields are scaled by 100. Daily and weekly dates are stamped at New York midnight; zone-less intraday stamps are New York wall time.
- Providers that take comma lists (yfinance, nasdaq, tmx, and the keyed fmp, polygon, intrinio, tiingo) get one call; others are fanned out per symbol.
- A connection failure trips a 30 s breaker inside the connector so the registry's fallback to yahoo costs nothing while OpenBB is down.
- The install line in the not-running message is the two-command one above; the base package alone is not enough.
