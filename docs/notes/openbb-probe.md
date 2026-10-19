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

---

# OpenBB Platform probe, part 2: the v1.2 kinds (2026-10-18)

What the same install (`openbb` 5.0.0, `openbb-core` 2.0.1, `openbb-yfinance` 2.0.0, keyless providers yfinance, nasdaq, sec, cboe, finra, federal_reserve, oecd, tmx) returns for the seventeen kinds added in PLAN.md section 14. Same envelope and error conventions as above: `{ results }`, 204 for nothing, 422 `detail[]` for validation, 400 or 500 with a string `detail` when the upstream rejects a symbol. Field names and units below are what `connectors/openbb/src/index.ts` maps; "fraction" means the connector multiplies by 100.

## Company

### profile: `GET /equity/profile?symbol=A,B&provider=yfinance`

Providers finra, nasdaq, tmx, yfinance (all take comma lists). yfinance: `name`, `stock_exchange` (Yahoo code, `NMS`), `sector`, `industry_category`, `market_cap`, `employees`, `beta`, `long_description`, plus address and officer fields. 1.4 s for three symbols. An unknown symbol is silently dropped from the list; all unknown is a 204. nasdaq's profile has a shorter marketing description and no sector.

### metrics: `GET /equity/fundamental/metrics?symbol=A,B&provider=yfinance`

yfinance is the only provider. Fields: `market_cap`, `pe_ratio`, `forward_pe`, `peg_ratio`, `peg_ratio_ttm`, `enterprise_to_ebitda`, `enterprise_to_revenue`, `price_to_book`, `gross_margin`, `operating_margin`, `ebitda_margin`, `profit_margin`, `return_on_assets`, `return_on_equity`, `revenue_growth`, `earnings_growth`, `earnings_growth_quarterly`, `debt_to_equity`, `dividend_yield`, `dividend_yield_5y_avg`, `payout_ratio`, `quick_ratio`, `current_ratio`, `book_value`, `enterprise_value`, `beta`, `price_return_1y`, five governance risk scores. No price-to-sales field: `ps` is `enterprise_to_revenue`.

Units, the surprise of the day: margins, growth and returns are fractions (AAPL `gross_margin 0.48653`, `revenue_growth 0.164`, `return_on_equity 1.4875`; MU `earnings_growth 10.595` is a real 1,060% because net income went from 1.9 B to 28.2 B), **but `dividend_yield` is already percent** (AAPL `0.31`, MSFT `0.74`, MU `0.07`; Apple's yield is about 0.3%, Micron's $0.46 a year on $880 is 0.05%) while `dividend_yield_5y_avg` next to it is a fraction (`0.0047`). `debt_to_equity` is yfinance's percent-like ratio (AAPL `78.4`, MSFT `29.1`), passed through. Unknown symbol: 204.

### financials: `GET /equity/fundamental/{income,cash,balance}?symbol=X&period=quarter|annual&limit=N&provider=yfinance`

Providers nasdaq, sec, tmx, yfinance. **One symbol per call**: `symbol=MU,NVDA` answers 200 with `results: []`. `period` takes `annual` or `quarter` for yfinance; `limit` is honoured (annual limit 2 gives 2 rows) and 5 is the most yfinance has. All three statements return 60 to 80 fields keyed on `period_ending`; the ones used:

- income: `total_revenue`, `gross_profit`, `operating_income`, `net_income`, `diluted_earnings_per_share`, `weighted_average_diluted_shares_outstanding`.
- cash: `operating_cash_flow`, `capital_expenditure_reported` (negative, `-7826000000`), `capital_expenditure` (same), `free_cash_flow` (equals ocf + reported capex, so ocf − |capex|).
- balance: `cash_and_cash_equivalents`, `cash_cash_equivalents_and_short_term_investments`, `total_debt`, `long_term_debt`, `ordinary_shares_number` (shares outstanding), `share_issued`.

MU quarter 2026-05-31: revenue 41.456 B, net income 28.243 B, diluted EPS 24.67, ocf 25.388 B, capex 7.826 B, cash 24.995 B, total debt 6.376 B, 1.129 B shares. About 100 ms per statement. Unknown symbol: 200 with `results: []`.

### estimates: `GET /equity/estimates/consensus?symbol=A,B&provider=yfinance` and `GET /yfinance/estimates/earnings?symbol=A,B`

