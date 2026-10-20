import type { ProviderPart } from '../../../types.js'
import { publicationRoutes } from '../fedinprint.js'
import { cyclicalPce, newsSentiment, proxyFundsRate, shortRatePath, supplyDemandPce, termPremium, totalFactorProductivity } from './routes.js'

// federal_reserve/sf/*, regional part.
export default {
  routes: {
    'federal_reserve/sf/cyclical_pce': cyclicalPce,
    'federal_reserve/sf/news_sentiment': newsSentiment,
    'federal_reserve/sf/proxy_funds_rate': proxyFundsRate,
    'federal_reserve/sf/short_rate_path': shortRatePath,
    'federal_reserve/sf/supply_demand_pce': supplyDemandPce,
    'federal_reserve/sf/term_premium': termPremium,
    'federal_reserve/sf/total_factor_productivity': totalFactorProductivity,
    ...publicationRoutes('sf'),
  },
  skipped: {},
} satisfies ProviderPart
