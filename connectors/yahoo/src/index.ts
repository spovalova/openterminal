// Yahoo Finance connector via yahoo-finance2. No API key. The five endpoints the library wraps (search, quote, chart,
// options, quoteSummary) and `news` (the news list of the search module) are the connector's routes (descriptors.json),
// answered through core's `inferFrame`; the recipes in packages/core/recipes.yml say which modules and params each one
// asks for.
import { z } from 'zod'
import { defineConnector, type Connector } from '@openterminal/core'
import { makeCall, yahooDescriptors } from './call.js'
import { defaultClient, type YahooClient } from './client.js'

export type { YahooClient } from './client.js'
export { createYahooClient, wrapClient, retryOn429, isRateLimited } from './client.js'
export { nyDate, nyMidnight, nyParts, utcDate } from './time.js'
export { yahooDescriptors, makeCall, summaryRows, chartRowsV2, newsRows, optionRows, flattenDeep, pickExpiration, daysBetween, YAHOO_ROUTES, type YahooRoute } from './call.js'

export type YahooConnectorDeps = {
  /** Library seam; defaults to the shared live client. Tests inject a fake. */
  client?: YahooClient
  /** Clock for option expirations; defaults to Date.now. */
  now?: () => Date
}

export const YahooConfig = z.object({})

/** Build the connector with injectable client and clock. The default export is `createYahooConnector()`. */
export function createYahooConnector(deps: YahooConnectorDeps = {}): Connector<z.infer<typeof YahooConfig>> {
  const client = () => deps.client ?? defaultClient()
  const now = deps.now ?? (() => new Date())
  return defineConnector({
    name: 'yahoo',
    config: YahooConfig,
    descriptors: () => yahooDescriptors(),
    call: makeCall(client, now),
  })
}

export default createYahooConnector()
