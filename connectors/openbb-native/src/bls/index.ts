import { defineProvider } from '../types.js'
import { chartRoutes } from './charts.js'

export default defineProvider({
  name: 'bls',
  credentials: ['bls_api_key'],
  status: 'todo',
  routes: {
    ...chartRoutes,
  },
})
