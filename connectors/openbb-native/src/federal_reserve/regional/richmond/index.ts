import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import { survey } from './helpers.js'
import { cfoSurvey, nonEmploymentIndex, recessionIndicator } from './other.js'

// federal_reserve/richmond/*, regional part. The three Fifth District surveys share one parser (utils/richmond_surveys.py).
export default {
  routes: {
    'federal_reserve/richmond/cfo_survey': cfoSurvey,
    'federal_reserve/richmond/manufacturing_survey': (params, ctx) => survey(ctx, 'manufacturing', undefined, params),
    'federal_reserve/richmond/non_employment_index': nonEmploymentIndex,
    'federal_reserve/richmond/recession_indicator': recessionIndicator,
    'federal_reserve/richmond/service_sector_survey': (params, ctx) => survey(ctx, 'non_manufacturing', undefined, params),
    'federal_reserve/richmond/state_survey': (params, ctx) => survey(ctx, String(params.state ?? 'virginia'), undefined, params),
    ...publicationRoutes('richmond'),
  },
  skipped: {},
} satisfies ProviderPart
