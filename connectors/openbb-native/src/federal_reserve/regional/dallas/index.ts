import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import {
  agriculturalSurvey,
  bankingConditions,
  breakevenPrices,
  energySurvey,
  gigafactoryMap,
  globalEconomicIndicators,
  globalRealEconomicActivity,
  governmentDebt,
  leadingIndex,
  lithiumMap,
  manufacturing,
  retail,
  serviceSector,
  trimmedMeanPce,
  weeklyEconomicIndex,
} from './routes.js'

// federal_reserve/dallas/*, regional part.
export default {
  routes: {
    'federal_reserve/dallas/agricultural_survey': agriculturalSurvey,
    'federal_reserve/dallas/banking_conditions': bankingConditions,
    'federal_reserve/dallas/breakeven_prices': breakevenPrices,
    'federal_reserve/dallas/energy_survey': energySurvey,
    'federal_reserve/dallas/gigafactory_map': gigafactoryMap,
    'federal_reserve/dallas/global_economic_indicators': globalEconomicIndicators,
    'federal_reserve/dallas/global_real_economic_activity': globalRealEconomicActivity,
    'federal_reserve/dallas/government_debt': governmentDebt,
    'federal_reserve/dallas/leading_index': leadingIndex,
    'federal_reserve/dallas/lithium_map': lithiumMap,
    'federal_reserve/dallas/manufacturing': manufacturing,
    'federal_reserve/dallas/retail': retail,
    'federal_reserve/dallas/service_sector': serviceSector,
    'federal_reserve/dallas/trimmed_mean_pce': trimmedMeanPce,
    'federal_reserve/dallas/weekly_economic_index': weeklyEconomicIndex,
    ...publicationRoutes('dallas'),
  },
  skipped: {},
} satisfies ProviderPart
