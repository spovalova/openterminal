import { defineProvider } from '../types.js'
import { cotRoutes } from './cot.js'

export default defineProvider({
  name: 'cftc',
  credentials: ['cftc_app_token'],
  status: 'todo',
  routes: {
    ...cotRoutes,
  },
})