consensus (nasdaq, tmx, yfinance): `recommendation` (`strong_buy`, `buy`, ...), `recommendation_mean`, `number_of_analysts`, `target_low`, `target_consensus`, `target_median`, `target_high`, `current_price`. The EPS estimates live only on the provider-namespaced yfinance route: four rows per symbol with `period` `0q`, `+1q`, `0y`, `+1y`, `mean`, `low`, `high`, `number_of_analysts`, `year_ago_eps`, `growth` (fraction: AAPL 0y `0.1823`, MU 0y `1.3377`). The connector takes `0q` and `0y`. 100 ms each.

### eps_history: `GET /equity/fundamental/historical_eps?symbol=A,B&limit=N&provider=yfinance`

Providers nasdaq, yfinance (comma list on yfinance, `limit` per symbol). Rows newest first, the next scheduled report on top with `eps_actual: null` and `surprise_percent: null`; `surprise_percent` is percent already (MU 2026-09-30: actual 33.42, estimated 31.82, surprise 5.03).

### dividends: `GET /equity/fundamental/dividends?symbol=X&provider=yfinance`

Providers nasdaq, tmx, yfinance. **One symbol per call**: a comma list, like an unknown symbol, is a 400 `"Error getting data for MU,AAPL: 'NoneType' object has no attribute 'empty'"`. Rows oldest first (AAPL from 1987), `ex_dividend_date` and `amount` only, no symbol field. 300 ms.

## Ownership and positioning

### insiders: `GET /equity/ownership/insider_trading?symbol=X&provider=sec`

