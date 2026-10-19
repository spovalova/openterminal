// A routes connector that answers from memory, and the recipes that route to it. No network.
//
// `routesConnector(name, routes)` builds a v2 connector from a map of route → { params, fields, rows(params) };
// `recipesForRoutes(connector, descriptors, views)` writes one recipe per route (every param passed through as a
// template) so `{ recipe: 'quote', params }` resolves without recipes.yml, whose routes name openbb, yahoo and finnhub.
// `fakeConnector()` is the five-route connector the server tests share (search, quote, ohlcv, news, earnings).
import { z } from 'zod'
import { defineConnector, inferFrame, parseRecipes, type Connector, type Descriptor, type DescriptorParam, type Frame, type JsonSchemaObject, type Recipe, type ViewV2 } from '@terminal/core'

export type Row = Record<string, unknown>
export type FakeRoute = {
  /** One line for the catalog's search index. */
  summary?: string
  params: DescriptorParam[]
  fields: Descriptor['fields']
  providers?: string[]
  /** Rows for the validated params; throw to simulate a failing route. */
  rows: (params: Record<string, unknown>) => Row[] | Promise<Row[]>
}
export type Call = { route: string; params: Record<string, unknown> }

export function routesConnector(name: string, routes: Record<string, FakeRoute>, opts: { calls?: Call[]; onCall?: (route: string, params: Record<string, unknown>) => void | Promise<void> } = {}): Connector {
  const descriptors: Descriptor[] = Object.entries(routes).map(([route, r]) => ({ connector: name, route, summary: r.summary ?? `${name} ${route}`, params: r.params, providers: r.providers ?? [], fields: r.fields }))
  return defineConnector({
    name,
    config: z.object({}),
    descriptors: () => descriptors,
    call: async (route, params): Promise<Frame> => {
      const r = routes[route]
      if (!r) throw new Error(`${name} does not answer route "${route}"`)
      opts.calls?.push({ route, params })
      await opts.onCall?.(route, params)
      const rows = await r.rows(params)
      const descriptor = descriptors.find((d) => d.route === route)!
      return inferFrame(rows, { connector: name }, { descriptor })
    },
  })
}

function schemaFor(p: DescriptorParam): Record<string, unknown> {
  const base: Record<string, unknown> = p.type === 'string[]' ? { type: 'array', items: { type: 'string' }, minItems: 1 } : p.type === 'date' ? { type: 'string', format: 'date' } : { type: p.type }
  if (p.enum) base.enum = p.enum
  if (p.default !== undefined) base.default = p.default
  if (p.description) base.description = p.description
  return base
}

/** One recipe per route of a connector: the route's params as the recipe's, each passed through as `{name}`. */
export function recipesForRoutes(connector: string, routes: Record<string, FakeRoute>, views: Record<string, ViewV2> = {}): Recipe[] {
  return parseRecipes(
    Object.entries(routes).map(([route, r]) => {
      const params: JsonSchemaObject = { type: 'object', properties: Object.fromEntries(r.params.map((p) => [p.name, schemaFor(p)])), required: r.params.filter((p) => p.required).map((p) => p.name) }
      return { name: route, title: route, summary: `${route} from ${connector}`, params, view: views[route] ?? { preset: 'table' }, routes: [{ connector, route, params: Object.fromEntries(r.params.map((p) => [p.name, `{${p.name}}`])) }] }
    }),
  )
}

const S = (name: string) => ({ name, type: 'string' as const })
const N = (name: string) => ({ name, type: 'number' as const })
const T = (name: string) => ({ name, type: 'time' as const })
const symbols: DescriptorParam = { name: 'symbols', type: 'string[]', required: true }

/** The five routes the shared fake answers, with the v1 kinds' column names. */
export const FAKE_ROUTES: Record<string, FakeRoute> = {
  search: {
    summary: 'Resolve a free-text name or ticker to symbols.',
    params: [{ name: 'q', type: 'string', required: true }],
    fields: [S('query'), S('symbol'), S('name'), S('exchange')],
    rows: (p) => [{ query: String(p.q), symbol: String(p.q).toUpperCase().slice(0, 5), name: `${String(p.q)} Inc`, exchange: 'NMS' }],
  },
  quote: {
    summary: 'Latest price, day change, volume and market state per symbol.',
    params: [symbols],
    fields: [S('symbol'), N('price'), N('change_pct'), N('volume'), S('market_state'), N('extended_price'), N('extended_change_pct')],
    rows: (p) => (p.symbols as string[]).map((symbol, i) => ({ symbol, price: 100 + i, change_pct: 1.5, volume: 1000, market_state: 'REGULAR', extended_price: null, extended_change_pct: null })),
  },
  ohlcv: {
    summary: 'Price bars per symbol over a range at an interval.',
    params: [symbols, { name: 'interval', type: 'string', required: false, default: '1d', enum: ['1m', '5m', '15m', '1h', '1d', '1w'] }, { name: 'range', type: 'string', required: false, default: '3mo', enum: ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'] }],
    fields: [S('symbol'), T('time'), N('open'), N('high'), N('low'), N('close'), N('volume')],
    rows: (p) => (p.symbols as string[]).flatMap((symbol) => [0, 1, 2].map((i) => ({ symbol, time: 1_700_000_000_000 + i * 86_400_000, open: 10, high: 11, low: 9, close: 10 + i, volume: 100 }))),
  },
  news: {
    summary: 'Recent headlines per symbol, newest first.',
    params: [symbols, { name: 'limit', type: 'integer', required: false, default: 20 }],
    fields: [T('time'), S('headline'), S('source'), S('url'), S('symbol')],
    rows: (p) => [{ time: 1_700_000_000_000, headline: 'HBM demand', source: 'wire', url: 'https://example.com/1', symbol: (p.symbols as string[])[0] }],
  },
  earnings: {
    summary: 'Earnings dates inside a date window.',
    params: [symbols, { name: 'from', type: 'date', required: true }, { name: 'to', type: 'date', required: true }],
    fields: [S('symbol'), S('date'), S('session'), N('eps_estimate')],
    rows: (p) => (p.symbols as string[]).map((symbol) => ({ symbol, date: String(p.from), session: 'amc', eps_estimate: 1.23 })),
  },
}

export const FAKE_VIEWS: Record<string, ViewV2> = { ohlcv: { preset: 'price' }, quote: { preset: 'stat' } }

export function fakeConnector(opts: { name?: string; calls?: Call[] } = {}): Connector {
  return routesConnector(opts.name ?? 'fake', FAKE_ROUTES, { ...(opts.calls ? { calls: opts.calls } : {}) })
}

/** The recipes that route to `fakeConnector()`: search, quote, ohlcv, news, earnings. */
export function fakeRecipes(connector = 'fake'): Recipe[] {
  return recipesForRoutes(connector, FAKE_ROUTES, FAKE_VIEWS)
}
