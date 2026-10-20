import { defineProvider } from '../types.js'
import { availableIndicators } from './available-indicators.js'
import { balanceOfPayments } from './balance-of-payments.js'
import { consumerPriceIndex } from './consumer-price-index.js'
import { directionOfTrade } from './direction-of-trade.js'
import { economicIndicators } from './economic-indicators.js'
import { containerMetricsByPort, countryActivity, disruptionEventsList, disruptionSankey, monthlyTradeNow } from './portwatch.js'
import { chokepointInfo, chokepointVolume, portInfo, portVolume } from './shipping.js'

export default defineProvider({
  name: 'imf',
  credentials: [],
  status: 'ported',
  routes: {
    'economy/available_indicators': availableIndicators,
    'economy/balance_of_payments': balanceOfPayments,
    'economy/cpi': consumerPriceIndex,
    'economy/direction_of_trade': directionOfTrade,
    'economy/indicators': economicIndicators,
    'economy/shipping/chokepoint_info': chokepointInfo,
    'economy/shipping/chokepoint_volume': chokepointVolume,
    'economy/shipping/port_info': portInfo,
    'economy/shipping/port_volume': portVolume,
    'imf/portwatch/container_metrics': containerMetricsByPort,
    'imf/portwatch/country_activity': countryActivity,
    'imf/portwatch/disruption_events': disruptionEventsList,
    'imf/portwatch/disruption_sankey': disruptionSankey,
    'imf/portwatch/disruptions_map': disruptionEventsList,
    'imf/portwatch/monthly_trade': monthlyTradeNow,
  },
})
