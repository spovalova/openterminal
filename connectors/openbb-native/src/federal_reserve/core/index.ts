import type { ProviderPart } from '../../types.js'
import { centralBankHoldings } from './central-bank-holdings.js'
import { economicIndicators } from './boston.js'
import { agCreditConditions, braveButtersKelley, economicConditions, farmLoanRates, farmlandValues, financialConditions, laborMarket, midwestEconomy, nationalActivity, retailTrade } from './chicago.js'
import { fedData } from './ddp.js'
import { internationalPortfolioInvestment, moneyMarketFunds } from './efa.js'
import { publicationSeriesHandler, publicationsHandler } from './fedinprint.js'
import { fomcDocuments } from './fomc-documents.js'
import { moneyMeasures, treasuryRates, yieldCurve } from './h15.js'
import { inflationExpectations } from './inflation-expectations.js'
import { primaryDealerFails, primaryDealerPositioning } from './primary-dealers.js'
import { effr, obfr, sofr } from './rates.js'
import { fredMd, fredQd, nationalIndex } from './stl.js'
import { emptyAsNoRows } from './helpers.js'

const routes: ProviderPart['routes'] = {
  'economy/central_bank_holdings': centralBankHoldings,
  'economy/fomc_documents': fomcDocuments,
  'economy/money_measures': moneyMeasures,
  'economy/primary_dealer_fails': primaryDealerFails,
  'economy/primary_dealer_positioning': primaryDealerPositioning,
  'economy/survey/inflation_expectations': inflationExpectations,
  'federal_reserve/boston/economic_indicators': economicIndicators,
  'federal_reserve/boston/publication_series': publicationSeriesHandler('boston'),
  'federal_reserve/boston/publications': publicationsHandler('boston'),
  'federal_reserve/chicago/ag_credit_conditions': agCreditConditions,
  'federal_reserve/chicago/brave_butters_kelley': braveButtersKelley,
  'federal_reserve/chicago/economic_conditions': economicConditions,
  'federal_reserve/chicago/farm_loan_rates': farmLoanRates,
  'federal_reserve/chicago/farmland_values': farmlandValues,
  'federal_reserve/chicago/financial_conditions': financialConditions,
  'federal_reserve/chicago/labor_market': laborMarket,
  'federal_reserve/chicago/midwest_economy': midwestEconomy,
  'federal_reserve/chicago/national_activity': nationalActivity,
  'federal_reserve/chicago/publication_series': publicationSeriesHandler('chicago'),
  'federal_reserve/chicago/publications': publicationsHandler('chicago'),
  'federal_reserve/chicago/retail_trade': retailTrade,
  'federal_reserve/fed_data': fedData,
  'federal_reserve/international_portfolio_investment': internationalPortfolioInvestment,
  'federal_reserve/money_market_funds': moneyMarketFunds,
  'federal_reserve/ny/publication_series': publicationSeriesHandler('ny'),
  'federal_reserve/ny/publications': publicationsHandler('ny'),
  'federal_reserve/stl/fred_md': fredMd,
  'federal_reserve/stl/fred_qd': fredQd,
  'federal_reserve/stl/national_index': nationalIndex,
  'federal_reserve/stl/publication_series': publicationSeriesHandler('stl'),
  'federal_reserve/stl/publications': publicationsHandler('stl'),
  'fixedincome/government/treasury_rates': treasuryRates,
  'fixedincome/government/yield_curve': yieldCurve,
  'fixedincome/rate/effr': effr,
  'fixedincome/rate/overnight_bank_funding': obfr,
  'fixedincome/rate/sofr': sofr,
}

// federal_reserve, core part: see ../index.ts for which routes belong here. An EmptyDataError (the API's HTTP 204)
// is no rows.
export default {
  routes: Object.fromEntries(Object.entries(routes).map(([route, handler]) => [route, emptyAsNoRows(handler)])),
  skipped: {},
} satisfies ProviderPart
