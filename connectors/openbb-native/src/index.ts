// Native OpenBB providers (PLAN.md section 19): TypeScript ports of OpenBB Platform's provider code, answering the
// same routes with the same rows as `openbb-api`, without Python. The openbb connector asks here first and falls back
// to a running OpenBB API for anything not ported. Apache-2.0; see NOTICE.
import { parseDescriptors, type Descriptor } from '@openterminal/core'
import catalogJson from '../catalog/openbb.json' with { type: 'json' }
import COMMANDS from './commands/index.js'
import { PROVIDERS } from './providers.js'
import type { NativeHandler, ProviderDef } from './types.js'

export { defineProvider, NativeUnsupported, MissingCredential, type NativeCtx, type NativeHandler, type NativeParams, type ProviderDef, type ProviderPart, type Row } from './types.js'
export { createNativeHttp, NativeHttpError, withQuery, BROWSER_UA, type NativeHttp, type RequestOptions, type Query } from './http.js'
export { createNativeCtx, type NativeCtxOptions } from './ctx.js'
export { ROUTE_PROVIDER_PREFERENCE, defaultProvider, withProvider, applicableParams, toQuery, nativeParams } from './params.js'
export { COMMANDS, PROVIDERS }

const pairKey = (route: string, provider: string): string => `${provider}:${route}`

let handlers: Map<string, NativeHandler> | undefined
function handlerMap(): Map<string, NativeHandler> {
  if (!handlers) {
    handlers = new Map()
    for (const p of PROVIDERS) for (const [route, h] of Object.entries(p.routes)) handlers.set(pairKey(route, p.name), h)
  }
  return handlers
}

/** The native handler for one route and provider, if that pair is ported. */
export function nativeHandler(route: string, provider: string): NativeHandler | undefined {
  return handlerMap().get(pairKey(route, provider))
}

export function isNative(route: string, provider: string): boolean {
  return handlerMap().has(pairKey(route, provider))
}

/** The native handler for a route that takes no provider (an extension's own command), if it is ported. */
export function nativeCommand(route: string): NativeHandler | undefined {
  return Object.prototype.hasOwnProperty.call(COMMANDS.routes, route) ? COMMANDS.routes[route] : undefined
}

export function isNativeCommand(route: string): boolean {
  return nativeCommand(route) !== undefined
}

export function nativeProvider(name: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.name === name)
}

/** Every ported (route, provider) pair. */
export function nativePairs(): { route: string; provider: string }[] {
  return PROVIDERS.flatMap((p) => Object.keys(p.routes).map((route) => ({ route, provider: p.name })))
}

let snapshot: Descriptor[] | undefined
/** OpenBB 5.0.0's route catalog (catalog/openbb.json): every route with its params, providers and fields. */
export function snapshotDescriptors(): Descriptor[] {
  snapshot ??= parseDescriptors((catalogJson as { descriptors: unknown }).descriptors)
  return snapshot
}

/** A descriptor narrowed to some of its providers: their params only, `providers` lists on params trimmed to match. */
export function narrowDescriptor(d: Descriptor, providers: readonly string[]): Descriptor {
  const keep = new Set(providers)
  return {
    ...d,
    providers: d.providers.filter((p) => keep.has(p)),
    params: d.params
      .filter((p) => p.required || !p.providers || p.providers.some((x) => keep.has(x)))
      .map((p) => (p.providers ? { ...p, providers: p.providers.filter((x) => keep.has(x)) } : p)),
  }
}

let narrowed: Map<string, Descriptor> | undefined
function nativeByRoute(): Map<string, Descriptor> {
  if (!narrowed) {
    narrowed = new Map()
    for (const d of snapshotDescriptors()) {
      if (d.providers.length === 0) {
        if (isNativeCommand(d.route)) narrowed.set(d.route, d)
        continue
      }
      const native = d.providers.filter((p) => isNative(d.route, p))
      if (native.length > 0) narrowed.set(d.route, narrowDescriptor(d, native))
    }
  }
  return narrowed
}

/** The snapshot's routes that have at least one native provider, each narrowed to its native providers, and the native commands. */
export function nativeDescriptors(): Descriptor[] {
  return [...nativeByRoute().values()]
}

/** One route's native descriptor, when any of its providers is ported or it is a native command. */
export function nativeDescriptorFor(route: string): Descriptor | undefined {
  return nativeByRoute().get(route)
}

/**
 * Live descriptors from a running OpenBB API plus the native ones: a route both have gains the native providers the
 * live one lacks (an extension not installed on the Python side); a route only the snapshot has is added narrowed.
 */
export function mergeNativeDescriptors(live: readonly Descriptor[], native: readonly Descriptor[] = nativeDescriptors()): Descriptor[] {
  if (live.length === 0) return [...native]
  const byRoute = new Map(live.map((d) => [d.route, d]))
  const out = [...live]
  for (const n of native) {
    const l = byRoute.get(n.route)
    if (!l) out.push(n)
    else {
      const extra = n.providers.filter((p) => !l.providers.includes(p))
      if (extra.length) out[out.indexOf(l)] = { ...l, providers: [...l.providers, ...extra] }
    }
  }
  return out
}
