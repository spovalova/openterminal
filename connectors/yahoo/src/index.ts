// Stub seam. Replaced by the yahoo workstream (PLAN.md section 11). Default export stays a Connector.
import { z } from 'zod'
import { defineConnector } from '@terminal/core'

export default defineConnector({
  name: 'yahoo',
  config: z.object({}),
  queries: {
    quote: async () => {
      throw new Error('yahoo connector not implemented yet')
    },
  },
})
