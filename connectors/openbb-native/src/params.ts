// How a validated route call becomes the params a provider sees: which provider answers when the caller names none,
// and which params that provider takes. Shared by the openbb connector (production) and the parity harness, so both
// send exactly the same thing to OpenBB's API and to the native handler.
import type { Descriptor, ValidatedParams } from '@openterminal/core'

/**
 * The provider a route gets when the query names none, in order of preference: the keyless ones that answered the
 * probes (docs/notes/openbb-probe.md), then whatever the route lists first. OpenBB 5 rejects a call without a
 * provider when no default is configured on its side (422 "Field required").
 */
export const ROUTE_PROVIDER_PREFERENCE: readonly string[] = ['yfinance', 'nasdaq', 'cboe', 'sec', 'finra', 'federal_reserve', 'us_treasury', 'oecd', 'imf', 'ecb', 'bls', 'cftc', 'deribit', 'famafrench', 'tmx']

/** The default provider for a descriptor; with `isNative`, the first native provider in that order wins. */
export function defaultProvider(descriptor: Pick<Descriptor, 'providers'> | undefined, isNative?: (provider: string) => boolean): string | undefined {
  if (!descriptor || descriptor.providers.length === 0) return undefined
  const ordered = [...ROUTE_PROVIDER_PREFERENCE.filter((p) => descriptor.providers.includes(p)), ...descriptor.providers.filter((p) => !ROUTE_PROVIDER_PREFERENCE.includes(p))]
  return (isNative ? ordered.find(isNative) : undefined) ?? ordered[0]
}

/** Params with a provider: the caller's, else the one config.yml names for the route, else the route's default. */
export function withProvider(descriptor: Descriptor | undefined, params: ValidatedParams, configured?: string, isNative?: (provider: string) => boolean): ValidatedParams {
  if (typeof params.provider === 'string' && params.provider) return params
  const provider = (configured && descriptor?.providers.includes(configured) ? configured : undefined) ?? defaultProvider(descriptor, isNative)
  return provider ? { provider, ...params } : params
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

/** What a native handler gets: the shaped params without `provider`. */
export function nativeParams(params: ValidatedParams): Omit<ValidatedParams, 'provider'> {
  const { provider: _provider, ...rest } = params
  return rest
}
