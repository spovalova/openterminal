import { defineProvider } from '../types.js'
import { equityHistorical } from './equity-historical.js'
import { equityQuote } from './equity-quote.js'
import { equitySearch } from './equity-search.js'
import { futuresCurve } from './futures-curve.js'
import { futuresInstruments } from './futures-instruments.js'
import { futuresSettlements } from './futures-settlements.js'
import { indexAvailable } from './index-available.js'
import { indexConstituents } from './index-constituents.js'
import { indexDocuments } from './index-documents.js'
import { indexHistorical } from './index-historical.js'
import { indexSearch } from './index-search.js'
import { indexSnapshots } from './index-snapshots.js'
import { optionsChains } from './options-chains.js'

export default defineProvider({
  name: 'cboe',
  credentials: [],
  status: 'ported',
  routes: {
    'cboe/futures/settlement_prices': futuresSettlements,
    'cboe/index/documents': indexDocuments,
    'derivatives/futures/curve': futuresCurve,
    'derivatives/futures/instruments': futuresInstruments,
    'derivatives/options/chains': optionsChains,
    'equity/price/historical': equityHistorical,
    'equity/price/quote': equityQuote,
    'equity/search': equitySearch,
    'etf/historical': equityHistorical,
    'index/available': indexAvailable,
    'index/constituents': indexConstituents,
    'index/price/historical': indexHistorical,
    'index/search': indexSearch,
    'index/snapshots': indexSnapshots,
  },
})