Providers nasdaq, sec, tmx, yfinance. sec: Form 4 rows for roughly the last 120 days of filings (MU: 131 rows, all filed 2026-10-15; AAPL: 49 rows over three months, 6 s cold, 300 ms cached), one symbol per call, **`limit` is nasdaq-only and ignored**, and `start_date` outside the available window is a 400 `"No Form 4 data was returned for MU."`. Fields: `filing_date`, `transaction_date`, `owner_name`, `owner_title`, `transaction_type` (the code's long name: "Open market or private sale of non-derivative or derivative security", "Grant, award or other acquisition pursuant to Rule 16b-3(d)", "Payment of exercise price or tax liability by delivering or withholding securities ...", "Exercise or conversion of derivative security ...", "Bona fide gift"), `acquisition_or_disposition` (`Acquisition` / `Disposition`), `security_type`, `securities_owned`, `securities_transacted`, `transaction_price` (0.0 on grants), `filing_url`, `director`, `officer`, `ten_percent_owner`, `footnote`. Holdings-only rows (no transaction) have `transaction_date: null` and are dropped. yfinance (comma list): `transaction_date`, `owner_name`, `owner_title`, `securities_transacted`, `transaction_value`, `description` ("Sale at price 959.14 - 989.59 per share."), empty `transaction_type` and `filing_url`.

### institutions: `GET /equity/ownership/institutional?symbol=X&limit=N&provider=nasdaq`

nasdaq is the only unified provider (one symbol, `limit` default 50, `sort_by` default market value desc). Fields: `date` (the holder's latest 13F quarter, Vanguard Group still 2025-12-31 while others are 2026-06-30), `owner_name`, `shares_held`, `shares_change`, `shares_change_percent` (fraction), `market_value`, `url`. **`market_value` is in thousands of dollars**: Blackrock 104,827,219 MU shares show `92126353` on nasdaq and `92126355961` on `/yfinance/ownership/institutional` (`holder`, `shares`, `value`, `percent_held`, `percent_change`, `date_reported`). Unknown symbol: 400 "Symbol not exists". 1 s cold, 20 ms cached.

### short_interest: `GET /equity/shorts/short_interest?symbol=A,B&provider=finra`

Providers finra (comma list) and nasdaq (one symbol). finra: the full twice-monthly history oldest first (MU from 2017-12-29, 211 rows; 1.6 s for two symbols) with `settlement_date`, `symbol`, `current_short_position`, `previous_short_position`, `avg_daily_volume`, `days_to_cover`, `change`, `change_pct` (**percent already**, `-5.83`), `revised`, `stock_split`. nasdaq: the last 12 months newest first, same names but `change_pct` is a fraction (`-0.0583`) and `days_to_cover` unrounded. Unknown symbol on finra: 204.

## Options and volatility

### options: `GET /derivatives/options/chains?symbol=X&provider=cboe`

Providers cboe, deribit, nasdaq, tmx, yfinance. cboe returns the whole chain: MU 11,282 contracts over 25 expirations in 1.7 s (6 MB), AAPL 3,318 in 0.9 s. Fields: `underlying_symbol`, `underlying_price`, `contract_symbol`, `expiration`, `dte`, `strike`, `option_type` (`call` / `put`), `open_interest`, `volume`, `theoretical_price`, `last_trade_price`, `last_trade_time`, `tick`, `bid`, `bid_size`, `ask`, `ask_size`, `open`, `high`, `low`, `prev_close`, `change`, `change_percent`, `implied_volatility` (fraction, `0.0` on deep in-the-money contracts), `delta`, `gamma`, `theta`, `vega`, `rho`. `dte` counts from the provider's today (2026-10-18: the 10-19 expiration has `dte 1`). Unknown symbol: 400 `"ZZZZZZ was not found in the Cboe options directory."`. nasdaq's chain takes an `expiration` filter; cboe's does not, so the connector filters locally.

### volatility: `GET /equity/price/quote?symbol=X&provider=cboe`

The cboe quote (see the 2026-10-17 notes) carries, as fractions: `iv30`, `iv30_annual_high`, `iv30_annual_low`, `hv30_annual_high`, `hv30_annual_low`, the same for 60 and 90 days, plus `year_high`, `year_low`. **There is no `hv30` spot field**, so the catalog's `hv30` is null from cboe. A comma list works on this route today (two rows for `MU,AAPL`) but the connector keeps cboe on one symbol per call as before. ETFs (SPY) answer. Unknown symbol: 500 (cboe's CDN returns XML).

## Market-wide

### calendar: `GET /economy/calendar?start_date&end_date&country=united_states&provider=nasdaq`

Providers bls, ecb, fred (key), nasdaq, yfinance. nasdaq: `date` zone-less with seconds (`2026-10-21T08:30:00`, New York wall time: Building Permits at 08:30 ET), `country` ("United States"), `event`, `consensus`, `previous`, `actual` as text (`"1.390M"`, `"-2.1%"`, `"4.085%"`), `description`. Nothing is `" "` (consensus) or `"-"` (actual before release). `country` accepts `united_states`, `United States` and `US` alike; `germany` works. 40 rows for a US week in 30 ms.

### ipos: `GET /equity/calendar/ipo?start_date&end_date&status=priced|upcoming|filed|withdrawn&provider=nasdaq`

Providers nasdaq, yfinance. nasdaq serves one `status` per call (default `priced`) and **answers whole months, ignoring the day part of the window** (2026-09-18 to 2026-10-18 returned 2026-09-01 deals). Fields: `symbol`, `ipo_date`, `name`, `exchange` ("NASDAQ Global Select", "NYSE"), `share_price`, `offer_amount`, `share_count`, `deal_status` ("Priced"), `expected_price_date`, `filed_date`, `withdraw_date`, `id`. `upcoming` for the next month was a 204 today.

### movers: `GET /equity/screener?provider=yfinance&preset=day_gainers|day_losers|most_actives&limit=&price_min=` (default) and `GET /nasdaq/markets/movers?category=&limit=&provider=nasdaq`

Switched the default to the yfinance screener presets after integration: nasdaq's advanced and declined lists are capped at 20 rows and on 2026-10-18 every one of them was a sub-$1 warrant or trust (XLABW $0.195, BCAT $0.0007), so a `min_price` floor left nothing; limits above 100 error with "Nasdaq does not publish 'most_advanced' for the 'stocks' asset class". The screener answers in about 0.1 s with `symbol, name, price, change, percent_change (fraction), volume` and real names (CRGY +10.07%, INTC 121M shares on most_actives).


No unified `/equity/discovery/{gainers,losers,active}` for US names (`/equity/discovery/gainers` is tmx-only). The nasdaq route takes `category` in `most_active_share_volume` (**the default: no category means most active, not gainers**), `most_active_dollar_volume`, `most_advanced`, `most_declined`, `nasdaq_100`, plus `asset_class` (`stocks`, `etf`, `mutualfunds`) and `session`. Fields: `symbol`, `name`, `price`, `change`, `change_percent` (fraction), `volume` (float; **null on the advanced and declined lists**; on the dollar-volume list it is the percent change by mistake). The advanced and declined lists are the whole tape as nasdaq publishes it: warrants and sub-dollar names lead (XLABW +176% at $0.195). 700 ms cold, 25 ms cached.

### holdings: `GET /etf/holdings?symbol=SMH&provider=nasdaq`

Providers nasdaq, tmx. nasdaq returns the **top 10 only** (`limit` is not a parameter and is ignored) with `symbol`, `name`, `weight` (fraction, SMH NVDA `0.1959`). SPY works. Unknown symbol: 400 "Symbol not exists".

### macro (all keyless)

- `GET /fixedincome/government/treasury_rates?start_date&provider=federal_reserve`: one row per business day, `date`, `month_1`, `month_3`, `month_6`, `year_1`, `year_2`, `year_3`, `year_5`, `year_7`, `year_10`, `year_20`, `year_30`, fractions (`year_10 0.0524`). Latest 2026-10-15 on the 18th. 600 ms.
- `GET /fixedincome/rate/effr?start_date&provider=federal_reserve`: `date`, `rate` (fraction `0.0388`), target range, percentiles, `volume`. fred is the alternative (key).
- `GET /fixedincome/rate/sofr?start_date&provider=federal_reserve`: `date`, `rate`, percentiles, `volume`.
- `GET /economy/money_measures?start_date&provider=federal_reserve`: monthly, `month` (`2026-01-01`), `m1`, `m2` (dollars, `22459500000000`), components. Seasonally adjusted by default.
- `GET /economy/cpi?country=united_states&transform=yoy&frequency=monthly&start_date&provider=oecd`: `date`, `country`, `value` (fraction `0.02386`), `unit` "Year-over-year (YOY) percent change", `series_id`. `transform` defaults to `yoy` for oecd; it is passed explicitly. 1 s.
- `GET /economy/unemployment?country=united_states&frequency=monthly&start_date&provider=oecd`: `date`, `country`, `value` (fraction `0.047`).
- Not used: `/federal_reserve/atlanta/gdpnow` answers 500 today; every fred route needs a key.

### yield_curve: `GET /fixedincome/government/yield_curve?provider=federal_reserve[&date=]`

Providers ecb, federal_reserve, fred. federal_reserve: eleven rows `date`, `maturity` (`month_1`, `month_3`, `month_6`, `year_1`, `year_2`, `year_3`, `year_5`, `year_7`, `year_10`, `year_20`, `year_30`), `rate` (fraction), `maturity_years`. A weekend `date` (2026-06-14) answers the prior business day and the rows say so (`date 2026-06-12`). 200 ms.

## Decisions taken from this

- Defaults: profile, metrics, financials, estimates, eps_history, dividends on yfinance; insiders on sec; institutions, calendar, ipos, holdings on nasdaq; movers on the yfinance screener; short_interest on finra; options and volatility on cboe; macro and yield_curve on federal_reserve with oecd fixed for cpi_yoy and unemployment. `DEFAULT_PROVIDERS` now has an entry for all 22 kinds; finra joined the comma-list providers.
- Fractions become percent everywhere except the three yfinance fields that already are (`dividend_yield`, `surprise_percent`, `debt_to_equity`) and finra's `change_pct`. nasdaq institutional `market_value` is multiplied by 1,000.
- Routes that are single-symbol whatever the provider (statements, dividends, institutional, holdings, chains) fan out per symbol through `eachSymbol`; per-symbol lists are cut to `limit` locally because most routes ignore it.
- The whole option chain is fetched once per query and the expiration and strike window are chosen in the connector; cboe has no server-side expiration filter.
- Window kinds return an empty frame for an empty window; symbol kinds throw when nothing came back for any symbol and log the symbols that are missing otherwise.
- Columns no keyless provider fills: `volatility.hv30` (cboe has only the one-year HV range), `movers.volume` on the gainers and losers lists, `insiders.url` on yfinance.


# OpenBB Platform probe, part 3: the whole catalog through v2 routes (2026-10-19)

`pnpm probe --concurrency=4 --timeout=30000` over every route of every configured connector (OpenBB 5.0.0 on 127.0.0.1:6900 with the keyless providers installed, yahoo, finnhub with a key), one call per route with sample params (`NVDA`; `SPY` for ETF and holdings routes; `^GSPC`, `EURUSD`, `BTCUSD` by namespace; last week for date windows; `united_states`; the descriptor's defaults; the first keyless provider when the route lists several). 877 routes: 834 OpenBB v2 routes plus the 22 kind routes, yahoo's 5 routes plus 11 kind routes, finnhub's 3 plus 2. 685 s wall time.

## Numbers

- **569 answered** (33 with zero rows): openbb 548 of 856, yahoo 16 of 16, finnhub 5 of 5. 47 of them only on the quiet retry pass (see below). Median latency 0.4 s, p90 3.5 s, max 16 s (deribit, cftc swap data, BLS tables).
- **300 failed**, by class: `needs key` 233 (`eia_api_key` 205, `fred_api_key` 26, `bls_api_key` 1); `bad params` 22 (a required value our sampler cannot invent: a CFTC contract code, an SEC CRD, a congress bill id, an RSSD id, an IMF dataflow; and `derivatives/futures/*` because NVDA is not a future); `timeout` 16 after the retry (FFIEC bank lists, the whole FINRA bond and equity universes without a filter, `fixedincome/corporate/bond_prices` with no params, `usda` archives); `http 4xx` 15 (a CFTC S3 file that is not there, "Could not resolve symbol 'NVDA' to a bank", `economy/indicators` wanting `DATAFLOW::INDICATOR`); `not found` 7 (Deribit lists no options on NVDA; sec `nport` for a non-fund); `provider error` 7 (Atlanta Fed `BadZipFile`, Minneapolis `KeyError 'Date'`, two USDA archives missing a CSV, FAS 503).
- **8 skipped** (unknown liveness, still visible to the agent): routes whose required param has no sample (`dataflow_id`, `release_id`, `table_id`, `group`) or whose `symbol` enum does not contain NVDA (cboe index documents, ECB MFI rates, `equity/compare/company_facts`).
- By namespace (alive/routes): bls 108/108, federal_reserve 120/145, usda 52/58, equity 35/36, yfinance 29/29, economy 22/38, sec 20/27, deribit 20/24, cftc 17/19, jodi 13/13, nasdaq 12/17, uscongress 9/13, ustreasury 9/11, imf 8/9, etf 8/8, tmx 7/7, famafrench 6/6, fixedincome 6/24, index 5/6, news 4/4, cboe 4/5, derivatives 4/5, oecd 3/5, ecb 2/3, commodity 1/4, eia 1/206, finra 0/3.
- **25 of the 26 routes the recipes name answered** with their default or recipe provider. The one miss is `fixedincome/corporate/bond_prices` called with no filter (FINRA's whole universe, 30 s was not enough); with `provider=finra&issuer_name=coreweave` it answers 12 rows in 8 s (the live check in PR "v2 (a)").

## What the probe had to learn about OpenBB

- **A call without `provider` is a 422 "Field required"** when no default provider is configured on the OpenBB side. The v1 handlers always passed one; the first v2 run lost 21 routes to this. `openbb.call` now chooses the first keyless provider the route lists (yfinance, nasdaq, cboe, sec, finra, federal_reserve, us_treasury, oecd, imf, ecb, bls, cftc, deribit, famafrench, tmx, in that order) when the query names none.
- **Provider-specific defaults must not be sent to other providers.** Validation applies every default in the descriptor (the union over providers), so a yfinance-only `extended_hours=false` would go on a cboe call. `call` drops optional params whose `providers` list excludes the chosen provider; the generator now sets that list only from OpenBB's `(provider: x)` markers, because the schema's provider-keyed extras and the "multiple comma separated items allowed for provider(s)" note are about list-taking and widget config (they had narrowed `symbol` on dividends to nasdaq).
- **One event loop.** `openbb-api` serves blocking provider calls on a single uvicorn worker. Eight concurrent calls (the first run) stalled it for tens of seconds at a time, the health probe timed out, and on the 8 GB box of that run the process was OOM-killed and restarted by systemd. A naive probe marked 677 live routes dead. The probe now never records a `down` result, pauses until the connector's health probe passes (it did three times in this run, each under a minute), and retries timeouts two at a time once the main pass is over, which rescued 47 routes (every `fixedincome/rate/*`, `index/*`, `jodi/*`, `nasdaq/nordic/*` and the FFIEC peer tables). Four concurrent calls finished cleanly; eight is the default the design asked for and is fine for a server with more memory.
- **`bls` answers without a key** for its 108 table routes (one `bls_api_key` route aside); `jodi`, `cftc`, `deribit`, `famafrench`, `tmx`, `us_treasury`, `uscongress` and `usda` are keyless too. `eia` (206 routes) and `fred` (26) are the keyed bulk; both are a key away.
- **Keyless retry is rare.** Only `federal_reserve/ffiec/large_holding_companies` moved to another provider after a key error; most routes with a keyed default provider have no keyless alternative.

## Decisions taken from this

- Liveness rows from this run are not committed anywhere; the server's Data page probe button and `pnpm probe` write them to `<home>/terminal.db` through (e)'s store, and the catalog hides the 300 dead routes from `find_route` until the next probe.
- The probe runs with `--concurrency=4` on this machine; `POST /api/catalog/probe` takes `concurrency` in its body for the same reason.
- `fixedincome/corporate/bond_prices` should not be probed bare: the sampler could take a `issuer_name` sample for FINRA routes, which is the next small improvement to `sampleValue`.
- An annotation to fix (not in this PR's files): `openbb:fixedincome/corporate/bond_prices:coupon_rate` is `fraction` but FINRA sends `9.25`; the live check printed `925`.
