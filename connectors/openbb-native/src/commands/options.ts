// The options strategy commands: spreads, straddles and strangles on cboe and deribit chains, and deribit's optimizer.
import { optionsSpreads as cboeSpreads, optionsStraddle as cboeStraddle, optionsStrangle as cboeStrangle } from '../cboe/strategies.js'
import { optionsOptimizer as deribitOptimizer } from '../deribit/optimizer.js'
import { optionsSpreads as deribitSpreads, optionsStraddle as deribitStraddle, optionsStrangle as deribitStrangle } from '../deribit/strategies.js'
import type { ProviderPart } from '../types.js'

export const optionsCommands: ProviderPart = {
  routes: {
    'cboe/options/spreads': cboeSpreads,
    'cboe/options/straddle': cboeStraddle,
    'cboe/options/strangle': cboeStrangle,
    'deribit/options/optimizer': deribitOptimizer,
    'deribit/options/spreads': deribitSpreads,
    'deribit/options/straddle': deribitStraddle,
    'deribit/options/strangle': deribitStrangle,
  },
}
