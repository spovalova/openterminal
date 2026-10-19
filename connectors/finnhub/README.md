# @openterminal/connector-finnhub

Three [Finnhub](https://finnhub.io) REST paths as routes, answered through core's `inferFrame`: `quote`, `company-news`, `calendar/earnings`. It is the reference connector for a REST API described by a descriptor file: `src/descriptors.json` says what the routes take and return, `src/call.ts` is the three calls, `src/finnhub-api.ts` is the HTTP plumbing (URL building, rate limiting, one retry on 429).

## Getting a key

Register at <https://finnhub.io/register>; the API key is shown on the dashboard immediately, no card needed. Put it in `~/.openterminal/config.yml` under `connectors: [{ name: finnhub, config: { apiKey: ... } }]`, or paste it on the app's Data page. The free tier allows 60 calls per minute (30 per second burst), US-listed symbols only, and company news with day granularity for the last year. Every route here costs one call per symbol; the connector keeps itself under 30 requests per second and retries a `429` once after one second, but the registry cache is what keeps repeated refreshes cheap.

## What each route returns

| Route | Params | Notes |
|---|---|---|
| `quote` | `symbol` | Finnhub's letters as columns: `c` (last), `d`, `dp` (percent change, already a percent), `h`, `l`, `o`, `pc`, `t` (ms). No volume, market state or extended hours. `c === 0` means an unknown symbol and is an error, so a recipe falls through to the next alternative. |
| `company-news` | `symbol`, `from`, `to` | headlines between two dates (inclusive), newest first, with `source`, `summary`, `url`, `image`; `datetime` scaled from seconds to ms. |
| `calendar/earnings` | `from`, `to`, `symbol?` | rows from `earningsCalendar`: `date`, `epsActual`, `epsEstimate`, `hour` (`bmo`, `amc`, `dmh` or empty), `quarter`, `revenueActual`, `revenueEstimate`, `symbol`, `year`. |

The annotations in `packages/core/annotations.yml` (`finnhub:quote:*`, `finnhub:company-news:*`, `finnhub:calendar/earnings:*`) label the letters and set the units. The recipes name these routes as the last alternative for `quote`, `news` and `earnings`; `news` keeps the newest `limit` rows (Finnhub returns every headline of the window) and `earnings` turns `hour` into `session` in its pandas step.

## Scripts

- `pnpm test`: fixture tests in `test/`, no network. Fixtures under `test/fixtures/` are hand-written to the documented response shapes.
- `pnpm typecheck`
- `FINNHUB_API_KEY=... pnpm smoke`: live run that prints one frame per route.
