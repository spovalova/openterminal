import type { ProviderPart } from '../../types.js'
import { filingHeaders } from './headers.js'
import { companyOverview, disclosures, exhibit, financialStatements, legalProceedings, noRowsWhenEmpty, riskFactors, segmentRevenue } from './routes.js'

// sec, filing part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'sec/filing_headers': filingHeaders,
    'sec/risk_factors': noRowsWhenEmpty(riskFactors),
    'sec/legal_proceedings': noRowsWhenEmpty(legalProceedings),
    'sec/exhibit': noRowsWhenEmpty(exhibit),
    'sec/disclosures': noRowsWhenEmpty(disclosures),
    'sec/company_overview': noRowsWhenEmpty(companyOverview),
    'sec/segment_revenue': noRowsWhenEmpty(segmentRevenue),
    'sec/financial_statements': noRowsWhenEmpty(financialStatements),
  },
  skipped: {},
} satisfies ProviderPart
