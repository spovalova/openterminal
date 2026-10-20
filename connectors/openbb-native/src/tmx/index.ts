import { defineProvider } from '../types.js'
import { etfCountries, etfHoldings, etfInfo, etfSearch, etfSectors } from './etf.js'
import { statementHandler } from './fundamentals.js'
import { calendarEarnings, companyFilings, companyNews, historicalDividends, historicalSplits, insiderTrading, insiderTransactions, priceTargetConsensus } from './company.js'
import { currencyHistorical, equityHistorical, futuresHistorical, indexHistorical } from './history.js'
import { coveredCalls, futuresInstruments, optionsChains } from './options.js'
import { equitySearch } from './directory.js'
import { equityScreener } from './screener.js'
import { availableIndices, indexConstituents, indexSectors, indexSnapshots } from './indices.js'
import { equityGainers, marketMovers, marketTrades, rankings, shortInterest, symbolReference } from './markets.js'
import { equityProfile, equityQuote } from './quote.js'

export default defineProvider({
  name: 'tmx',
  credentials: [],
  status: 'ported',
  routes: {
    'currency/price/historical': currencyHistorical,
    'derivatives/futures/historical': futuresHistorical,
    'derivatives/futures/instruments': futuresInstruments,
    'derivatives/options/chains': optionsChains,
    'equity/calendar/earnings': calendarEarnings,
    'equity/discovery/gainers': equityGainers,
    'equity/estimates/consensus': priceTargetConsensus,
    'equity/fundamental/balance': statementHandler('balance'),
    'equity/fundamental/cash': statementHandler('cash'),
    'equity/fundamental/dividends': historicalDividends,
    'equity/fundamental/filings': companyFilings,
    'equity/fundamental/historical_splits': historicalSplits,
    'equity/fundamental/income': statementHandler('income'),
    'equity/ownership/insider_trading': insiderTrading,
    'equity/price/historical': equityHistorical,
    'equity/price/quote': equityQuote,
    'equity/profile': equityProfile,
    'equity/screener': equityScreener,
    'equity/search': equitySearch,
    'etf/countries': etfCountries,
    'etf/historical': equityHistorical,
    'etf/holdings': etfHoldings,
    'etf/info': etfInfo,
    'etf/search': etfSearch,
    'etf/sectors': etfSectors,
    'index/available': availableIndices,
    'index/constituents': indexConstituents,
    'index/price/historical': indexHistorical,
    'index/sectors': indexSectors,
    'index/snapshots': indexSnapshots,
    'nasdaq/markets/movers': marketMovers,
    'news/company': companyNews,
    'tmx/derivatives/options/covered_calls': coveredCalls,
    'tmx/equity/ownership/insider_transactions': insiderTransactions,
    'tmx/equity/rankings': rankings,
    'tmx/equity/symbol_reference': symbolReference,
    'tmx/markets/movers': marketMovers,
    'tmx/markets/short_interest': shortInterest,
    'tmx/markets/trades': marketTrades,
  },
  skipped: {
    'fixedincome/corporate/bond_prices': 'The CIRO bond master (bondtradedata.ciro.ca) sits behind a Cloudflare challenge: plain HTTPS gets a 403 "cf-mitigated: challenge". OpenBB reads it with curl_cffi browser TLS impersonation.',
    'fixedincome/government/treasury_prices': 'Reads the same CIRO bond master as bond_prices (bondtradedata.ciro.ca), which answers plain HTTPS with a Cloudflare challenge; OpenBB uses curl_cffi browser TLS impersonation.',
  },
})
