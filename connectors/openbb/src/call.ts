// OpenBB `call(route, params, ctx)` (PLAN.md sections 17 and 19): the native port of the provider when there is
// one, else one GET on the local API; the rows through core's `inferFrame` with the route's descriptor. No unit
// conversion here: frames carry provider values and the annotations say what they are.
import { inferFrame, type Ctx, type Descriptor, type Frame, type ValidatedParams } from '@openterminal/core'
import { ROUTE_PROVIDER_PREFERENCE, MissingCredential, applicableParams, createNativeCtx, defaultProvider, isNative, nativeDescriptorFor, nativeHandler, nativeParams, toQuery, withProvider } from '@openterminal/openbb-native'
import { descriptorFor, type LoadOptions } from './descriptors.js'
import { get, isDown, type Config } from './openbb-api.js'

type Row = Record<string, unknown>

export { ROUTE_PROVIDER_PREFERENCE, defaultProvider, withProvider, applicableParams, toQuery }

/** The one symbol a call was about, when it was about exactly one (a string, or a one-item list). */
export function singleSymbol(params: ValidatedParams): string | undefined {
  const v = params.symbol ?? params.symbols
  if (typeof v === 'string') return v.includes(',') ? undefined : v.trim() || undefined
  if (Array.isArray(v) && v.length === 1) return String(v[0]).trim() || undefined
  return undefined
}

/**
 * Single-symbol historical rows (bars, dividends, statements) carry no `symbol`: when the descriptor promises
 * one and no row has it, fill it from the params so multi-dataset widgets and transforms can group by it.
 */
export function fillSymbol(rows: Row[], descriptor: Descriptor | undefined, params: ValidatedParams): Row[] {
  if (!descriptor?.fields.some((f) => f.name === 'symbol')) return rows
  const symbol = singleSymbol(params)
  if (!symbol || rows.length === 0) return rows
  if (rows.some((r) => r.symbol !== undefined && r.symbol !== null && r.symbol !== '')) return rows
  return rows.map((r) => ({ symbol, ...r }))
}

/** A descriptor the frame can be shaped by: the catalog's, else a bare one so inference runs on the rows alone. */
function shapeOf(descriptor: Descriptor | undefined): Pick<Descriptor, 'fields'> | undefined {
  return descriptor && descriptor.fields.length > 0 ? descriptor : undefined
}

export type CallOptions = LoadOptions & {
  /** The fetch native handlers use (tests); the global one when omitted. */
  fetch?: typeof fetch
  /** Where credentials not in config.yml are looked up (`FRED_API_KEY`); process.env when omitted. */
  env?: Record<string, string | undefined>
}

/** The route's descriptor: the live API's (or its cache's), widened with the native providers, or the native one alone. */
export async function routeDescriptor(ctx: Ctx<Config>, route: string, opts: LoadOptions = {}): Promise<Descriptor | undefined> {
  const mode = ctx.config.native
  if (mode === 'only') return nativeDescriptorFor(route)
  const live = await descriptorFor(ctx, route, opts)
  if (mode === 'off') return live
  const native = nativeDescriptorFor(route)
  if (!live || !native) return live ?? native
  const extra = native.providers.filter((p) => !live.providers.includes(p))
  return extra.length ? { ...live, providers: [...live.providers, ...extra] } : live
}

async function callNative(route: string, provider: string, sent: ValidatedParams, ctx: Ctx<Config>, opts: CallOptions): Promise<unknown> {
  const handler = nativeHandler(route, provider)!
  const native = createNativeCtx({
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    credentials: ctx.config.credentials,
    env: opts.env ?? process.env,
    log: (m) => ctx.log(`${provider}: ${m}`),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })
  return handler(nativeParams(sent), native)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Answer a route: natively when the chosen provider is ported (PLAN.md section 19), else `GET /api/v1/<route>?…` on
 * the local OpenBB API. With no provider named, a ported one is preferred. A native failure is retried on the API
 * when it may be running; `results` that is one object (a few routes) becomes one row.
 */
export async function callRoute(route: string, params: ValidatedParams, ctx: Ctx<Config>, opts: CallOptions = {}): Promise<Frame> {
  const mode = ctx.config.native
  const descriptor = await routeDescriptor(ctx, route, opts)
  const ported = (provider: string): boolean => mode !== 'off' && isNative(route, provider)
  const sent = applicableParams(descriptor, withProvider(descriptor, params, ctx.config.providers?.[route], ported))
  const provider = typeof sent.provider === 'string' ? sent.provider : undefined
  let results: unknown
  if (provider && ported(provider)) {
    try {
      results = await callNative(route, provider, sent, ctx, opts)
    } catch (err) {
      if (mode === 'only' || err instanceof MissingCredential || isDown() || ctx.signal?.aborted) throw err
      ctx.log(`native ${provider} ${route} failed (${message(err)}); asking the OpenBB API`)
      try {
        results = await get<unknown>(ctx, `/${route.replace(/^\/+/, '')}`, toQuery(sent))
      } catch (apiErr) {
        throw new Error(`${provider} ${route}: ${message(err)} (OpenBB API: ${message(apiErr).split('\n')[0]})`, { cause: apiErr })
      }
    }
  } else {
    if (mode === 'only') throw new Error(`openbb ${route}${provider ? ` (${provider})` : ''} has no native port, and the connector is set to native: only`)
    results = await get<unknown>(ctx, `/${route.replace(/^\/+/, '')}`, toQuery(sent))
  }
  const list: unknown[] = Array.isArray(results) ? results : results === null || results === undefined ? [] : [results]
  const rows = list.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r))
  const filled = fillSymbol(rows, descriptor, params)
  // The descriptor's fields are the union over every provider's model; columns no row fills are dropped so a
  // yfinance quote is not 90 null columns wide. An empty result keeps the descriptor's columns so the shape shows.
  return inferFrame(filled, { connector: 'openbb' }, { descriptor: shapeOf(descriptor), dropEmpty: filled.length > 0 })
}
