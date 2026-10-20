import { defineProvider } from '../types.js'
import { filings, historicalEps, historicalMarketCap } from './fundamentals.js'
import { dividends, historicalSplits } from './events.js'
import { balanceSheet, cashFlow, incomeStatement } from './statements.js'
import { equityMetrics, equityProfile, equityQuote, etfInfo, management, shareStatistics } from './info.js'
import { cryptoHistorical, currencyHistorical, equityHistorical, etfHistorical, fundsHistorical, futuresHistorical, indexAvailable, indexHistorical } from './prices.js'

export default defineProvider({
  name: 'yfinance',
  credentials: [],
  status: 'todo',
  routes: {
    'crypto/price/historical': cryptoHistorical,
    'currency/price/historical': currencyHistorical,
    'derivatives/futures/historical': futuresHistorical,
    'equity/fundamental/balance': balanceSheet,
    'equity/fundamental/cash': cashFlow,
    'equity/fundamental/dividends': dividends,
    'equity/fundamental/filings': filings,
    'equity/fundamental/historical_eps': historicalEps,
    'equity/fundamental/historical_splits': historicalSplits,
    'equity/fundamental/income': incomeStatement,
    'equity/fundamental/management': management,
    'equity/fundamental/metrics': equityMetrics,
    'equity/historical_market_cap': historicalMarketCap,
    'equity/ownership/share_statistics': shareStatistics,
    'equity/price/historical': equityHistorical,
    'equity/price/quote': equityQuote,
    'equity/profile': equityProfile,
    'etf/historical': etfHistorical,
    'etf/info': etfInfo,
    'index/available': indexAvailable,
    'index/price/historical': indexHistorical,
    'yfinance/funds/historical': fundsHistorical,
  },
})
