import type { ProviderPart } from '../../types.js'
import { secCompanyFilings } from '../company-filings.js'

// sec, core part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'sec/company_filings': secCompanyFilings,
    'equity/fundamental/filings': secCompanyFilings,
  },
  skipped: {},
} satisfies ProviderPart
