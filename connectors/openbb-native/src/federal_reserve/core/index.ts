import type { ProviderPart } from '../../types.js'
import { centralBankHoldings } from './central-bank-holdings.js'
import { fomcDocuments } from './fomc-documents.js'
import { moneyMeasures, treasuryRates, yieldCurve } from './h15.js'
import { inflationExpectations } from './inflation-expectations.js'
import { primaryDealerFails, primaryDealerPositioning } from './primary-dealers.js'
import { effr, obfr, sofr } from './rates.js'

// federal_reserve, core part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'economy/central_bank_holdings': centralBankHoldings,
    'economy/fomc_documents': fomcDocuments,
    'economy/money_measures': moneyMeasures,
    'economy/primary_dealer_fails': primaryDealerFails,
    'economy/primary_dealer_positioning': primaryDealerPositioning,
    'economy/survey/inflation_expectations': inflationExpectations,
    'fixedincome/government/treasury_rates': treasuryRates,
    'fixedincome/government/yield_curve': yieldCurve,
    'fixedincome/rate/effr': effr,
    'fixedincome/rate/overnight_bank_funding': obfr,
    'fixedincome/rate/sofr': sofr,
  },
  skipped: {},
} satisfies ProviderPart
