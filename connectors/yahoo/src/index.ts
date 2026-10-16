// Yahoo Finance connector: search, quote, ohlcv, earnings via yahoo-finance2. No API key.
import { z } from 'zod'
import { defineConnector, type Connector } from '@terminal/core'
import { defaultClient, type YahooClient } from './client.js'
import { makeEarnings } from './earnings.js'
import { makeOhlcv } from './ohlcv.js'
import { makeQuote } from './quote.js'
import { makeSearch } from './search.js'

export type { YahooClient } from './client.js'
export { createYahooClient, wrapClient, retryOn429, isRateLimited } from './client.js'
export { rangeToPeriod, sessionStart, toYahooInterval, nyDate } from './time.js'

export type YahooConnectorDeps = {
  /** Library seam; defaults to the shared live client. Tests inject a fake. */
  client?: YahooClient
  /** Clock for range → period mapping; defaults to Date.now. */
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
    queries: {
      search: makeSearch(client),
      quote: makeQuote(client),
      ohlcv: makeOhlcv(client, now),
      earnings: makeEarnings(client),
    },
  })
}

export default createYahooConnector()
