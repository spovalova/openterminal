import { defineProvider } from '../types.js'
import { economicCalendar } from './calendar.js'
import { currencyHistorical, currencyReferenceRates } from './currency.js'
import { eligibleAssets } from './eligible-assets.js'
import { availableIndicators, balanceOfPayments, economicIndicators } from './indicators.js'
import { euroShortTermRate, keyInterestRates, mfiInterestRates, yieldCurve } from './rates.js'

export default defineProvider({
  name: 'ecb',
  credentials: [],
  status: 'ported',
  routes: {
    'currency/price/historical': currencyHistorical,
    'currency/reference_rates': currencyReferenceRates,
    'ecb/eligible_assets': eligibleAssets,
    'ecb/key_interest_rates': keyInterestRates,
    'ecb/mfi_interest_rates': mfiInterestRates,
    'economy/available_indicators': availableIndicators,
    'economy/balance_of_payments': balanceOfPayments,
    'economy/calendar': economicCalendar,
    'economy/indicators': economicIndicators,
    'fixedincome/government/yield_curve': yieldCurve,
    'fixedincome/rate/estr': euroShortTermRate,
  },
})
