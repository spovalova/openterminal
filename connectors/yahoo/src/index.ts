// Yahoo Finance connector via yahoo-finance2. No API key. v1: search, quote, ohlcv, earnings;
// v1.2 fallbacks: profile, metrics, estimates, eps_history, dividends, insiders, institutions, short_interest, options, holdings.
import { z } from 'zod'
import { defineConnector, type Connector } from '@terminal/core'
import { defaultClient, type YahooClient } from './client.js'
import { makeDividends } from './dividends.js'
import { makeEarnings } from './earnings.js'
import { makeEpsHistory } from './eps-history.js'
import { makeEstimates } from './estimates.js'
import { makeHoldings } from './holdings.js'
import { makeInsiders } from './insiders.js'
import { makeInstitutions } from './institutions.js'
import { makeMetrics } from './metrics.js'
import { makeOhlcv } from './ohlcv.js'
import { makeOptions } from './options.js'
import { makeProfile } from './profile.js'
import { makeQuote } from './quote.js'
import { makeSearch } from './search.js'
import { makeShortInterest } from './short-interest.js'

export type { YahooClient } from './client.js'
export { createYahooClient, wrapClient, retryOn429, isRateLimited } from './client.js'
export { rangeToPeriod, sessionStart, toYahooInterval, nyDate, utcDate } from './time.js'

export type YahooConnectorDeps = {
  /** Library seam; defaults to the shared live client. Tests inject a fake. */
  client?: YahooClient
  /** Clock for range → period mapping, the dividend lookback, and option expirations; defaults to Date.now. */
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
      profile: makeProfile(client),
      metrics: makeMetrics(client),
      estimates: makeEstimates(client),
      eps_history: makeEpsHistory(client),
      dividends: makeDividends(client, now),
      insiders: makeInsiders(client),
      institutions: makeInstitutions(client),
      short_interest: makeShortInterest(client),
      options: makeOptions(client, now),
      holdings: makeHoldings(client),
    },
  })
}

export default createYahooConnector()
