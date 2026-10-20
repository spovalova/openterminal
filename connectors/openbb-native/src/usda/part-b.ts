// Part b: food, nutrition and household tables (food prices and spending, SNAP, food security, nutrient intakes, farm households).
import type { ProviderPart } from '../types.js'
import { costEstimatesOfFoodborneIllnesses } from './cost-estimates-of-foodborne-illnesses.js'
import { eatingAndHealthModuleAtus } from './eating-and-health-module-atus.js'
import { farmHouseholdIncomeAndCharacteristics } from './farm-household-income-and-characteristics.js'
import { foodAtHomeMonthlyAreaPrices } from './food-at-home-monthly-area-prices.js'
import { foodConsumptionNutrientIntakesAndDietQuality } from './food-consumption-nutrient-intakes-and-diet-quality.js'
import { foodDollarSeries } from './food-dollar-series.js'
import { foodExpenditureSeries } from './food-expenditure-series.js'
import { foodPriceOutlook } from './food-price-outlook.js'
import { foodSecurityInTheUnitedStates } from './food-security-in-the-united-states.js'
import { fruitAndVegetablePrices } from './fruit-and-vegetable-prices.js'
import { normalizedPrices } from './normalized-prices.js'
import { purchaseToPlate } from './purchase-to-plate.js'
import { resourceRequirementsOfFoodDemand } from './resource-requirements-of-food-demand.js'
import { snapPolicyDataSets } from './snap-policy-data-sets.js'
import { usFoodImports } from './us-food-imports.js'

const part: ProviderPart = {
  routes: {
    'usda/cost_estimates_of_foodborne_illnesses': costEstimatesOfFoodborneIllnesses,
    'usda/eating_and_health_module_atus': eatingAndHealthModuleAtus,
    'usda/farm_household_income_and_characteristics': farmHouseholdIncomeAndCharacteristics,
    'usda/food_at_home_monthly_area_prices': foodAtHomeMonthlyAreaPrices,
    'usda/food_consumption_nutrient_intakes_and_diet_quality': foodConsumptionNutrientIntakesAndDietQuality,
    'usda/food_dollar_series': foodDollarSeries,
    'usda/food_expenditure_series': foodExpenditureSeries,
    'usda/food_price_outlook': foodPriceOutlook,
    'usda/food_security_in_the_united_states': foodSecurityInTheUnitedStates,
    'usda/fruit_and_vegetable_prices': fruitAndVegetablePrices,
    'usda/normalized_prices': normalizedPrices,
    'usda/purchase_to_plate': purchaseToPlate,
    'usda/resource_requirements_of_food_demand': resourceRequirementsOfFoodDemand,
    'usda/snap_policy_data_sets': snapPolicyDataSets,
    'usda/us_food_imports': usFoodImports,
  },
  skipped: {},
}

export default part
