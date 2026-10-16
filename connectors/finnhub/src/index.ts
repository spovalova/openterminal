// Stub seam. Replaced by the finnhub workstream (PLAN.md section 11). Default export stays a Connector.
import { z } from 'zod'
import { defineConnector } from '@terminal/core'

export default defineConnector({
  name: 'finnhub',
  config: z.object({}),
  queries: {
    quote: async () => {
      throw new Error('finnhub connector not implemented yet')
    },
  },
})
