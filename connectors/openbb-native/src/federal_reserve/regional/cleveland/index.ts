import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import { inflationExpectations } from './inflation-expectations.js'
import { inflationNowcast } from './inflation-nowcast.js'
import { medianCpi, medianCpiComponents, systemicRisk } from './median-cpi.js'

// federal_reserve/cleveland/*, regional part.
export default {
  routes: {
    'federal_reserve/cleveland/inflation_expectations': inflationExpectations,
    'federal_reserve/cleveland/inflation_nowcast': inflationNowcast,
    'federal_reserve/cleveland/median_cpi': medianCpi,
    'federal_reserve/cleveland/median_cpi_components': medianCpiComponents,
    'federal_reserve/cleveland/systemic_risk': systemicRisk,
    ...publicationRoutes('cleveland'),
  },
  skipped: {},
} satisfies ProviderPart
