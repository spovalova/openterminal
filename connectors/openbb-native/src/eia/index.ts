import { defineProvider } from '../types.js'
import { dataBrowser } from './data-browser.js'
import { DATASET_ROUTES } from './dataset.js'
import { shortTermEnergyOutlook } from './steo.js'
import { petroleumStatusReport } from './wpsr.js'

export default defineProvider({
  name: 'eia',
  credentials: ['eia_api_key'],
  status: 'ported',
  routes: {
    // The Weekly Petroleum Status Report reads files from ir.eia.gov and needs no key; the rest use api.eia.gov.
    'commodity/petroleum_status_report': petroleumStatusReport,
    'commodity/short_term_energy_outlook': shortTermEnergyOutlook,
    'eia/data_browser': dataBrowser,
    // 203 dataset routes (catalog.json), one generic handler each.
    ...DATASET_ROUTES,
  },
})
