# @terminal/connector-openbb

All five kinds (search, quote, ohlcv, news, earnings) through a locally running [OpenBB Platform](https://docs.openbb.co/platform) REST API. OpenBB is the on-ramp to its providers: yfinance, nasdaq, cboe and sec with no key; FMP, Polygon, Intrinio, Tiingo, Benzinga and others with keys you set on the OpenBB side.

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

Default providers, chosen from the keyless set in the 2026-10-17 probe (`docs/notes/openbb-probe.md`):

| Kind | Provider | Why |
|---|---|---|
| search | nasdaq | carries the listing exchange; yfinance has no equity search |
| quote | yfinance | comma-separated symbols, live price; change is computed from `prev_close` |
| ohlcv | yfinance | 1m to 1W intervals, multi-symbol rows carry `symbol` |
| news | nasdaq | publisher and tagged symbols; yfinance company news returns 204 |
| earnings | nasdaq | whole-market window with `reporting_time` (pre-market / after-hours) |

## Behaviour

- Every call hits `GET {baseUrl}/api/v1/<route>?provider=<p>&...` and reads the `results` list of the envelope.
- When nothing listens on `baseUrl`, the first call trips a 30 s breaker: every call in that window throws immediately with the install commands, so the registry falls back to the next connector at no cost. A successful health probe clears it.
- A quote table with a hole is handed to the next connector: when the provider returns no price for any requested symbol (yfinance gives ETFs such as SPY and QQQ bid, ask and `prev_close` but no `last_price`), the handler throws and the registry answers the whole table from yahoo.
- Percent changes arrive as fractions (`-0.0563`) and are scaled to `-5.63`.
- Daily and weekly bars are stamped at New York midnight; zone-less intraday stamps are exchange (New York) time.
- Earnings are a market-wide window filtered to the requested symbols (nasdaq, 60 days: about 2 s, 4,500 rows).

## Develop

```sh
pnpm --filter @terminal/connector-openbb test     # fixtures only, no network
pnpm --filter @terminal/connector-openbb smoke    # against a running openbb-api
```
