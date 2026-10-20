import { defineProvider } from '../types.js'
import { calendarEarnings, companyFilings, companyNews, historicalDividends, historicalSplits, insiderTrading, insiderTransactions, priceTargetConsensus } from './company.js'
import { currencyHistorical, equityHistorical, futuresHistorical, indexHistorical } from './history.js'
import { availableIndices, indexConstituents, indexSectors, indexSnapshots } from './indices.js'
import { equityGainers, marketMovers, marketTrades, rankings, shortInterest, symbolReference } from './markets.js'
import { equityProfile, equityQuote } from './quote.js'

export default defineProvider({
  name: 'tmx',
  credentials: [],
  status: 'todo',
  routes: {
    'currency/price/historical': currencyHistorical,
    'derivatives/futures/historical': futuresHistorical,
    'equity/calendar/earnings': calendarEarnings,
    'equity/discovery/gainers': equityGainers,
    'equity/estimates/consensus': priceTargetConsensus,
    'equity/fundamental/dividends': historicalDividends,
    'equity/fundamental/filings': companyFilings,
    'equity/fundamental/historical_splits': historicalSplits,
    'equity/ownership/insider_trading': insiderTrading,
    'equity/price/historical': equityHistorical,
    'equity/price/quote': equityQuote,
    'equity/profile': equityProfile,
    'etf/historical': equityHistorical,
    'index/available': availableIndices,
    'index/constituents': indexConstituents,
    'index/price/historical': indexHistorical,
    'index/sectors': indexSectors,
    'index/snapshots': indexSnapshots,
    'nasdaq/markets/movers': marketMovers,
    'news/company': companyNews,
    'tmx/equity/ownership/insider_transactions': insiderTransactions,
    'tmx/equity/rankings': rankings,
    'tmx/equity/symbol_reference': symbolReference,
    'tmx/markets/movers': marketMovers,
    'tmx/markets/short_interest': shortInterest,
    'tmx/markets/trades': marketTrades,
  },
})
