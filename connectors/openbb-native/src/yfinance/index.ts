import { defineProvider } from '../types.js'
import { companyCalendar, earningsCalendar, economyCalendar, ipoCalendar, splitsCalendar } from './calendars.js'
import { consensus, earningsEstimates, epsRevisions, epsTrend, growthEstimates, priceTarget, recommendationTrend, revenueEstimates } from './estimates.js'
import { filings, historicalEps, historicalMarketCap } from './fundamentals.js'
import { dividends, historicalSplits } from './events.js'
import { insiderPurchases, insiderRoster, insiderTrading, institutionalHolders, majorHolders, mutualFundHolders } from './ownership.js'
import { balanceSheet, cashFlow, incomeStatement } from './statements.js'
import { equityMetrics, equityProfile, equityQuote, etfInfo, management, shareStatistics } from './info.js'
import { cryptoHistorical, currencyHistorical, equityHistorical, etfHistorical, fundsHistorical, futuresHistorical, indexAvailable, indexHistorical } from './prices.js'

export default defineProvider({
  name: 'yfinance',
  credentials: [],
  status: 'todo',
  routes: {
    'crypto/price/historical': cryptoHistorical,
    'economy/calendar': economyCalendar,
    'equity/calendar/earnings': earningsCalendar,
    'equity/calendar/ipo': ipoCalendar,
    'equity/calendar/splits': splitsCalendar,
    'currency/price/historical': currencyHistorical,
    'derivatives/futures/historical': futuresHistorical,
    'equity/estimates/consensus': consensus,
    'equity/estimates/price_target': priceTarget,
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
    'equity/ownership/insider_trading': insiderTrading,
    'equity/ownership/share_statistics': shareStatistics,
    'equity/price/historical': equityHistorical,
    'equity/price/quote': equityQuote,
    'equity/profile': equityProfile,
    'etf/historical': etfHistorical,
    'etf/info': etfInfo,
    'index/available': indexAvailable,
    'index/price/historical': indexHistorical,
    'yfinance/company_calendar': companyCalendar,
    'yfinance/estimates/earnings': earningsEstimates,
    'yfinance/estimates/eps_revisions': epsRevisions,
    'yfinance/estimates/eps_trend': epsTrend,
    'yfinance/estimates/growth': growthEstimates,
    'yfinance/estimates/recommendations': recommendationTrend,
    'yfinance/estimates/revenue': revenueEstimates,
    'yfinance/funds/historical': fundsHistorical,
    'yfinance/ownership/insider_purchases': insiderPurchases,
    'yfinance/ownership/insider_roster': insiderRoster,
    'yfinance/ownership/institutional': institutionalHolders,
    'yfinance/ownership/major': majorHolders,
    'yfinance/ownership/mutual_fund': mutualFundHolders,
  },
})
