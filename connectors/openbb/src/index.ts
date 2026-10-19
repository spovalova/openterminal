// OpenBB Platform connector: every GET route of a local `openbb-api` (PLAN.md section 17), described by its own
// OpenAPI document and answered through core's `inferFrame`. Keyless by default (yfinance, nasdaq, sec, finra, cboe,
// federal_reserve, oecd, …); keyed providers are configured on the OpenBB side. See README.md.
import { defineConnector } from '@openterminal/core'
import { callRoute } from './call.js'
import { descriptorsFor } from './descriptors.js'
import { ConfigSchema, probeProviders, type Config } from './openbb-api.js'

export { ConfigSchema, DEFAULT_BASE_URL, INSTALL_HINT, type Config } from './openbb-api.js'
export { loadDescriptors, descriptorsFor, descriptorFor, resetDescriptors, defaultCatalogPath, fingerprintOpenApi, readCatalogCache, writeCatalogCache, type CatalogCache, type LoadResult } from './descriptors.js'
export { callRoute, toQuery, fillSymbol, singleSymbol, applicableParams, defaultProvider, withProvider, ROUTE_PROVIDER_PREFERENCE } from './call.js'

export default defineConnector<Config>({
  name: 'openbb',
  config: ConfigSchema,

  // GET /coverage/providers: small, proves the prefix, and lists what the OpenBB side has installed.
  health: async (ctx) => {
    const providers = await probeProviders(ctx)
    const shown = providers.slice(0, 8).join(', ') + (providers.length > 8 ? ', …' : '')
    return `OpenBB API at ${ctx.config.baseUrl}${providers.length ? ` · ${providers.length} providers (${shown})` : ''}`
  },

  // Every GET route of the local API, generated from its openapi.json and cached under ~/.terminal/catalog.
  descriptors: (ctx) => descriptorsFor(ctx),
  // `GET /api/v1/<route>?…` with the validated params, the `results` list through inferFrame with the route's descriptor.
  call: (route, params, ctx) => callRoute(route, params, ctx),
})
