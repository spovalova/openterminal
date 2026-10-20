import type { ProviderPart } from '../../types.js'
import { compareCompanyFacts } from './compare.js'
import { secBeneficialOwnership, secExecutiveCompensation, secManagementProfiles, secPayVersusPerformance } from './proxy-routes.js'
import { balanceSheet, balanceSheetGrowth, cashFlow, cashFlowGrowth, incomeStatement, incomeStatementGrowth } from './statements.js'

// sec, facts part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'equity/compare/company_facts': compareCompanyFacts,
    'equity/fundamental/balance': balanceSheet,
    'equity/fundamental/balance_growth': balanceSheetGrowth,
    'equity/fundamental/cash': cashFlow,
    'equity/fundamental/cash_growth': cashFlowGrowth,
    'equity/fundamental/income': incomeStatement,
    'equity/fundamental/income_growth': incomeStatementGrowth,
    'sec/executive_compensation': secExecutiveCompensation,
    'sec/beneficial_ownership': secBeneficialOwnership,
    'sec/management_profiles': secManagementProfiles,
    'sec/pay_versus_performance': secPayVersusPerformance,
  },
  skipped: {},
} satisfies ProviderPart
