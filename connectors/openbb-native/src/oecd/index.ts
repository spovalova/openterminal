import { defineProvider } from '../types.js'
import { availableIndicators } from './available-indicators.js'
import { balanceOfPayments } from './balance-of-payments.js'
import { consumerPriceIndex } from './cpi.js'
import { economicIndicators } from './economic-indicators.js'
import { gdpForecast, gdpNominal, gdpReal } from './gdp.js'
import { compositeLeadingIndicator, countryInterestRates, housePriceIndex, sharePriceIndex, unemployment } from './indicators-by-country.js'

export default defineProvider({
  name: 'oecd',
  credentials: [],
  status: 'ported',
  routes: {
    'economy/available_indicators': availableIndicators,
    'economy/balance_of_payments': balanceOfPayments,
    'economy/composite_leading_indicator': compositeLeadingIndicator,
    'economy/cpi': consumerPriceIndex,
    'economy/gdp/forecast': gdpForecast,
    'economy/gdp/nominal': gdpNominal,
    'economy/gdp/real': gdpReal,
    'economy/house_price_index': housePriceIndex,
    'economy/indicators': economicIndicators,
    'economy/interest_rates': countryInterestRates,
    'economy/share_price_index': sharePriceIndex,
    'economy/unemployment': unemployment,
  },
})
