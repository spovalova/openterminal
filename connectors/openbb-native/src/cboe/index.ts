import { defineProvider } from '../types.js'
import { equityQuote } from './equity-quote.js'

export default defineProvider({
  name: 'cboe',
  credentials: [],
  status: 'todo',
  routes: {
    'equity/price/quote': equityQuote,
  },
})
