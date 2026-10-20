import { defineProvider } from '../types.js'
import { cesRoutes } from './ces.js'
import { chartRoutes } from './charts.js'
import { cpiNewsReleaseRoutes } from './cpi-news-release.js'
import { cpiTableRoutes } from './cpi-tables.js'
import { documentRoutes } from './documents.js'
import { ppiRoutes } from './ppi.js'

export default defineProvider({
  name: 'bls',
  credentials: ['bls_api_key'],
  status: 'todo',
  routes: {
    ...chartRoutes,
    ...cesRoutes,
    ...cpiNewsReleaseRoutes,
    ...cpiTableRoutes,
    ...documentRoutes,
    ...ppiRoutes,
  },
})
