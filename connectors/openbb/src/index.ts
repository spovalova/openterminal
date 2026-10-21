// OpenBB Platform connector: every OpenBB route (PLAN.md sections 17 and 19). Routes whose provider is ported to
// TypeScript (@openterminal/openbb-native) are answered in process with no install; the rest go to a local
// `openbb-api` when one runs, described by its own OpenAPI document. Rows become frames through core's `inferFrame`.
// Keyless by default (yfinance, nasdaq, sec, finra, cboe, federal_reserve, oecd, …). See README.md.
import { defineConnector } from '@openterminal/core'
import { mergeNativeDescriptors, nativeDescriptors, nativePairs } from '@openterminal/openbb-native'
import { callRoute } from './call.js'
import { descriptorsFor } from './descriptors.js'
import { ConfigSchema, probeProviders, type Config } from './openbb-api.js'

export { ConfigSchema, DEFAULT_BASE_URL, INSTALL_HINT, type Config } from './openbb-api.js'
export { loadDescriptors, descriptorsFor, descriptorFor, resetDescriptors, defaultCatalogPath, fingerprintOpenApi, readCatalogCache, writeCatalogCache, type CatalogCache, type LoadResult } from './descriptors.js'
export { callRoute, routeDescriptor, toQuery, fillSymbol, singleSymbol, applicableParams, defaultProvider, withProvider, ROUTE_PROVIDER_PREFERENCE, type CallOptions } from './call.js'

export default defineConnector<Config>({
  name: 'openbb',
  config: ConfigSchema,

  // Native routes need nothing running. GET /coverage/providers: small, proves the prefix, and lists what the OpenBB
  // side has installed; when it is down and routes are native, that is fine and the detail says so.
  health: async (ctx) => {
    const native = ctx.config.native === 'off' ? 0 : nativePairs().length
    const nativeLine = native ? `${native} routes native` : ''
    if (ctx.config.native === 'only') return nativeLine || 'no native routes yet'
    let providers: string[]
    try {
      providers = await probeProviders(ctx)
    } catch (err) {
      if (native) return `${nativeLine} · OpenBB API not running at ${ctx.config.baseUrl} (optional: it adds the routes not ported yet)`
      throw err
    }
    const shown = providers.slice(0, 8).join(', ') + (providers.length > 8 ? ', …' : '')
    return [nativeLine, `OpenBB API at ${ctx.config.baseUrl}${providers.length ? ` · ${providers.length} providers (${shown})` : ''}`].filter(Boolean).join(' · ')
  },

  // Every route a running API serves (generated from its openapi.json and cached under ~/.openterminal/catalog),
  // plus the native ones; with no API and no cache, the native routes alone.
  descriptors: async (ctx) => {
    const mode = ctx?.config.native ?? 'prefer'
    if (mode === 'only') return nativeDescriptors()
    // With native routes the API is optional, so its being down is not worth a log line on every catalog load.
    const live = await descriptorsFor(ctx, { optional: mode === 'prefer' })
    return mode === 'off' ? live : mergeNativeDescriptors(live)
  },
  // A ported provider answers in process; anything else is `GET /api/v1/<route>?…` on the local API.
  call: (route, params, ctx) => callRoute(route, params, ctx),
})
