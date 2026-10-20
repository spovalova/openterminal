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
import { businessLeaders, consumerCreditAccess, consumerExpectations, consumerHousing, consumerLaborMarket, coreTrendInflation, corporateBondDistress, empireStateManufacturing, empireStateReports, householdDebt, marketExpectations, marketExpectationsReports, nowcast, supplyChainPressure } from './ny.js'
import { primaryDealerFails, primaryDealerPositioning } from './primary-dealers.js'
import { effr, obfr, sofr } from './rates.js'
import { fredMd, fredQd, nationalIndex } from './stl.js'
import { emptyAsNoRows } from './helpers.js'
import { callReport, callReportSectioned } from './cdr/call.js'
import { customPeerGroup } from './cdr/custom.js'
import { peerGroupAverage, peerGroupBank, peerGroupDistribution, stateAverage } from './cdr/peers.js'
import { executiveSummary, listOfBanksPeerGroup, ubpr } from './cdr/ubpr.js'

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
  'federal_reserve/ffiec/call_report': callReport,
  'federal_reserve/ffiec/call_report_sectioned': callReportSectioned,
  'federal_reserve/ffiec/custom_peer_group': customPeerGroup,
  'federal_reserve/ffiec/executive_summary': executiveSummary,
  'federal_reserve/ffiec/list_of_banks_peer_group': listOfBanksPeerGroup,
  'federal_reserve/ffiec/peer_group_average': peerGroupAverage,
  'federal_reserve/ffiec/peer_group_bank': peerGroupBank,
  'federal_reserve/ffiec/peer_group_distribution': peerGroupDistribution,
  'federal_reserve/ffiec/state_average': stateAverage,
  'federal_reserve/ffiec/ubpr': ubpr,
  'federal_reserve/international_portfolio_investment': internationalPortfolioInvestment,
  'federal_reserve/money_market_funds': moneyMarketFunds,
  'federal_reserve/ny/business_leaders': businessLeaders,
  'federal_reserve/ny/consumer_credit_access': consumerCreditAccess,
  'federal_reserve/ny/consumer_expectations': consumerExpectations,
  'federal_reserve/ny/consumer_housing': consumerHousing,
  'federal_reserve/ny/consumer_labor_market': consumerLaborMarket,
  'federal_reserve/ny/core_trend_inflation': coreTrendInflation,
  'federal_reserve/ny/corporate_bond_distress': corporateBondDistress,
  'federal_reserve/ny/empire_state_manufacturing': empireStateManufacturing,
  'federal_reserve/ny/empire_state_reports': empireStateReports,
  'federal_reserve/ny/household_debt': householdDebt,
  'federal_reserve/ny/market_expectations': marketExpectations,
  'federal_reserve/ny/market_expectations_reports': marketExpectationsReports,
  'federal_reserve/ny/nowcast': nowcast,
  'federal_reserve/ny/publication_series': publicationSeriesHandler('ny'),
  'federal_reserve/ny/publications': publicationsHandler('ny'),
  'federal_reserve/ny/supply_chain_pressure': supplyChainPressure,
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

// The FFIEC National Information Center (www.ffiec.gov/npw) answers only a browser's TLS fingerprint: a plain HTTPS
// request gets 403 from Cloudflare, and OpenBB reaches it through curl_cffi impersonation, which a plain fetch cannot do.
const NIC = 'Reads the FFIEC National Information Center (www.ffiec.gov/npw), which blocks plain HTTPS requests (403 from Cloudflare; OpenBB gets in through curl_cffi browser TLS impersonation), so the OpenBB API keeps answering it.'
const NIC_DATA = 'Reads the FFIEC E.16 country exposure files on www.ffiec.gov, which blocks plain HTTPS requests (403 from Cloudflare; OpenBB gets in through curl_cffi browser TLS impersonation), so the OpenBB API keeps answering it.'

// federal_reserve, core part: see ../index.ts for which routes belong here. An EmptyDataError (the API's HTTP 204)
// is no rows.
export default {
  routes: Object.fromEntries(Object.entries(routes).map(([route, handler]) => [route, emptyAsNoRows(handler)])),
  skipped: {
    'federal_reserve/ffiec/bhcpr': NIC,
    'federal_reserve/ffiec/bhcpr_report': NIC,
    'federal_reserve/ffiec/country_exposure': NIC_DATA,
    'federal_reserve/ffiec/financial_report': NIC,
    'federal_reserve/ffiec/financial_report_pdf': NIC,
    'federal_reserve/ffiec/institution_structure': NIC,
    'federal_reserve/ffiec/institutions': NIC,
    'federal_reserve/ffiec/large_holding_companies': NIC,
  },
} satisfies ProviderPart
