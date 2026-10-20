import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import {
  anxiousIndex,
  businessConditions,
  gdpplus,
  livingstonSurvey,
  manufacturingOutlook,
  nonmanufacturingOutlook,
  partisanConflict,
  stateCoincidentIndex,
  surveyProfessionalForecasters,
  termStructureInflation,
} from './routes.js'

// federal_reserve/philadelphia/*, regional part.
export default {
  routes: {
    'federal_reserve/philadelphia/anxious_index': anxiousIndex,
    'federal_reserve/philadelphia/business_conditions': businessConditions,
    'federal_reserve/philadelphia/gdpplus': gdpplus,
    'federal_reserve/philadelphia/livingston_survey': livingstonSurvey,
    'federal_reserve/philadelphia/manufacturing_outlook': manufacturingOutlook,
    'federal_reserve/philadelphia/nonmanufacturing_outlook': nonmanufacturingOutlook,
    'federal_reserve/philadelphia/partisan_conflict': partisanConflict,
    'federal_reserve/philadelphia/state_coincident_index': stateCoincidentIndex,
    'federal_reserve/philadelphia/survey_professional_forecasters': surveyProfessionalForecasters,
    'federal_reserve/philadelphia/term_structure_inflation': termStructureInflation,
    ...publicationRoutes('philadelphia'),
  },
  skipped: {},
} satisfies ProviderPart
