# Native OpenBB providers

TypeScript ports of OpenBB Platform's data providers. They answer the same routes, with the same rows, as a local `openbb-api`, inside Open Terminal's process and without Python. The `openbb` connector asks here first and sends only unported routes to the API (PLAN.md section 19).

**License.** This package is Apache-2.0, unlike the rest of the repo, which is MIT. OpenBB has been Apache-2.0 since V5 (2026-09-29). Each ported file keeps a header naming the Python file it came from, and [NOTICE](NOTICE) credits OpenBB.

The one exception is `src/yfinance/`. It is an independent implementation on yahoo-finance2 (MIT) that reproduces the route's output schema. The `openbb_yfinance` package is still AGPL, so its source is never read or copied.

## Layout

```
catalog/openbb.json          every OpenBB route: params (with providers and defaults), providers, fields (pnpm snapshot)
src/<provider>/index.ts      defineProvider({ name, credentials, status, routes, skipped })
src/<provider>/<route>.ts    one handler per route (or a few related routes), plus helpers.ts
src/<provider>/cases.json    the provider's parity cases (cases.<part>.json when a provider is ported in parts)
src/lib/                     csv.ts, xml.ts (fast-xml-parser), xlsx.ts (fflate); node-html-parser for HTML
test/fixtures/<provider>/    recorded cases (<case>.json.gz) and their response bodies (bodies/<hash>.gz)
```

Provider names are OpenBB's `?provider=` values. Most come from a Python package of the same name in `~/.venvs/openbb/lib/python3.12/site-packages/`. The exceptions:

| Provider | Python package |
|---|---|
| `eia` | `openbb_us_eia` |
| `congress_gov`, `us_treasury`, `usda` | `openbb_government_us` |

## A handler

```ts
// equity/price/quote, provider cboe. Ported from openbb_cboe/models/equity_quote.py (OpenBB Platform 5.0.0, Apache-2.0); modified: …
export async function equityQuote(params: NativeParams, ctx: NativeCtx): Promise<Row[]> { … }
```

**Params.** `params` arrive the way the `openbb` connector sends them to the API:
- They are validated against the route's descriptor in `catalog/openbb.json`.
- Defaults the descriptor lists for this provider's params are applied.
- `string[]` params are arrays, dates are `YYYY-MM-DD`, and `provider` is removed.

Apply OpenBB's own defaults for any param that is absent, following the provider's `QueryParams` model and the standard model in `openbb_core/provider/standard_models/`.

**Return value.** Return exactly the rows the API puts in `results`:
- **Field names:** OpenBB's names, after `__alias_dict__`.
- **Values:** as pydantic serialises them:
  - dates as `"YYYY-MM-DD"`
  - naive datetimes as `"YYYY-MM-DDTHH:MM:SS"`
  - aware datetimes with their offset
  - numbers as numbers
  - omit what would be `None`
- **Transforms:** reproduce what `transform_data` and the models' validators do, such as percent ÷ 100, `replace(0, None)`, rounding and renames. The parity harness will tell you when you missed one.

**Rules.** `test/coverage.test.ts` enforces most of these:
- **Network:** only through `ctx.http`, which offers `json`, `text`, `bytes` and `response`. Never call `fetch` yourself; the recording and replay depend on it.
- **Time:** only through `ctx.now()`, never `Date.now()` or `new Date()`. Replays run at the recorded instant.
- **Credentials:** only through `ctx.credential('fred_api_key')`. Throw `MissingCredential` when a key is required and absent.
- **Caching:** cache directories and other slow, rarely changing downloads with `ctx.cache(key, ttlMs, load)`. Do not use module-level variables.
- **Headers:** send the headers the Python code sends. `BROWSER_UA` is there for sites that drop requests from non-browser user agents.
- **Unsupported params:** throw `NativeUnsupported` for a param value the port cannot handle. The connector then retries on the API.
- **Dependencies:** no new runtime dependencies without asking first. `src/lib` covers CSV, XML, XLSX and zip, and node-html-parser covers HTML.
- **Skipping:** skip a route only when it cannot work without Python. Examples are TLS impersonation through `curl_cffi` when plain requests are blocked, or PDF parsing, which has no shared helper yet. Put it in `skipped` with a reason.

## Parity cases

`src/<provider>/cases.json` lists calls that pin each ported route to OpenBB's live answer:

```json
[
  { "name": "historical-tsla-sep", "route": "equity/price/historical", "params": { "symbol": "TSLA", "start_date": "2026-09-01", "end_date": "2026-09-30" } },
  { "name": "quote-tsla", "route": "equity/price/quote", "params": { "symbol": "TSLA" },
    "compare": { "volatile": ["last_price", "bid", "ask", "volume"] },
    "reason": "live quote: OpenBB and the native side fetch seconds apart" }
]
```

**Coverage:**
- Every ported route needs at least one case.
- Add more cases where params change the code path, for example multiple symbols, an interval, an index symbol or an optional filter.

**Make cases deterministic:**
- Use fixed past date windows.
- Use small limits, so the recordings stay small.

**Default comparison.** It is strict:
- every column OpenBB fills
- the same rows, matched by `contract_symbol`, `symbol`+`date`, `date`, `symbol` or `id`, else in order
- the same values, with numbers to 1e-9 relative

**Relaxing it.** Relax only where it is honest, and say why in `reason`:
- `volatile`: live columns. Both sides must fill them with the same type; values are compared only with `liveTol`.
- `rows: "overlap"` with `minOverlap`: live lists whose membership moves.
- `keys`: name the row identity yourself.
- `ignore`: a column OpenBB fills that the port cannot reproduce. Explain why.
- `oracle: "none"`: OpenBB itself fails on this call, through a bug or a credential it lacks. The native rows are recorded and pinned as they are. Use it sparingly and say it in the PR.
- `fixture: false`: the response is too large to record (the limit is 768 KB compressed per body). Prefer smaller params.

## The loop

OpenBB's API runs on this machine at `http://127.0.0.1:6900`; never restart it.

```sh
pnpm --filter @openterminal/openbb-native parity cboe                   # live: every cboe case, OpenBB vs native
pnpm --filter @openterminal/openbb-native parity cboe --case quote-tsla --verbose
pnpm --filter @openterminal/openbb-native parity cboe --record           # write recordings for the passing cases
pnpm --filter @openterminal/openbb-native coverage                      # ported / skipped / todo per provider
pnpm vitest run connectors/openbb-native                                 # offline: replay every recording + the rules
```

- **Credentials:** keyed providers read them from the environment (`FRED_API_KEY`, `EIA_API_KEY`, …). Recordings store `{{fred_api_key}}` in place of the key.
- **Finishing a provider:** once every catalog route of a provider is ported or skipped, set `status: 'ported'`. The coverage test then holds it to that.
