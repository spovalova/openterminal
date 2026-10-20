import { defineProvider } from '../types.js'
import { gasBalance, gasDemand, gasExports, gasImports, gasProduction, gasStocks } from './gas.js'
import { oilBalance, oilDemand, oilDemandByProduct, oilExports, oilImports, oilProduction, oilStocks } from './oil.js'

export default defineProvider({
  name: 'jodi',
  credentials: [],
  status: 'ported',
  routes: {
    'jodi/gas/balance': gasBalance,
    'jodi/gas/demand': gasDemand,
    'jodi/gas/exports': gasExports,
    'jodi/gas/imports': gasImports,
    'jodi/gas/production': gasProduction,
    'jodi/gas/stocks': gasStocks,
    'jodi/oil/balance': oilBalance,
    'jodi/oil/demand': oilDemand,
    'jodi/oil/demand_by_product': oilDemandByProduct,
    'jodi/oil/exports': oilExports,
    'jodi/oil/imports': oilImports,
    'jodi/oil/production': oilProduction,
    'jodi/oil/stocks': oilStocks,
  },
})
