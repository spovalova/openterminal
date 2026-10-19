// OpenBB `call(route, params, ctx)` (PLAN.md section 17): one GET per route, the `results` list through core's
// `inferFrame` with the route's descriptor. No unit conversion here: frames carry provider values and the
// annotations say what they are.
import { inferFrame, type Ctx, type Descriptor, type Frame, type ValidatedParams } from '@terminal/core'
import { descriptorFor, type LoadOptions } from './descriptors.js'
import { get, type Config } from './openbb-api.js'

type Row = Record<string, unknown>

/**
 * The provider a v2 route gets when the query names none, in order of preference: the keyless ones that answered
 * the probes (docs/notes/openbb-probe.md), then whatever the route lists first. OpenBB 5 rejects a call without
 * a provider when no default is configured on its side (422 "Field required").
 */
export const ROUTE_PROVIDER_PREFERENCE: readonly string[] = ['yfinance', 'nasdaq', 'cboe', 'sec', 'finra', 'federal_reserve', 'us_treasury', 'oecd', 'imf', 'ecb', 'bls', 'cftc', 'deribit', 'famafrench', 'tmx']

export function defaultProvider(descriptor: Pick<Descriptor, 'providers'> | undefined): string | undefined {
  if (!descriptor || descriptor.providers.length === 0) return undefined
  return ROUTE_PROVIDER_PREFERENCE.find((p) => descriptor.providers.includes(p)) ?? descriptor.providers[0]
}

/** Params with a provider: the caller's, else the one config.yml names for the route, else the route's default. */
export function withProvider(descriptor: Descriptor | undefined, params: ValidatedParams, configured?: string): ValidatedParams {
  if (typeof params.provider === 'string' && params.provider) return params
  const provider = (configured && descriptor?.providers.includes(configured) ? configured : undefined) ?? defaultProvider(descriptor)
  return provider ? { provider, ...params } : params
}

/** Validated params → query-string values: arrays joined by commas, booleans and numbers as text, `provider` passed through. */
export function toQuery(params: ValidatedParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      const joined = v.map((x) => String(x).trim()).filter(Boolean).join(',')
      if (joined) out[k] = joined
    } else out[k] = String(v)
  }
  return out
}

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

/**
 * Drop params the chosen provider does not take: validation applies every default in the descriptor (the union
 * over providers), and a yfinance-only `extended_hours=false` has no business on a cboe call.
 */
export function applicableParams(descriptor: Descriptor | undefined, params: ValidatedParams): ValidatedParams {
  const provider = typeof params.provider === 'string' ? params.provider : undefined
  if (!descriptor || !provider) return params
  const out: ValidatedParams = {}
  for (const [k, v] of Object.entries(params)) {
    const p = descriptor.params.find((x) => x.name === k)
    if (p?.providers && !p.required && !p.providers.includes(provider)) continue
    out[k] = v
  }
  return out
}

/** A descriptor the frame can be shaped by: the catalog's, else a bare one so inference runs on the rows alone. */
function shapeOf(descriptor: Descriptor | undefined): Pick<Descriptor, 'fields'> | undefined {
  return descriptor && descriptor.fields.length > 0 ? descriptor : undefined
}

/** `GET /api/v1/<route>?…` → Frame. `results` that is one object (a few routes) becomes one row. */
export async function callRoute(route: string, params: ValidatedParams, ctx: Ctx<Config>, opts: LoadOptions = {}): Promise<Frame> {
  const descriptor = await descriptorFor(ctx, route, opts)
  const sent = applicableParams(descriptor, withProvider(descriptor, params, ctx.config.providers?.[route]))
  const results = await get<unknown>(ctx, `/${route.replace(/^\/+/, '')}`, toQuery(sent))
  const list: unknown[] = Array.isArray(results) ? results : results === null || results === undefined ? [] : [results]
  const rows = list.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r))
  const filled = fillSymbol(rows, descriptor, params)
  // The descriptor's fields are the union over every provider's model; columns no row fills are dropped so a
  // yfinance quote is not 90 null columns wide. An empty result keeps the descriptor's columns so the shape shows.
  return inferFrame(filled, { connector: 'openbb' }, { descriptor: shapeOf(descriptor), dropEmpty: filled.length > 0 })
}
