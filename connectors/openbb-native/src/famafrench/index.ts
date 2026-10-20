import { defineProvider } from '../types.js'
import { breakpoints } from './breakpoints.js'
import { factors } from './factors.js'
import { countryPortfolioReturns, internationalIndexReturns } from './international.js'
import { regionalPortfolioReturns, usPortfolioReturns } from './portfolios.js'

export default defineProvider({
  name: 'famafrench',
  credentials: [],
  status: 'ported',
  routes: {
    'famafrench/breakpoints': breakpoints,
    'famafrench/country_portfolio_returns': countryPortfolioReturns,
    'famafrench/factors': factors,
    'famafrench/international_index_returns': internationalIndexReturns,
    'famafrench/regional_portfolio_returns': regionalPortfolioReturns,
    'famafrench/us_portfolio_returns': usPortfolioReturns,
  },
})
