import { defineProvider } from '../types.js'
import { companyCalendar, earningsCalendar, economyCalendar, ipoCalendar, splitsCalendar } from './calendars.js'
import { consensus, earningsEstimates, epsRevisions, epsTrend, growthEstimates, priceTarget, recommendationTrend, revenueEstimates } from './estimates.js'
import { filings, historicalEps, historicalMarketCap } from './fundamentals.js'
import { dividends, historicalSplits } from './events.js'
import { futuresCurve } from './futures.js'
import { optionsChains } from './options.js'
import { insiderPurchases, insiderRoster, insiderTrading, institutionalHolders, majorHolders, mutualFundHolders } from './ownership.js'
import { companyNews, news, search } from './search.js'
import { industryOverview, industryTopGrowth, industryTopPerforming, sectorIndustries, sectorOverview, sectorTopCompanies, sectorTopFunds } from './sectors.js'
import { fundAllocation, fundHoldings, fundInfo, fundPerformance, fundRatings, fundRisk } from './funds.js'
import { balanceSheet, cashFlow, incomeStatement } from './statements.js'
import { equityMetrics, equityProfile, equityQuote, etfInfo, management, shareStatistics } from './info.js'
import { cryptoHistorical, currencyHistorical, equityHistorical, etfHistorical, fundsHistorical, futuresHistorical, indexAvailable, indexHistorical } from './prices.js'

export default defineProvider({
  name: 'yfinance',
  credentials: [],
  status: 'todo',
  routes: {
    'crypto/price/historical': cryptoHistorical,
    'derivatives/options/chains': optionsChains,
    'economy/calendar': economyCalendar,
    'equity/calendar/earnings': earningsCalendar,
    'equity/calendar/ipo': ipoCalendar,
    'equity/calendar/splits': splitsCalendar,
    'currency/price/historical': currencyHistorical,
    'derivatives/futures/curve': futuresCurve,
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
    'news/company': companyNews,
    'index/price/historical': indexHistorical,
    'yfinance/company_calendar': companyCalendar,
    'yfinance/estimates/earnings': earningsEstimates,
    'yfinance/estimates/eps_revisions': epsRevisions,
    'yfinance/estimates/eps_trend': epsTrend,
    'yfinance/estimates/growth': growthEstimates,
    'yfinance/estimates/recommendations': recommendationTrend,
    'yfinance/estimates/revenue': revenueEstimates,
    'yfinance/funds/allocation': fundAllocation,
    'yfinance/funds/historical': fundsHistorical,
    'yfinance/funds/holdings': fundHoldings,
    'yfinance/funds/info': fundInfo,
    'yfinance/funds/performance': fundPerformance,
    'yfinance/funds/ratings': fundRatings,
    'yfinance/funds/risk': fundRisk,
    'yfinance/industry/overview': industryOverview,
    'yfinance/industry/top_growth': industryTopGrowth,
    'yfinance/industry/top_performing': industryTopPerforming,
    'yfinance/news': news,
    'yfinance/ownership/insider_purchases': insiderPurchases,
    'yfinance/ownership/insider_roster': insiderRoster,
    'yfinance/ownership/institutional': institutionalHolders,
    'yfinance/ownership/major': majorHolders,
    'yfinance/ownership/mutual_fund': mutualFundHolders,
    'yfinance/search': search,
    'yfinance/sectors/industries': sectorIndustries,
    'yfinance/sectors/overview': sectorOverview,
    'yfinance/sectors/top_companies': sectorTopCompanies,
    'yfinance/sectors/top_funds': sectorTopFunds,
  },
})
