# Writing a connector

A connector is a plugin that exposes **routes** (the endpoints of one provider API) and answers them with **frames**. It runs inside the server process, holds its own config (usually an API key), and consists of two things: a list of **descriptors** that says what it answers, and one `call(route, params, ctx)` that answers. There is no catalog of kinds to implement: a connector publishes whatever its source has, the agent finds routes by searching the catalog, and **recipes** (`packages/core/recipes.yml`) name the routes the common questions use. Units and labels come from **annotations** (`packages/core/annotations.yml`), not from code in the connector.

Contents: [the contract](#the-contract) · [descriptors](#descriptors) · [call and inferFrame](#call-and-inferframe) · [the ctx](#the-ctx) · [annotations](#annotations) · [recipes](#recipes) · [a REST API by descriptor file (worked example)](#worked-example-a-rest-api-by-descriptor-file) · [an OpenAPI document](#an-openapi-document) · [errors and fallback](#errors-and-fallback) · [config](#config) · [testing with fixtures](#testing-with-recorded-fixtures) · [package layout and registration](#package-layout-and-registration) · [limits](#limits)

## The contract

One helper, `defineConnector`, imported from `@terminal/core`:

```ts
// connectors/shape/src/index.ts
import { z } from 'zod'
import { defineConnector, inferFrame, parseDescriptors } from '@terminal/core'
import descriptors from './descriptors.json' with { type: 'json' }

export default defineConnector({
  // Unique, lowercase kebab-case. Used in config.yml and stamped into frame.meta.connector.
  name: 'shape',
  // Zod schema for the connector's config. Use z.object({}) when it needs none.
  config: z.object({ apiKey: z.string().min(1) }),
  // The routes you answer. A file for a REST API you describe by hand; a generator for one that describes itself.
  descriptors: () => parseDescriptors(descriptors),
  // Answer one route. `params` are already validated against the route's descriptor.
  call: async (route, params, ctx) => {
    const rows = (await ctx.http.get(`https://api.shape.dev/${route}?symbol=${params.symbol}`, { headers: { 'X-Token': ctx.config.apiKey }, signal: ctx.signal })) as Record<string, unknown>[]
    return inferFrame(rows, { connector: 'shape' }, { descriptor: descriptors.find((d) => d.route === route) })
  },
})
```

The exact types, from `packages/core/src/connector.ts`:

```ts
type CallHandler<C> = (route: string, params: ValidatedParams, ctx: Ctx<C>) => Promise<Frame>

type ConnectorDef<C> = {
  name: string
  config: z.ZodType<C, any>
  descriptors: (ctx?: Ctx<C>) => Descriptor[] | Promise<Descriptor[]>
  call: CallHandler<C>
  health?: (ctx: Ctx<C>) => Promise<string | void>
}

