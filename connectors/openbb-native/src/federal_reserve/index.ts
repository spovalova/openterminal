// federal_reserve is ported in two parts, each with its own routes, helpers and cases file (cases.<part>.json):
//   core:     the standard routes (economy/…, fixedincome/…), federal_reserve/ny, ffiec, fed_data,
//             international_portfolio_investment, money_market_funds, boston, stl, chicago
//   regional: federal_reserve/dallas, kc, philadelphia, atlanta, minneapolis, sf, richmond, cleveland
import { defineProvider } from '../types.js'
import core from './core/index.js'
import regional from './regional/index.js'

export default defineProvider({
  name: 'federal_reserve',
  credentials: [],
  status: 'ported',
  routes: { ...core.routes, ...regional.routes },
  skipped: { ...core.skipped, ...regional.skipped },
})
