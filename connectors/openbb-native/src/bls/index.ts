import { defineProvider } from '../types.js'
import { calendarRoutes } from './calendar.js'
import { cesRoutes } from './ces.js'
import { chartRoutes } from './charts.js'
import { cpiNewsReleaseRoutes } from './cpi-news-release.js'
import { cpiTableRoutes } from './cpi-tables.js'
import { documentRoutes } from './documents.js'
import { empsitSummaryRoutes } from './empsit-summary.js'
import { joltsTableRoutes } from './jolts-tables.js'
import { ppiRoutes } from './ppi.js'
import { productivityTableRoutes } from './productivity-tables.js'
import { searchRoutes } from './search.js'
import { seriesRoutes } from './series.js'

export default defineProvider({
  name: 'bls',
  credentials: ['bls_api_key'],
  status: 'ported',
  routes: {
    ...calendarRoutes,
    ...chartRoutes,
    ...cesRoutes,
    ...cpiNewsReleaseRoutes,
    ...cpiTableRoutes,
    ...documentRoutes,
    ...empsitSummaryRoutes,
    ...joltsTableRoutes,
    ...ppiRoutes,
    ...productivityTableRoutes,
    ...searchRoutes,
    ...seriesRoutes,
  },
})