function defineConnector<C>(def: ConnectorDef<C>): Connector<C>
```

You do not call `call` yourself. The server builds a registry, registers each configured connector with its config, asks it for its descriptors once (with the connector's ctx, so a generator can reach its service), and calls `call` when a route query arrives, with the params validated against the descriptor. `descriptors` is called once per registration and memoised.

## Descriptors

A descriptor is one route: its path, params, providers, response fields. The format (`packages/core/src/descriptor.ts`):

```ts
type Descriptor = {
  connector: string            // 'shape'
  route: string                // 'quote', 'equity/price/historical'
  summary: string              // one line; what find_route ranks on, with the description, params and fields
  description?: string
  params: Array<{ name: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'string[]'; enum?: string[]; default?: unknown; required: boolean; description?: string; providers?: string[] }>
  providers: string[]          // [] for connectors without the concept (OpenBB has one per route)
  fields: Array<{ name: string; type: 'number' | 'string' | 'time' | 'boolean'; description?: string }>
  liveness?: { checkedAt: number; ok: boolean; rows?: number; ms?: number; error?: string; sampleColumns?: string[] }
}
```

What the registry does with it:

- **Validation.** `parseParams(descriptor, params)` applies defaults, demands required params, coerces types (`"5"` → `5` for an `integer`, `"MU,NVDA"` → `['MU', 'NVDA']` for a `string[]`), checks enums, and refuses unknown params. `provider` is accepted only when `providers` lists it. Invalid params never reach `call`.
- **Catalog.** Every descriptor of every healthy connector is indexed for `find_route` (BM25 over the path, summary, description, param and field names). Write the summary for a trader searching ("corporate bond prices by issuer", not "GET /bonds"). The Data page lists the same catalog.
- **Liveness.** `pnpm probe` calls every route once with sample params and records whether it answered; dead routes are hidden from the agent until the next probe.
- **Fields.** The listed fields type the frame's columns (a `time` field becomes an epoch-ms column whatever the provider sends). Fields may be empty (`[]`): inference fills them from the rows.

Params the recipes pass as lists (`symbols`) should be `string[]`; `call` receives an array and joins it however the provider wants.

## `call` and `inferFrame`

`call` returns a `Frame`: typed columns plus rows. Build it with `inferFrame(rows, meta, { descriptor, only?, dropEmpty? })` from the provider's row objects:

- Columns come from the descriptor's fields in order, then any extra keys the rows carry (typed from the first non-null value; a string every row parses as a date is `time`).
- Nested objects are flattened one level with dotted names (`financialData.grossMargins`); arrays of scalars are joined. Flatten deeper yourself when a module nests further (yahoo's `flattenDeep`).
- Dates parse with `parseTime`: a date-only string is New York midnight, a zone-less datetime is New York wall time, anything with a zone is itself. Epoch seconds stay numbers: scale them to ms in `call` (finnhub's `secondsToMs`) or type the field `number`.
- `dropEmpty: true` drops union columns no row fills (OpenBB's fields are the union over its providers' models; a yfinance quote would otherwise be ninety null columns). An empty result keeps the descriptor's columns so the shape still shows.

Do **not** convert units in `call`. Return provider values as they are (a fraction stays `0.0563`) and let an annotation say what the column is; the registry scales fractions to percent and stamps the unit on the column. Sorting, cutting to a limit, picking one expiration: those belong in the recipe's data graph (pandas), not in the connector. A connector is a faithful window onto its source.

The frame's `meta.connector` is restamped by the registry, as are `ttl` (from `ttlForRoute`: quotes 10 s, intraday bars 1 min, daily 10 min, news 5 min, calendars 1 h, fundamentals and ownership 1 day) and `lineage` (connector, route, params, provider).

## The ctx

The third argument to `call` and the argument to `descriptors` and `health`:

```ts
type Ctx<C> = {
  http: { get(url: string, init?: RequestInit): Promise<unknown> }
  config: C
  log(msg: string): void
  signal?: AbortSignal
}
```

- **`http.get(url, init?)`**: GET the URL and parse the body as JSON; returns the raw text when the body is not JSON. Throws `HttpError` (`status`, `url`, `body` truncated to 500 chars) on any non-2xx status. Use it for every request so tests can swap in a fake. Put headers in `init`. The return type is `unknown`; cast or validate it to your API's shape.
- **`config`**: the parsed output of your config schema. Keys live here and nowhere else.
- **`log(msg)`**: one line to the server log, prefixed with your connector name.
- **`signal`**: an `AbortSignal` when the run can be cancelled. Pass it through: `http.get(url, { signal })`.

If your source has an official SDK (yahoo-finance2) you may use it instead of `http.get`; then your tests mock the SDK rather than `http`.

## Annotations

`packages/core/annotations.yml` is a map from `connector:route-glob:field` to field config: `unit` (`fraction`, `percent`, `ratio`, `usd`, `shares`, `count`, `days`, `years`, `bps`), `label`, `format` (`price`, `change`, `percent`, `compact`, `integer`, `ratio`, `date`, `time`, `link`), `priority` (1 shows first and survives the narrowest widget, 9 last), `key` (the stat view's headline column), `hidden`, `role` (`x` for a numeric axis such as strike or maturity). Globs match across `/`; `*` alone matches everything; a more specific rule wins field by field:

```yaml
"*:*:volume": { unit: shares, format: compact, label: Volume, priority: 3 }
"shape:quote:last": { unit: usd, format: price, label: Last, priority: 1, key: true }
"shape:quote:changePercent": { unit: fraction, format: change, label: "Chg %", priority: 2 }
```

The registry applies them to every route frame: a `fraction` is multiplied by 100 and stamped `percent`, so previews, tables and the agent never see a fraction. A column without an annotation is shown as-is and the prompt tells the agent it carries no unit guarantee. Add annotations for every field a recipe's view names; the core test `annotations.test.ts` checks that. Users add their own in `~/.terminal/annotations.yml`.

## Recipes

A recipe is a saved query: a title template, a param schema (JSON schema), a preset and size, and ordered route alternatives with param mappings, optionally a data graph with a pandas step. The built-in ones are in `packages/core/recipes.yml`; promote any widget to a user recipe from the Data page and it lands in `~/.terminal/recipes.yml`. To make a recipe reach your connector, add a route alternative:

```yaml
  - name: quote
    routes:
      - connector: yahoo
        route: quote
        params: { symbols: "{symbols}" }
      - connector: shape
        route: quote
        params: { symbol: "{symbols|first}" }      # templates over the recipe params, with filters (first, start_date, map:, …)
