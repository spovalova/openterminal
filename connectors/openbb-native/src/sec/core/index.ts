import type { ProviderPart } from '../../types.js'
import { secCompanyFilings } from '../company-filings.js'
import { adviserDocuments, adviserFirms, adviserIndividuals, adviserUniverse } from './advisers.js'
import { equitySearch, secCikMap, secInstitutionsSearch, secSicSearch, secSymbolMap } from './directory.js'
import { equityFtd } from './fails-to-deliver.js'
import { form13f } from './form-13f.js'
import { secHtmFile } from './htm-file.js'
import { insiderTrading } from './insider-trading.js'
import { nportDisclosure, nportFundMetrics } from './nport.js'
import { fullTextSearch, latestFinancialReports } from './reports.js'

// sec, core part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'equity/search': equitySearch,
    'sec/cik_map': secCikMap,
    'sec/symbol_map': secSymbolMap,
    'sec/institutions_search': secInstitutionsSearch,
    'sec/sic_search': secSicSearch,
    'equity/shorts/fails_to_deliver': equityFtd,
    'sec/company_filings': secCompanyFilings,
    'equity/fundamental/filings': secCompanyFilings,
    'sec/latest_financial_reports': latestFinancialReports,
    'equity/discovery/latest_financial_reports': latestFinancialReports,
    'sec/full_text_search': fullTextSearch,
    'sec/htm_file': secHtmFile,
    'sec/adviser_firms': adviserFirms,
    'sec/adviser_individuals': adviserIndividuals,
    'sec/adviser_documents': adviserDocuments,
    'sec/adviser_universe': adviserUniverse,
    'equity/ownership/form_13f': form13f,
    'equity/ownership/insider_trading': insiderTrading,
    'etf/nport_disclosure': nportDisclosure,
    'sec/nport_fund_metrics': nportFundMetrics,
  },
  skipped: {},
} satisfies ProviderPart
