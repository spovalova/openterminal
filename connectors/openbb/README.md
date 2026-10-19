# @openterminal/connector-openbb

Every GET route of a locally running [OpenBB Platform](https://docs.openbb.co/platform) REST API, as routes in the catalog (PLAN.md section 17). OpenBB is the on-ramp to its providers: yfinance, nasdaq, cboe, sec, finra, federal_reserve, oecd, bls, cftc, deribit, famafrench, tmx, us_treasury and more with no key; FMP, Polygon, Intrinio, Tiingo, FRED, EIA, Benzinga and others with keys you set on the OpenBB side.

OpenBB runs as its own process (Python, AGPL-3.0). This connector only sends it HTTP requests; nothing of OpenBB is bundled or imported here.

## Install and start OpenBB

```sh
pip install "openbb[routers]" openbb-yfinance
openbb-api
```

Python 3.10 to 3.12. The first command installs the Platform core, the unified routers (`/api/v1/equity/...`, `/api/v1/news/...`) and the yfinance provider; the second builds the API on first start and serves it at `http://127.0.0.1:6900`. OpenBB 5 ships the keyless nasdaq, cboe and sec providers in the base package. Add others with `pip install openbb-fmp` and so on, then put their keys in `~/.openbb_platform/user_settings.json` ([OpenBB docs](https://docs.openbb.co/platform/user_guides/settings_and_environment_variables)).

Open Terminal's Data page shows `not running` with these two commands until the API answers.

## Config (`~/.openterminal/config.yml`)

```yaml
connectors:
  - name: openbb
    config:
      baseUrl: http://127.0.0.1:6900
      providers:                      # provider per route when a query names none; unset routes use the keyless default
        equity/price/quote: fmp
        equity/price/historical: polygon
      # username / password: only when openbb-api runs with --login
  - name: yahoo
```

When a query names no `provider`, `call` uses the one configured for the route, else the first keyless provider the route lists (yfinance, nasdaq, cboe, sec, finra, federal_reserve, us_treasury, oecd, imf, ecb, bls, cftc, deribit, famafrench, tmx, in that order), else the route's first. OpenBB 5 answers 422 to a call without one when no default is configured on its side. The Data page's per-route provider overrides do the same thing live, without editing the file.

## How it works

- **Descriptors.** `descriptors(ctx)` fetches `${baseUrl}/openapi.json` and generates one descriptor per GET route whose response is a results envelope (834 on OpenBB 5.0.0): the `provider` query param becomes the route's `providers` list, per-provider param variants collapse to one entry (a param's `providers` list comes only from OpenBB's `(provider: x)` markers), `symbol`-style comma lists are `string[]`, date and datetime fields are `time`. The result is cached in `~/.openterminal/catalog/openbb.json` (`OPENTERMINAL_HOME` overrides the directory), keyed by the document's version and a fingerprint of its paths and models, so installing a provider extension regenerates. When the API is down the cached file is served, or nothing.
- **Calls.** `call(route, params, ctx)` is `GET {baseUrl}/api/v1/<route>?…` with the validated params (arrays joined by commas, `provider` passed through, params the chosen provider does not take dropped) and the `results` list through core's `inferFrame` with the route's descriptor. Single-symbol rows that carry no `symbol` (bars, dividends, statements) get it from the params. Union columns no row fills are dropped (a yfinance quote would otherwise be ninety null columns). Provider values are returned as they are: fractions stay fractions and the annotations (`packages/core/annotations.yml`) say what each field is.
- **Breaker.** When nothing listens on `baseUrl`, the first call trips a 30 s breaker: every call in that window throws immediately with the install commands, so a recipe falls back to its next alternative at no cost. A successful health probe clears it.
- **Dates.** Daily and weekly rows are `YYYY-MM-DD` (New York midnight); zone-less intraday stamps are exchange (New York) time; anything with a zone is itself.
- **Probe.** `pnpm probe --concurrency=4` calls every route once with sample params and records liveness in the store; dead routes are hidden from the agent. OpenBB serves blocking provider calls on one event loop, so four concurrent calls is the setting that finishes cleanly; `docs/notes/openbb-probe.md` part 3 has the numbers.

The recipes in `packages/core/recipes.yml` name the OpenBB routes the common questions use (`equity/price/historical`, `equity/fundamental/metrics`, `derivatives/options/chains`, `economy/calendar`, `fixedincome/government/yield_curve`, …) with the provider that answered them best in the probes; what a route does not do (the whole option chain, the market-wide earnings calendar, nasdaq's market value in thousands) the recipe does in its pandas step.

```ts
await registry.run({ connector: 'openbb', route: 'fixedincome/corporate/bond_prices', params: { provider: 'finra', issuer_name: 'coreweave' } })
```

```sh
pnpm query openbb --routes bond                                  # search the routes
pnpm query openbb equity/price/quote symbol=NVDA provider=yfinance
```

## Develop

```sh
pnpm --filter @openterminal/connector-openbb test     # fixtures only, no network (the generator over a recorded openapi.json, call over recorded results)
pnpm --filter @openterminal/connector-openbb smoke    # against a running openbb-api: one frame per route the recipes name
```
