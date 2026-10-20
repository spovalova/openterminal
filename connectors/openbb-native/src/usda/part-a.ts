// Part a: yearbook and commodity tables (wheat, rice, oil crops, sugar, cotton, dairy, feed grains, livestock, fruit, vegetables).
import type { ProviderPart } from '../types.js'
import { wheatData } from './wheat-data.js'

const part: ProviderPart = {
  routes: {
    'usda/wheat_data': wheatData,
  },
  skipped: {},
}

export default part
