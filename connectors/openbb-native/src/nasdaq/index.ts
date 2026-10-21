import { defineProvider } from '../types.js'
import { calendarDividend, calendarEarnings, calendarIpo, calendarSplits, economyCalendar } from './calendar.js'
import { financialRatios, balanceSheet, cashFlow, companyFilings, companyNews, incomeStatement } from './financials.js'
import { historicalDividends, historicalEps, insiderTrading, institutionalOwnership, shortInterest } from './company.js'
import { equityProfile, equityQuote, equitySearch, marketsQuotes } from './equity.js'
import { etfEquityExposure, etfHoldings, etfInfo, etfSearch } from './etf.js'
import { priceTarget, priceTargetConsensus } from './estimates.js'
import { indexSearch, indexSnapshots, marketMovers, marketStatus } from './markets.js'
import { nordicDividends, nordicFundamentals, nordicInfo } from './nordic-factsheet.js'
import { nordicBondYields, nordicHistorical, nordicHistoricalTrades, nordicHolidays, nordicIndexFactors, nordicKnockedOut, nordicMortgageRates, nordicMovers, nordicNews, nordicScreener, nordicTradingHours } from './nordic.js'
import { optionsChains } from './options.js'
import { cryptoHistorical, equityHistorical, etfHistorical, indexHistorical } from './prices.js'
import { equityScreener } from './screener.js'

export default defineProvider({
  name: 'nasdaq',
  credentials: [],
  status: 'ported',
  routes: {
    'crypto/price/historical': cryptoHistorical,
    'derivatives/options/chains': optionsChains,
    'economy/calendar': economyCalendar,
    'equity/calendar/dividend': calendarDividend,
    'equity/calendar/earnings': calendarEarnings,
    'equity/calendar/ipo': calendarIpo,
    'equity/calendar/splits': calendarSplits,
    'equity/estimates/consensus': priceTargetConsensus,
    'equity/estimates/price_target': priceTarget,
    'equity/fundamental/balance': balanceSheet,
    'equity/fundamental/cash': cashFlow,
    'equity/fundamental/dividends': historicalDividends,
    'equity/fundamental/filings': companyFilings,
    'equity/fundamental/historical_eps': historicalEps,
    'equity/fundamental/income': incomeStatement,
    'equity/fundamental/ratios': financialRatios,
    'equity/ownership/insider_trading': insiderTrading,
    'equity/ownership/institutional': institutionalOwnership,
    'equity/price/historical': equityHistorical,
    'equity/price/quote': equityQuote,
    'equity/profile': equityProfile,
    'equity/screener': equityScreener,
    'equity/search': equitySearch,
    'equity/shorts/short_interest': shortInterest,
    'etf/equity_exposure': etfEquityExposure,
    'etf/historical': etfHistorical,
    'etf/holdings': etfHoldings,
    'etf/info': etfInfo,
    'etf/search': etfSearch,
    'index/price/historical': indexHistorical,
    'index/search': indexSearch,
    'index/snapshots': indexSnapshots,
    'nasdaq/markets/movers': marketMovers,
    'nasdaq/markets/quotes': marketsQuotes,
    'nasdaq/markets/status': marketStatus,
    'nasdaq/nordic/bond_yields': nordicBondYields,
    'nasdaq/nordic/dividends': nordicDividends,
    'nasdaq/nordic/fundamentals': nordicFundamentals,
    'nasdaq/nordic/historical': nordicHistorical,
    'nasdaq/nordic/historical_trades': nordicHistoricalTrades,
    'nasdaq/nordic/holidays': nordicHolidays,
    'nasdaq/nordic/index_factors': nordicIndexFactors,
    'nasdaq/nordic/info': nordicInfo,
    'nasdaq/nordic/knocked_out': nordicKnockedOut,
    'nasdaq/nordic/mortgage_rates': nordicMortgageRates,
    'nasdaq/nordic/movers': nordicMovers,
    'nasdaq/nordic/news': nordicNews,
    'nasdaq/nordic/screener': nordicScreener,
    'nasdaq/nordic/trading_hours': nordicTradingHours,
    'news/company': companyNews,
    'tmx/markets/movers': marketMovers,
  },
})
