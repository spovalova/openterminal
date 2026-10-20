// sec is ported in five parts, each with its own routes, helpers and cases file (cases.<part>.json):
//   core:     directories and lists (equity/search, cik_map, symbol_map, institutions_search, sic_search, latest reports,
//             filings, full text search, htm_file, fails to deliver), advisers, 13F, insider trading, N-PORT
//   markdown: html2markdown and the routes built on it: rss_litigation, management_discussion_analysis
//   filing:   one filing's XBRL and text: filing_headers, risk_factors, legal_proceedings, exhibit, disclosures,
//             company_overview, segment_revenue, financial_statements
//   taxonomy: schema_files (the XBRL taxonomy browser)
//   facts:    company-facts statements (balance, cash, income and their growth), compare/company_facts, and the
//             proxy-statement routes (executive_compensation, beneficial_ownership, management_profiles,
//             pay_versus_performance)
import { defineProvider } from '../types.js'
import core from './core/index.js'
import facts from './facts/index.js'
import filing from './filing/index.js'
import markdown from './markdown/index.js'
import taxonomy from './taxonomy/index.js'

export default defineProvider({
  name: 'sec',
  credentials: [],
  status: 'todo',
  routes: { ...core.routes, ...markdown.routes, ...filing.routes, ...taxonomy.routes, ...facts.routes },
  skipped: { ...core.skipped, ...markdown.skipped, ...filing.skipped, ...taxonomy.skipped, ...facts.skipped },
})
