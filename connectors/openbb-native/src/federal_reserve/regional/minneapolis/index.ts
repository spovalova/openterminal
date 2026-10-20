import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import { businessConditions, employment, jobOpeningsHiring, laborForce, quitsRate, regionalCpi, regionalGdp, unemployment, unemploymentClaims } from './routes.js'

// federal_reserve/minneapolis/*, regional part.
export default {
  routes: {
    'federal_reserve/minneapolis/business_conditions': businessConditions,
    'federal_reserve/minneapolis/job_openings_hiring': jobOpeningsHiring,
    'federal_reserve/minneapolis/labor_force_participation': laborForce,
    'federal_reserve/minneapolis/quits_rate': quitsRate,
    'federal_reserve/minneapolis/regional_cpi': regionalCpi,
    'federal_reserve/minneapolis/regional_employment': employment,
    'federal_reserve/minneapolis/regional_gdp': regionalGdp,
    'federal_reserve/minneapolis/regional_unemployment': unemployment,
    'federal_reserve/minneapolis/unemployment_claims': unemploymentClaims,
    ...publicationRoutes('minneapolis'),
  },
  skipped: {},
} satisfies ProviderPart
