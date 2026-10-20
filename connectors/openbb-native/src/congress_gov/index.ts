import { defineProvider } from '../types.js'
import { amendmentRoutes } from './amendments.js'
import { billRoutes } from './bills.js'
import { documentRoutes } from './documents.js'

export default defineProvider({
  name: 'congress_gov',
  credentials: ['congress_gov_api_key'],
  status: 'todo',
  routes: {
    ...amendmentRoutes,
    ...billRoutes,
    ...documentRoutes,
  },
})
