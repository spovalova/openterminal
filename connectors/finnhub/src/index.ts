// Finnhub connector: the three REST paths the recipes name (quote, company-news, calendar/earnings) as routes,
// answered through core's `inferFrame`. Free key, 60 calls/min. See README.md.
import { z } from 'zod'
import { defineConnector } from '@openterminal/core'
import { callFinnhub, finnhubDescriptors } from './call.js'
import type { Config } from './finnhub-api.js'

export { callFinnhub, finnhubDescriptors, secondsToMs, FINNHUB_ROUTES, type FinnhubRoute } from './call.js'

export default defineConnector<Config>({
  name: 'finnhub',
  config: z.object({ apiKey: z.string().min(1) }),
  descriptors: () => finnhubDescriptors(),
  call: callFinnhub,
})