```

The registry tries alternatives in order and falls through on error or an empty frame; a route's `rename` (`{ date: time }`) keeps the column names the recipe's transforms expect whichever alternative answered. `pnpm query <recipe> key=value …` runs one; `packages/core/test/recipes.test.ts` checks the routes a recipe names exist on the connectors it names.

## Worked example: a REST API by descriptor file

A complete connector for a hypothetical JSON API: `GET https://api.example-quotes.dev/v1/quote/<SYMBOL>?token=<key>` returns `{ symbol, last, prevClose, changePercent, volume, session }` where `changePercent` is a fraction and `session` is `pre`, `open`, `post` or `closed`; `GET /v1/bars/<SYMBOL>?from=&to=&token=` returns `[{ date, open, high, low, close, volume }]`.

The descriptor file:

```json
[
  {
    "connector": "example",
    "route": "quote",
    "summary": "Latest quote for one symbol: last, previous close, day change, volume, session",
    "params": [{ "name": "symbol", "type": "string", "required": true, "description": "Ticker symbol" }],
    "providers": [],
    "fields": [
      { "name": "symbol", "type": "string" },
      { "name": "last", "type": "number" },
      { "name": "prevClose", "type": "number" },
      { "name": "changePercent", "type": "number", "description": "A fraction: 0.0563 is 5.63%" },
      { "name": "volume", "type": "number" },
      { "name": "session", "type": "string", "description": "pre, open, post or closed" }
    ]
  },
  {
    "connector": "example",
    "route": "bars",
    "summary": "Daily price bars for one symbol between two dates",
    "params": [
      { "name": "symbol", "type": "string", "required": true },
      { "name": "from", "type": "date", "required": true },
      { "name": "to", "type": "date", "required": false }
    ],
    "providers": [],
    "fields": [
      { "name": "symbol", "type": "string" },
      { "name": "date", "type": "time" },
      { "name": "open", "type": "number" },
      { "name": "high", "type": "number" },
      { "name": "low", "type": "number" },
      { "name": "close", "type": "number" },
      { "name": "volume", "type": "number" }
    ]
  }
]
```

The connector:

```ts
// connectors/example/src/index.ts
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { defineConnector, inferFrame, parseDescriptors, type Descriptor } from '@terminal/core'

const BASE = 'https://api.example-quotes.dev/v1'
let memo: Descriptor[] | undefined
const descriptors = () => (memo ??= parseDescriptors(JSON.parse(readFileSync(new URL('./descriptors.json', import.meta.url), 'utf8'))))

export default defineConnector({
  name: 'example',
  config: z.object({ apiKey: z.string().min(1) }),
  descriptors,
  call: async (route, params, { http, config, signal }) => {
    const descriptor = descriptors().find((d) => d.route === route)
    const symbol = String(params.symbol).toUpperCase()
    const token = `token=${config.apiKey}`
    if (route === 'quote') {
      const q = (await http.get(`${BASE}/quote/${symbol}?${token}`, { signal })) as Record<string, unknown>
      return inferFrame([{ ...q, symbol }], { connector: 'example' }, { descriptor })
    }
    if (route === 'bars') {
      const qs = new URLSearchParams({ from: String(params.from), ...(params.to ? { to: String(params.to) } : {}) })
      const rows = (await http.get(`${BASE}/bars/${symbol}?${qs}&${token}`, { signal })) as Record<string, unknown>[]
      // the rows carry no symbol; add it so multi-dataset widgets and transforms can group by it
      return inferFrame(rows.map((r) => ({ symbol, ...r })), { connector: 'example' }, { descriptor })
    }
    throw new Error(`example does not answer route "${route}"`)
  },
})
```

The annotations, in `packages/core/annotations.yml` (or the user file):

