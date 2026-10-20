import { defineProvider } from '../types.js'
import { cryptoHistorical, currencyHistorical, equityHistorical, etfHistorical, fundsHistorical, futuresHistorical, indexAvailable, indexHistorical } from './prices.js'

export default defineProvider({
  name: 'yfinance',
  credentials: [],
  status: 'todo',
  routes: {
    'crypto/price/historical': cryptoHistorical,
    'currency/price/historical': currencyHistorical,
    'derivatives/futures/historical': futuresHistorical,
    'equity/price/historical': equityHistorical,
    'etf/historical': etfHistorical,
    'index/available': indexAvailable,
    'index/price/historical': indexHistorical,
    'yfinance/funds/historical': fundsHistorical,
  },
})
