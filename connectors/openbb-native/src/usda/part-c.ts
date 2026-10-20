// Part c: farm economy, trade, international datasets and the FAS/ERS listings (PSD, publications, report calendar).
import type { ProviderPart } from '../types.js'
import { adoptionOfGeneticallyEngineeredCrops } from './adoption-of-genetically-engineered-crops.js'
import { agriculturalAndFoodRdExpenditures } from './agricultural-and-food-rd-expenditures.js'
import { agriculturalExchangeRates } from './agricultural-exchange-rates.js'
import { agriculturalProductivity } from './agricultural-productivity.js'
import { agriculturalTrade } from './agricultural-trade.js'
import { agriculturalTradeMultipliers } from './agricultural-trade-multipliers.js'
import { commodityCostsAndReturns } from './commodity-costs-and-returns.js'
import { farmIncomeAndWealthStatistics } from './farm-income-and-wealth-statistics.js'
import { globalFoodAssessment } from './global-food-assessment.js'
import { commodityPsdData } from './psd-data.js'
import { internationalAgriculturalProductivity } from './international-agricultural-productivity.js'
import { internationalBaselineData } from './international-baseline-data.js'
import { internationalMacroeconomicDataSet } from './international-macroeconomic-data-set.js'
import { majorLandUses } from './major-land-uses.js'
import { milkCostOfProduction } from './milk-cost-of-production.js'
import { publications } from './publications.js'
import { reportCalendar } from './report-calendar.js'
import { stateAgriculturalTrade } from './state-agricultural-trade.js'

const part: ProviderPart = {
  routes: {
    'commodity/psd_data': commodityPsdData,
    'usda/adoption_of_genetically_engineered_crops': adoptionOfGeneticallyEngineeredCrops,
    'usda/agricultural_and_food_rd_expenditures': agriculturalAndFoodRdExpenditures,
    'usda/agricultural_exchange_rates': agriculturalExchangeRates,
    'usda/agricultural_productivity': agriculturalProductivity,
    'usda/agricultural_trade': agriculturalTrade,
    'usda/agricultural_trade_multipliers': agriculturalTradeMultipliers,
    'usda/commodity_costs_and_returns': commodityCostsAndReturns,
    'usda/farm_income_and_wealth_statistics': farmIncomeAndWealthStatistics,
    'usda/global_food_assessment': globalFoodAssessment,
    'usda/international_agricultural_productivity': internationalAgriculturalProductivity,
    'usda/international_baseline_data': internationalBaselineData,
    'usda/international_macroeconomic_data_set': internationalMacroeconomicDataSet,
    'usda/major_land_uses': majorLandUses,
    'usda/milk_cost_of_production': milkCostOfProduction,
    'usda/publications': publications,
    'usda/report_calendar': reportCalendar,
    'usda/state_agricultural_trade': stateAgriculturalTrade,
  },
  skipped: {},
}

export default part
