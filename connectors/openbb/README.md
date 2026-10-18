# @terminal/connector-openbb

All 22 kinds through a locally running [OpenBB Platform](https://docs.openbb.co/platform) REST API: the v1 five (search, quote, ohlcv, news, earnings) and the v1.2 seventeen (profile, metrics, financials, estimates, eps_history, dividends, insiders, institutions, short_interest, options, volatility, calendar, ipos, movers, holdings, macro, yield_curve). OpenBB is the on-ramp to its providers: yfinance, nasdaq, cboe, sec, finra, federal_reserve and oecd with no key; FMP, Polygon, Intrinio, Tiingo, Benzinga and others with keys you set on the OpenBB side.

OpenBB runs as its own process (Python, AGPL-3.0). This connector only sends it HTTP requests; nothing of OpenBB is bundled or imported here.

## Install and start OpenBB

```sh
pip install "openbb[routers]" openbb-yfinance
openbb-api
```

Python 3.10 to 3.12. The first command installs the Platform core, the unified routers (`/api/v1/equity/...`, `/api/v1/news/...`) and the yfinance provider; the second builds the API on first start and serves it at `http://127.0.0.1:6900`. OpenBB 5 ships the keyless nasdaq, cboe and sec providers in the base package. Add others with `pip install openbb-fmp` and so on, then put their keys in `~/.openbb_platform/user_settings.json` ([OpenBB docs](https://docs.openbb.co/platform/user_guides/settings_and_environment_variables)).

The terminal's Connectors page shows `not running` with these two commands until the API answers.

## Config (`~/.terminal/config.yml`)

```yaml
connectors:
  - name: openbb           # first = routes first when the API is running; yahoo answers when it is not
    config:
      baseUrl: http://127.0.0.1:6900
      providers:           # per kind; unset kinds use the defaults below
        ohlcv: yfinance
        news: nasdaq
      # username / password: only when openbb-api runs with --login
  - name: yahoo
```

Default providers, chosen from the keyless set in the 2026-10-17 and 2026-10-18 probes (`docs/notes/openbb-probe.md`):

| Kind | Provider | Route | Why / notes |
|---|---|---|---|
| search | nasdaq | `/equity/search` | carries the listing exchange; yfinance has no equity search |
| quote | yfinance | `/equity/price/quote` | comma-separated symbols, live price; change is computed from `prev_close` |
| ohlcv | yfinance | `/equity/price/historical` | 1m to 1W intervals, multi-symbol rows carry `symbol` |
| news | nasdaq | `/news/company` | publisher and tagged symbols; yfinance company news returns 204 |
| earnings | nasdaq | `/equity/calendar/earnings` | whole-market window with `reporting_time` (pre-market / after-hours) |
| profile | yfinance | `/equity/profile` | comma list; `stock_exchange` is a Yahoo code (NMS), `industry_category`, `long_description` |
| metrics | yfinance | `/equity/fundamental/metrics` | the only provider; `ps` is EV/revenue (no price/sales field) |
| financials | yfinance | `/equity/fundamental/{income,cash,balance}` | one symbol per call (a comma list answers nothing), joined on `period_ending` |
| estimates | yfinance | `/equity/estimates/consensus` + `/yfinance/estimates/earnings` | targets and recommendation, then 0q / 0y EPS estimates from the yfinance-only route |
| eps_history | yfinance | `/equity/fundamental/historical_eps` | comma list, newest first, the next report on top with the estimate only |
| dividends | yfinance | `/equity/fundamental/dividends` | one symbol per call, oldest first, no symbol field |
| insiders | sec | `/equity/ownership/insider_trading` | Form 4 rows with price, transaction code and filing URL; yfinance works too (description text, no URL) |
| institutions | nasdaq | `/equity/ownership/institutional` | the only unified provider; `market_value` is thousands of dollars; yfinance uses `/yfinance/ownership/institutional` |
| short_interest | finra | `/equity/shorts/short_interest` | comma list, full history, `change_pct` already percent; nasdaq gives 12 months with a fraction |
| options | cboe | `/derivatives/options/chains` | the whole chain with greeks and IV (MU: 11,000 rows, about 1.7 s); the handler keeps one expiration and a strike window |
| volatility | cboe | `/equity/price/quote` | iv30 with its one-year range, hv30 range, 52-week range; one symbol per call |
| calendar | nasdaq | `/economy/calendar` | zone-less New York stamps, text cells; `country` in `lowercase_underscore` |
| ipos | nasdaq | `/equity/calendar/ipo` | one status per call (priced and upcoming are both fetched); whole months, cut to the window here |
| movers | yfinance | `/equity/screener?preset=` | `day_gainers`, `day_losers`, `most_actives` with `price_min` = our `min_price` (default 5) and Yahoo's 500M market-cap floor. nasdaq (`/nasdaq/markets/movers`) is the alternative: the whole tape, 20 rows, warrants first, no volume on gainers and losers |
| holdings | nasdaq | `/etf/holdings` | top 10 only, no limit parameter |
| macro | federal_reserve (+ oecd) | `/fixedincome/government/treasury_rates`, `/fixedincome/rate/{effr,sofr}`, `/economy/money_measures`, `/economy/{cpi,unemployment}` | one call per route the requested series need; cpi_yoy and unemployment always come from oecd |
| yield_curve | federal_reserve | `/fixedincome/government/yield_curve` | eleven maturities 1M to 30Y; a weekend date answers the prior business day |

## Behaviour

- Every call hits `GET {baseUrl}/api/v1/<route>?provider=<p>&...` and reads the `results` list of the envelope.
- When nothing listens on `baseUrl`, the first call trips a 30 s breaker: every call in that window throws immediately with the install commands, so the registry falls back to the next connector at no cost. A successful health probe clears it.
- A quote table with a hole is handed to the next connector: when the provider returns no price for any requested symbol (yfinance gives ETFs such as SPY and QQQ bid, ask and `prev_close` but no `last_price`), the handler throws and the registry answers the whole table from yahoo.
- Percent changes arrive as fractions (`-0.0563`) and are scaled to `-5.63`.
- Daily and weekly bars are stamped at New York midnight; zone-less intraday stamps are exchange (New York) time.
- Earnings are a market-wide window filtered to the requested symbols (nasdaq, 60 days: about 2 s, 4,500 rows).

### Units (v1.2 kinds)

Every percent column in the catalog is percent; the connector scales what the providers hand over as fractions and passes through what is already percent:

| Column(s) | Provider field | Scaling |
|---|---|---|
| metrics gross_margin, operating_margin, profit_margin, revenue_growth, earnings_growth, roe | yfinance fractions (`0.48653`) | ×100 |
| metrics dividend_yield | yfinance percent already (AAPL `0.31`, MSFT `0.74`, MU `0.07`) | as is |
| metrics debt_to_equity | yfinance percent-like ratio (AAPL `78.4`) | as is |
| estimates upside_pct | computed: (target_consensus / current_price − 1) × 100 | |
| estimates eps_growth_y | yfinance `growth` fraction for period `0y` | ×100 |
| eps_history surprise_pct | yfinance `surprise_percent` (percent already) | as is |
| institutions change_pct | nasdaq `shares_change_percent` fraction | ×100 |
| institutions value | nasdaq `market_value` in thousands of dollars | ×1000 (yfinance values are dollars) |
| short_interest change_pct | finra percent already; nasdaq fraction | as is / ×100 |
| options iv | cboe `implied_volatility` fraction | ×100 |
| volatility iv30, iv30_high, iv30_low, hv30_high, hv30_low | cboe fractions | ×100; iv_rank = (iv30 − low) / (high − low) × 100 clamped to 0..100; hv30 itself is null (cboe has no spot HV field) |
| movers change_pct, holdings weight | nasdaq fractions | ×100 |
| macro treasury_*, fed_funds, sofr, cpi_yoy, unemployment | federal_reserve and oecd fractions | ×100; spread_10y_2y = (year_10 − year_2) × 100 in percentage points; m2 is dollars |
| yield_curve rate | federal_reserve fraction | ×100 |
| financials capex | yfinance `capital_expenditure_reported` (negative) | sign flipped to a positive spend; free_cash_flow = operating_cash_flow − capex |

Other v1.2 behaviour:

- Symbol kinds return rows in the requested symbol order; per-symbol lists (eps_history, dividends, insiders, short_interest, financials) are newest first and cut to `limit` per symbol locally, since most routes ignore or lack a limit parameter.
- A symbol table with nothing in it throws (so the registry falls back); a table missing some symbols is returned and the gap is logged. Window kinds (calendar, ipos) return an empty frame for an empty window.
- `options` loads the whole chain, picks one expiration (the requested date snapped forward to a listed one, or the nearest at least 7 days out, else the nearest tomorrow or later), keeps the `strikes` nearest strikes on each side of the underlying (a strike equal to the underlying is kept too), filters by type and sorts by strike with calls before puts.
- `insiders` action: sec `Disposition` is `sell` (a bona fide gift is `other`); an `Acquisition` by open-market purchase is `buy`, by grant or award `grant`, anything else (option exercise, conversion) `other`. value is shares × price.
- `macro` cpi_yoy and unemployment are always oecd `united_states` monthly series, whatever `providers.macro` says; the other series use `providers.macro` (default federal_reserve, fred works with a key).

## Develop

```sh
pnpm --filter @terminal/connector-openbb test     # fixtures only, no network
pnpm --filter @terminal/connector-openbb smoke    # against a running openbb-api
```
