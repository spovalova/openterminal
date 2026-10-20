// Part c: farm economy, trade, international datasets and the FAS/ERS listings (PSD, publications, report calendar).
import type { ProviderPart } from '../types.js'
import { agriculturalTradeMultipliers } from './agricultural-trade-multipliers.js'

const part: ProviderPart = {
  routes: {
    'usda/agricultural_trade_multipliers': agriculturalTradeMultipliers,
  },
  skipped: {},
}

export default part
