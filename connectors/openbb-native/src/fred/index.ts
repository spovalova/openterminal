import { defineProvider } from '../types.js'
import { economicCalendar } from './calendar.js'
import { balanceOfPayments, commoditySpot, cpi, fredRegional, retailPrices } from './economy.js'
import { bondIndices, commercialPaper, hqm, mortgageIndices, spotRates, tipsYields, yieldCurve } from './fixedincome.js'
import { ameribor, dpcredit, ecb, effr, effrForecast, estr, iorb, overnightBankFunding, sofr, sonia, tcm, tcmEffr, treasuryEffr } from './rates.js'
import { fredReleaseTable, nonfarmPayrolls, pce } from './release-tables.js'
import { fredSearch } from './search.js'
import { fredSeries } from './series.js'
import { economicConditionsChicago, manufacturingOutlookNy, manufacturingOutlookTexas, sloos, universityOfMichigan } from './surveys.js'

export default defineProvider({
  name: 'fred',
  credentials: ['fred_api_key'],
  status: 'ported',
  routes: {
    // Every route but the releases calendar (a public page) needs the user's FRED key.
    'commodity/price/spot': commoditySpot,
    'economy/balance_of_payments': balanceOfPayments,
    'economy/calendar': economicCalendar,
    'economy/cpi': cpi,
    'economy/fred_regional': fredRegional,
    'economy/fred_release_table': fredReleaseTable,
    'economy/fred_search': fredSearch,
    'economy/fred_series': fredSeries,
    'economy/pce': pce,
    'economy/retail_prices': retailPrices,
    'economy/survey/economic_conditions_chicago': economicConditionsChicago,
    'economy/survey/manufacturing_outlook_ny': manufacturingOutlookNy,
    'economy/survey/manufacturing_outlook_texas': manufacturingOutlookTexas,
    'economy/survey/nonfarm_payrolls': nonfarmPayrolls,
    'economy/survey/sloos': sloos,
    'economy/survey/university_of_michigan': universityOfMichigan,
    'fixedincome/bond_indices': bondIndices,
    'fixedincome/corporate/commercial_paper': commercialPaper,
    'fixedincome/corporate/hqm': hqm,
    'fixedincome/corporate/spot_rates': spotRates,
    'fixedincome/government/tips_yields': tipsYields,
    'fixedincome/government/yield_curve': yieldCurve,
    'fixedincome/mortgage_indices': mortgageIndices,
    'fixedincome/rate/ameribor': ameribor,
    'fixedincome/rate/dpcredit': dpcredit,
    'fixedincome/rate/ecb': ecb,
    'fixedincome/rate/effr': effr,
    'fixedincome/rate/effr_forecast': effrForecast,
    'fixedincome/rate/estr': estr,
    'fixedincome/rate/iorb': iorb,
    'fixedincome/rate/overnight_bank_funding': overnightBankFunding,
    'fixedincome/rate/sofr': sofr,
    'fixedincome/rate/sonia': sonia,
    'fixedincome/spreads/tcm': tcm,
    'fixedincome/spreads/tcm_effr': tcmEffr,
    'fixedincome/spreads/treasury_effr': treasuryEffr,
  },
})