```yaml
"example:quote:last": { unit: usd, format: price, label: Last, priority: 1, key: true }
"example:quote:prevClose": { unit: usd, format: price, label: Prev close, priority: 4 }
"example:quote:changePercent": { unit: fraction, format: change, label: "Chg %", priority: 2 }
"example:quote:session": { label: Session, priority: 5 }
"example:bars:close": { unit: usd, format: price, label: Close, priority: 2, key: true }
```

And a route alternative on the `quote` and `ohlcv` recipes (with `rename: { date: time }` on `bars`, since the price recipes read `time`). Things to notice:

- The connector never scales `changePercent`: the annotation says it is a fraction and the registry turns it into `5.63` with the unit `percent`.
- `inferFrame` with the descriptor types `date` as `time` and parses the provider's `2026-10-16` as New York midnight.
- An unknown symbol should throw (the registry falls through to the next alternative); a provider that answers an empty list for a quiet window should return the empty frame.

## An OpenAPI document

A source that describes itself needs no descriptor file. `descriptorsFromOpenApi(doc, connector, { prefix, skipParams, resultsKey })` turns an OpenAPI document into descriptors: one per GET route whose 200 response is a results envelope, per-provider param variants collapsed to one entry with a `providers` list, `date`/`date-time` fields typed `time`. The OpenBB connector (`connectors/openbb/src/descriptors.ts`) fetches `${baseUrl}/openapi.json` in `descriptors(ctx)`, caches the result under `~/.terminal/catalog/<name>.json` keyed by the document's version and a fingerprint of its paths, and serves the cache when the API is down. Its `call` is forty lines: `GET /api/v1/<route>?…` with the validated params (arrays joined by commas, `provider` passed through, params the chosen provider does not take dropped) and the `results` list through `inferFrame`. A new OpenAPI-described source is that file with a different base URL and envelope rule.

## Health (optional)

A connector that depends on a local service can add a `health` probe:

```ts
health: async (ctx) => {
  await ctx.http.get(`${ctx.config.baseUrl}/api/v1/coverage/providers`, { signal: ctx.signal })
  return `OpenBB API at ${ctx.config.baseUrl}` // one line for the Data page, or return nothing
},
```

The registry runs it with a 2 s timeout when the Data page loads, never on the query path. Throw with a message that tells the user what to do (`connectors/openbb` throws the two install commands).

## Errors and fallback

A recipe tries its route alternatives in order and falls through when `call` throws or answers no rows (when another alternative is left). A route query has no fallback: the error reaches the widget. So:

