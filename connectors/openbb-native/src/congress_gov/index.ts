import { defineProvider } from '../types.js'
import { amendmentRoutes } from './amendments.js'
import { billRoutes } from './bills.js'
import { committeeRoutes } from './committees.js'
import { documentRoutes } from './documents.js'
import { memberRoutes } from './members.js'

export default defineProvider({
  name: 'congress_gov',
  credentials: ['congress_gov_api_key'],
  status: 'ported',
  routes: {
    ...amendmentRoutes,
    ...billRoutes,
    ...committeeRoutes,
    ...documentRoutes,
    ...memberRoutes,
  },
})
