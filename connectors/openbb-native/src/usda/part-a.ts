// Part a: yearbook and commodity tables (wheat, rice, oil crops, sugar, cotton, dairy, feed grains, livestock, fruit, vegetables).
import type { ProviderPart } from '../types.js'
import { cottonWoolAndTextileData } from './cotton-wool-and-textile-data.js'
import { dairyData } from './dairy-data.js'
import { feedGrainsDatabase } from './feed-grains-database.js'
import { fruitAndTreeNutsData } from './fruit-and-tree-nuts-data.js'
import { livestockAndMeatDomesticData } from './livestock-and-meat-domestic-data.js'
import { livestockAndMeatInternationalTradeData } from './livestock-and-meat-international-trade-data.js'
import { meatPriceSpreads } from './meat-price-spreads.js'
import { oilCropsYearbook } from './oil-crops-yearbook.js'
import { priceSpreads } from './price-spreads.js'
import { riceYearbook } from './rice-yearbook.js'
import { seasonAveragePriceForecasts } from './season-average-price-forecasts.js'
import { sugarSweetenersYearbook } from './sugar-sweeteners-yearbook.js'
import { usBioenergyStatistics } from './us-bioenergy-statistics.js'
import { vegetablesAndPulses } from './vegetables-and-pulses.js'
import { wheatData } from './wheat-data.js'

const part: ProviderPart = {
  routes: {
    'usda/cotton_wool_and_textile_data': cottonWoolAndTextileData,
    'usda/dairy_data': dairyData,
    'usda/feed_grains_database': feedGrainsDatabase,
    'usda/fruit_and_tree_nuts_data': fruitAndTreeNutsData,
    'usda/livestock_and_meat_domestic_data': livestockAndMeatDomesticData,
    'usda/livestock_and_meat_international_trade_data': livestockAndMeatInternationalTradeData,
    'usda/meat_price_spreads': meatPriceSpreads,
    'usda/oil_crops_yearbook': oilCropsYearbook,
    'usda/price_spreads': priceSpreads,
    'usda/rice_yearbook': riceYearbook,
    'usda/season_average_price_forecasts': seasonAveragePriceForecasts,
    'usda/sugar_sweeteners_yearbook': sugarSweetenersYearbook,
    'usda/us_bioenergy_statistics': usBioenergyStatistics,
    'usda/vegetables_and_pulses': vegetablesAndPulses,
    'usda/wheat_data': wheatData,
  },
  skipped: {},
}

export default part
