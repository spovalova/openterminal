import { defineProvider } from '../types.js'
import { futuresCurve, futuresHistorical, futuresInfo, futuresInstruments } from './futures.js'
import { deliveryPrices, indexHistorical, indexPrice } from './indices.js'
import { blockRfqTrades, bookSummary, orderBook, settlements, ticker, tradeVolumes, trades } from './market.js'
import { optionsChains } from './options.js'
import { aprHistory, fundingChart, fundingHistory } from './rates.js'
import { announcements, combos, currencies, expirations, instruments } from './reference.js'
import { realized, volatilityIndex } from './volatility.js'

export default defineProvider({
  name: 'deribit',
  credentials: [],
  status: 'ported',
  routes: {
    'deribit/index/delivery_prices': deliveryPrices,
    'deribit/index/historical': indexHistorical,
    'deribit/index/price': indexPrice,
    'deribit/market/block_rfq_trades': blockRfqTrades,
    'deribit/market/book_summary': bookSummary,
    'deribit/market/order_book': orderBook,
    'deribit/market/settlements': settlements,
    'deribit/market/ticker': ticker,
    'deribit/market/trade_volumes': tradeVolumes,
    'deribit/market/trades': trades,
    'deribit/rates/apr_history': aprHistory,
    'deribit/rates/funding_chart': fundingChart,
    'deribit/rates/funding_history': fundingHistory,
    'deribit/reference/announcements': announcements,
    'deribit/reference/combos': combos,
    'deribit/reference/currencies': currencies,
    'deribit/reference/expirations': expirations,
    'deribit/reference/instruments': instruments,
    'deribit/volatility/index': volatilityIndex,
    'deribit/volatility/realized': realized,
    'derivatives/futures/curve': futuresCurve,
    'derivatives/futures/historical': futuresHistorical,
    'derivatives/futures/info': futuresInfo,
    'derivatives/futures/instruments': futuresInstruments,
    'derivatives/options/chains': optionsChains,
  },
})
