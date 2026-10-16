# @terminal/connector-finnhub

Answers `quote`, `news`, and `earnings` from [Finnhub](https://finnhub.io). It is the reference connector: `src/index.ts` is the three handlers, `src/finnhub-api.ts` is the HTTP plumbing (URL building, rate limiting, one retry on 429, per-symbol fan-out).

## Getting a key

Register at <https://finnhub.io/register>; the API key is shown on the dashboard immediately, no card needed. Put it in `~/.terminal/config.yml` under `connectors: [{ name: finnhub, config: { apiKey: ... } }]`, or paste it on the app's connectors page. The free tier allows 60 calls per minute (30 per second burst), US-listed symbols only, and company news with day granularity for the last year. Every kind here costs one call per symbol, so a 20-symbol news widget spends a third of the minute's budget; the connector keeps itself under 30 requests per second and retries a `429` once after one second, but the registry cache is what keeps repeated refreshes cheap.

## What each kind returns

| Kind | Endpoint | Notes |
|---|---|---|
| `quote` | `/quote` | `price` = `c`, `change_pct` = `dp`. Finnhub has no volume, market state, or extended-hours fields on this endpoint, so those columns are `null`. `c === 0` means an unknown symbol and the row is skipped. Yahoo should sit ahead of Finnhub for `quote`; this one is the fallback. |
| `news` | `/company-news` | One call per symbol over the last 7 days (ending today, UTC), merged, newest first, deduplicated by `url`, cut to `limit`. |
| `earnings` | `/calendar/earnings` | One call per symbol over `from`..`to`. `hour` `bmo`/`amc` becomes `session`; `dmh` or empty becomes `null`. `eps_estimate` is `epsEstimate` or `null`. |

A failing symbol is logged and skipped; a query only fails when every symbol fails.

## Scripts

- `pnpm test`: fixture tests in `test/`, no network. Fixtures under `test/fixtures/` are hand-written to the documented response shapes.
- `pnpm typecheck`
- `FINNHUB_API_KEY=... pnpm smoke`: live run that prints one frame per kind.
