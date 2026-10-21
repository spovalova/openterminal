import { defineProvider } from '../types.js'
import { cotRoutes } from './cot.js'
import { dtccRoutes } from './dtcc/routes.js'

export default defineProvider({
  name: 'cftc',
  credentials: ['cftc_app_token'],
  status: 'ported',
  routes: {
    ...cotRoutes,
    ...dtccRoutes,
  },
})
