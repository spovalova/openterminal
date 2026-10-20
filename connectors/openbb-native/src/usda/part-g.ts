// Part g: rural geography code lists and the legacy .xls workbooks (area codes, commuting zones, typology, amenities, fertilizer, food availability).
import type { ProviderPart } from '../types.js'
import { areaAndRoadRuggednessScales } from './area-and-road-ruggedness-scales.js'
import { commutingZonesAndLaborMarketAreas } from './commuting-zones-and-labor-market-areas.js'
import { countyTypologyCodes } from './county-typology-codes.js'
import { fertilizerUseAndPrice } from './fertilizer-use-and-price.js'
import { foodAvailabilityPerCapita } from './food-availability-per-capita.js'
import { frontierAndRemoteAreaCodes } from './frontier-and-remote-area-codes.js'
import { naturalAmenitiesScale } from './natural-amenities-scale.js'
import { povertyAreaMeasures } from './poverty-area-measures.js'
import { ruralUrbanCommutingAreaCodes } from './rural-urban-commuting-area-codes.js'
import { ruralUrbanContinuumCodes } from './rural-urban-continuum-codes.js'
import { urbanInfluenceCodes } from './urban-influence-codes.js'

const part: ProviderPart = {
  routes: {
    'usda/area_and_road_ruggedness_scales': areaAndRoadRuggednessScales,
    'usda/commuting_zones_and_labor_market_areas': commutingZonesAndLaborMarketAreas,
    'usda/county_typology_codes': countyTypologyCodes,
    'usda/fertilizer_use_and_price': fertilizerUseAndPrice,
    'usda/food_availability_per_capita': foodAvailabilityPerCapita,
    'usda/frontier_and_remote_area_codes': frontierAndRemoteAreaCodes,
    'usda/natural_amenities_scale': naturalAmenitiesScale,
    'usda/poverty_area_measures': povertyAreaMeasures,
    'usda/rural_urban_commuting_area_codes': ruralUrbanCommutingAreaCodes,
    'usda/rural_urban_continuum_codes': ruralUrbanContinuumCodes,
    'usda/urban_influence_codes': urbanInfluenceCodes,
  },
  skipped: {},
}

export default part
