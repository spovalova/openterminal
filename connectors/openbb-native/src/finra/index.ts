import { defineProvider } from '../types.js'
import { bondHistorical } from './bond-historical.js'
import { bondList, bondPrices } from './bonds.js'
import { otcAggregate } from './otc-aggregate.js'
import { securities } from './securities.js'
import { shortInterest } from './short-interest.js'

export default defineProvider({
  name: 'finra',
  credentials: [],
  status: 'ported',
  routes: {
    'equity/darkpool/otc': otcAggregate,
    'equity/shorts/short_interest': shortInterest,
    'finra/equity/securities': securities,
    'finra/fixedincome/bond_historical': bondHistorical,
    'finra/fixedincome/bonds': bondList,
    'fixedincome/corporate/bond_prices': bondPrices,
  },
  // These two read FINRA's Market Data Center (finra-markets.morningstar.com). Every request to it, the session
  // login included, now answers 301 to https://finra.org/investor/investments-explorer, a web page with no data
  // service behind it, and OpenBB itself fails on both ("returned no search data", "lookup was not readable").
  skipped: {
    'equity/search': 'FINRA retired the Market Data Center search this route calls: finra-markets.morningstar.com now redirects every request to a web page, and OpenBB itself fails with "returned no search data".',
    'equity/profile': 'FINRA retired the Market Data Center lookup this route calls: finra-markets.morningstar.com now redirects every request to a web page, and OpenBB itself fails with "lookup was not readable".',
  },
})