- **Throw when you cannot answer**: the key was rejected (`HttpError` 401 or 403), the source is down, the symbol is unknown. Throw an `Error` with a message a human can read; it is logged as `[<name>] <route> failed: <message>` and shown on the widget when every alternative fails.
- **For a list of symbols, a partial frame is a valid answer**: fan out, `ctx.log` each failure, return the rows you got, and throw only when every symbol failed (`fanOut` in `connectors/yahoo/src/fanout.ts` is the pattern).
- **Do not catch and return an empty frame** when the source errored. An empty frame is a correct "nothing in this window".
- **Do not retry forever.** One retry on a 429 or 5xx is reasonable (finnhub's `get`); respect `ctx.signal`.
- A local service that is down should trip a breaker (OpenBB: 30 s) so every call in that window fails at once and the registry falls back at no cost.

## Config

Connectors are listed in `~/.terminal/config.yml` (override the directory with `TERMINAL_HOME`). Order is routing priority for the Data page's catalog display; the recipes name their own order.

```yaml
# ~/.terminal/config.yml
llm:
  provider: anthropic           # or openai
  model: claude-opus-5-5
  apiKey: sk-ant-...            # or set ANTHROPIC_API_KEY in the environment
connectors:
  - name: openbb                # routes first when the local API is running
    config:
      baseUrl: http://127.0.0.1:6900
      providers:                # provider per route when a query names none
        equity/price/quote: fmp
  - name: yahoo                 # no config needed
  - name: finnhub
    config:
      apiKey: your-finnhub-key
```

On startup the server registers each listed connector and the registry parses the config with your schema: parse succeeds → status `ok`, its routes join the catalog; parse fails → `missing_config` with the Zod issues as the error text, the connector is listed but never called. So "a key is required" is expressed entirely by the schema: `z.object({ apiKey: z.string().min(1) })`. The Data page (`PUT /api/connectors/:name/config`) saves a key into `config.yml` and re-registers the connector live. Keys never leave the machine.

## Testing with recorded fixtures

Tests never hit the network. Record a real response once into `test/fixtures/`, then inject a fake `ctx.http.get` that serves it. Run through a `ConnectorRegistry` so the test also exercises param validation, annotations and lineage, or call `call` directly to assert on a thrown error.

```ts
// connectors/example/test/quote.test.ts
import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, frameToObjects, type Http } from '@terminal/core'
import { builtinAnnotations } from '@terminal/core/node'
import example from '../src/index.js'
import quoteMU from './fixtures/quote-MU.json'

/** An Http whose get() serves recorded bodies by exact URL and throws on anything else. */
function fakeHttp(responses: Record<string, unknown>): Http {
  return {
    async get(url) {
      if (url in responses) return responses[url]
      throw new Error(`unexpected request: ${url}`)
    },
  }
}

const URL_MU = 'https://api.example-quotes.dev/v1/quote/MU?token=test-key'

describe('example quote', () => {
  it('maps the recorded response to a frame, scaled by the annotations', async () => {
    const registry = new ConnectorRegistry({ http: fakeHttp({ [URL_MU]: quoteMU }), annotations: builtinAnnotations() })
    expect(registry.register(example, { apiKey: 'test-key' }).status).toBe('ok')
    const frame = await registry.run({ connector: 'example', route: 'quote', params: { symbol: 'mu' } })
    expect(frameToObjects(frame)[0]).toMatchObject({ symbol: 'MU', last: 101.2, changePercent: -1.3 })
    expect(frame.meta.fields?.changePercent).toMatchObject({ unit: 'percent' })
    expect(frame.meta.lineage).toMatchObject({ connector: 'example', route: 'quote' })
  })

  it('refuses unknown params before calling and reports a missing key as missing_config', async () => {
    const registry = new ConnectorRegistry({ http: fakeHttp({}) })
    expect(registry.register(example, {}).status).toBe('missing_config')
    registry.register(example, { apiKey: 'test-key' })
    await expect(registry.run({ connector: 'example', route: 'quote', params: { ticker: 'MU' } })).rejects.toThrow(/unknown param "ticker"/)
  })
})
```

`pnpm test` at the repo root runs every `connectors/*/test/**/*.test.ts` through Vitest. To record fixtures, write a one-off script under `scripts/` that calls the live API with a real key and writes the JSON body; keep fixtures small and strip anything personal. Never commit a key. `pnpm --filter @terminal/connector-<name> smoke` is the convention for a live run.

## Package layout and registration

Connector packages live under `connectors/<name>` and are named `@terminal/connector-<name>`. The default export of `src/index.ts` is the connector.

```
connectors/example/
  package.json
  tsconfig.json
  src/index.ts                 default export: defineConnector({...})
  src/descriptors.json         the routes
  test/quote.test.ts
  test/fixtures/quote-MU.json
  scripts/smoke.ts             optional: a live run
```

```json
{
  "name": "@terminal/connector-example",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "@terminal/core": "workspace:*", "zod": "^4.6.7" },
  "devDependencies": { "@types/node": "^22.0.0", "typescript": "~5.9.0", "vitest": "^5.0.5" }
}
```

The server does not discover connectors; it holds a built-in map from config name to module in `packages/server/src/connectors.ts`. To make `example` loadable from `config.yml`, add it there and add `"@terminal/connector-example": "workspace:*"` to `packages/server/package.json`. Discovery through a plugin loader is planned for later; `defineConnector` is the stable contract.

Checklist before opening a pull request:

1. `pnpm typecheck`, `pnpm lint` and `pnpm test` are green from the repo root.
2. Fixture tests cover every route you answer, plus one failure case and the missing-key case.
3. `pnpm query <name> <route> key=value …` prints a frame with a real key; `pnpm probe` marks the routes alive.
4. Annotations for every field a recipe's view will name; a recipe alternative where the route serves a recipe's question; `pnpm readme:recipes` when you added a recipe.
5. The connector's row in the README's connectors table and `docs/architecture.md`.

## Limits

- **No streaming.** Widgets poll on the route's TTL. A connector answers one request and returns.
- **No unit conversion, sorting or selection in the connector.** Units are annotations; selection is a recipe's pandas step. The exception is a shape the frame needs to be a frame at all (seconds to milliseconds, a missing symbol column).
- **No execution.** Research and monitoring only; no broker connectors.
- **Keys never leave the machine.** A connector may call only the source it is for, with the key the user gave it.
