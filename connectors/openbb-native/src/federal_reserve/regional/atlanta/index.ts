import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import { businessInflationExpectations } from './bie.js'
import { gdpnow } from './gdpnow.js'
import { marketProbability } from './market-probability.js'
import { businessUncertainty } from './sbu.js'
import { stickyCpi } from './sticky-cpi.js'
import { taylorRule, taylorRuleHeatmap, taylorRuleMeasures } from './taylor-rule.js'
import { wageGrowth } from './wage-growth.js'

// federal_reserve/atlanta/*, regional part.
export default {
  routes: {
    'federal_reserve/atlanta/business_inflation_expectations': businessInflationExpectations,
    'federal_reserve/atlanta/business_uncertainty': businessUncertainty,
    'federal_reserve/atlanta/gdpnow': gdpnow,
    'federal_reserve/atlanta/market_probability': marketProbability,
    'federal_reserve/atlanta/sticky_cpi': stickyCpi,
    'federal_reserve/atlanta/taylor_rule': taylorRule,
    'federal_reserve/atlanta/taylor_rule_heatmap': taylorRuleHeatmap,
    'federal_reserve/atlanta/taylor_rule_measures': taylorRuleMeasures,
    'federal_reserve/atlanta/wage_growth': wageGrowth,
    ...publicationRoutes('atlanta'),
  },
  skipped: {},
} satisfies ProviderPart
