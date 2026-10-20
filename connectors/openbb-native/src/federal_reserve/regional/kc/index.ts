import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import { agCreditSurvey, agDatabookArchived, agDistrictSurveys, agFinanceDatabook, agInterestRates, agTermsOfLending, divisionalLmci, financialStressIndex, naturalRate, policyRateUncertainty, riskIndex } from './routes.js'

// federal_reserve/kc/*, regional part.
export default {
  routes: {
    'federal_reserve/kc/ag_credit_survey': agCreditSurvey,
    'federal_reserve/kc/ag_databook_archived': agDatabookArchived,
    'federal_reserve/kc/ag_district_surveys': agDistrictSurveys,
    'federal_reserve/kc/ag_finance_databook': agFinanceDatabook,
    'federal_reserve/kc/ag_interest_rates': agInterestRates,
    'federal_reserve/kc/ag_terms_of_lending': agTermsOfLending,
    'federal_reserve/kc/divisional_lmci': divisionalLmci,
    'federal_reserve/kc/financial_stress_index': financialStressIndex,
    'federal_reserve/kc/natural_rate': naturalRate,
    'federal_reserve/kc/policy_rate_uncertainty': policyRateUncertainty,
    'federal_reserve/kc/risk_index': riskIndex,
    ...publicationRoutes('kc'),
  },
  skipped: {},
} satisfies ProviderPart
