// Ported from openbb_sec/utils/statement_schema/_rules.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the tables as TypeScript
// constants, generated from the Python module (tuples become arrays, frozensets become Sets).

/** A rule: a target row and the (row, sign) terms that sum to it. */
export type Rule = [string, [string, number][]]

export const IS_IMPUTE: Record<string, Rule[]> = {
  'industrial': [
    [
      'total_cost_of_revenue',
      [
        ['costs_and_expenses', 1],
        ['total_operating_expenses', -1],
      ],
    ],
    [
      'total_operating_expenses',
      [
        ['costs_and_expenses', 1],
        ['total_cost_of_revenue', -1],
      ],
    ],
    [
      'costs_and_expenses',
      [
        ['total_revenue', 1],
        ['total_operating_income', -1],
      ],
    ],
    [
      'total_gross_profit',
      [
        ['total_revenue', 1],
        ['total_cost_of_revenue', -1],
      ],
    ],
    [
      'total_cost_of_revenue',
      [
        ['total_revenue', 1],
        ['total_gross_profit', -1],
      ],
    ],
    [
      'total_operating_expenses',
      [
        ['total_gross_profit', 1],
        ['total_operating_income', -1],
      ],
    ],
    [
      'total_operating_income',
      [
        ['total_gross_profit', 1],
        ['total_operating_expenses', -1],
      ],
    ],
    [
      'total_other_income',
      [
        ['total_pretax_income', 1],
        ['total_operating_income', -1],
        ['equity_method_investments', -1],
      ],
    ],
    [
      'total_other_income',
      [
        ['total_pretax_income', 1],
        ['total_operating_income', -1],
      ],
    ],
  ],
  'diversified': [
    [
      'total_operating_income',
      [
        ['total_pretax_income', 1],
        ['total_other_income', -1],
      ],
    ],
    [
      'total_operating_income',
      [
        ['total_revenue', 1],
        ['costs_and_expenses', -1],
      ],
    ],
    [
      'costs_and_expenses',
      [
        ['total_revenue', 1],
        ['total_operating_income', -1],
      ],
    ],
    [
      'total_other_income',
      [
        ['total_pretax_income', 1],
        ['total_operating_income', -1],
        ['equity_method_investments', -1],
      ],
    ],
    [
      'total_other_income',
      [
        ['total_pretax_income', 1],
        ['total_operating_income', -1],
      ],
    ],
  ],
  'financial': [
    [
      'total_interest_income',
      [
        ['net_interest_income', 1],
        ['total_interest_expense', 1],
      ],
    ],
    [
      'net_interest_income_after_provision',
      [
        ['net_interest_income', 1],
        ['provision_for_credit_losses', -1],
      ],
    ],
    [
      'total_revenue',
      [
        ['net_interest_income', 1],
        ['total_noninterest_income', 1],
      ],
    ],
    [
      'total_revenue',
      [
        ['total_pretax_income', 1],
        ['total_noninterest_expense', 1],
        ['provision_for_credit_losses', 1],
      ],
    ],
    [
      'total_revenue',
      [
        ['total_pretax_income', 1],
        ['total_noninterest_expense', 1],
      ],
    ],
  ],
  'insurance': [
    [
      'total_pretax_income',
      [
        ['total_revenue', 1],
        ['benefits_costs_expenses', -1],
      ],
    ],
    [
      'benefits_costs_expenses',
      [
        ['total_revenue', 1],
        ['total_pretax_income', -1],
      ],
    ],
  ],
}

export const IS_VERIFY: Rule[] = [
  [
    'total_pretax_income',
    [
      ['net_income_continuing', 1],
      ['income_tax_expense', 1],
    ],
  ],
  [
    'net_income_continuing',
    [
      ['total_pretax_income', 1],
      ['income_tax_expense', -1],
    ],
  ],
  [
    'total_gross_profit',
    [
      ['total_revenue', 1],
      ['total_cost_of_revenue', -1],
    ],
  ],
  [
    'total_operating_income',
    [
      ['total_gross_profit', 1],
      ['total_operating_expenses', -1],
    ],
  ],
]

export const BS_VERIFY: Rule[] = [
  [
    'total_assets',
    [
      ['total_liabilities_and_equity', 1],
    ],
  ],
  [
    'total_equity_and_noncontrolling_interests',
    [
      ['total_equity', 1],
      ['noncontrolling_interests', 1],
    ],
  ],
  [
    'total_equity',
    [
      ['total_equity_and_noncontrolling_interests', 1],
      ['noncontrolling_interests', -1],
    ],
  ],
  [
    'total_liabilities',
    [
      ['total_liabilities_and_equity', 1],
      ['total_equity_and_noncontrolling_interests', -1],
      ['temporary_equity', -1],
    ],
  ],
  [
    'total_liabilities',
    [
      ['total_liabilities_and_equity', 1],
      ['total_equity_and_noncontrolling_interests', -1],
    ],
  ],
]

export const CF_VERIFY: Rule[] = [
  [
    'net_change_in_cash',
    [
      ['net_cash_from_operating_activities', 1],
      ['net_cash_from_investing_activities', 1],
      ['net_cash_from_financing_activities', 1],
      ['effect_of_exchange_rate_changes', 1],
    ],
  ],
  [
    'net_change_in_cash',
    [
      ['net_cash_from_operating_activities', 1],
      ['net_cash_from_investing_activities', 1],
      ['net_cash_from_financing_activities', 1],
    ],
  ],
  [
    'net_change_in_cash',
    [
      ['net_cash_from_operating_activities', 1],
      ['net_cash_from_investing_activities', 1],
      ['net_cash_from_financing_activities', 1],
      ['effect_of_exchange_rate_changes', 1],
      ['other_net_changes_in_cash', 1],
    ],
  ],
  [
    'net_change_in_cash',
    [
      ['net_cash_from_operating_activities', 1],
      ['net_cash_from_investing_activities', 1],
      ['net_cash_from_financing_activities', 1],
      ['other_net_changes_in_cash', 1],
    ],
  ],
]

export const IS_IMPUTE_COMMON: Rule[] = [
  [
    'total_pretax_income',
    [
      ['net_income_continuing', 1],
      ['income_tax_expense', 1],
    ],
  ],
  [
    'net_income_continuing',
    [
      ['total_pretax_income', 1],
      ['income_tax_expense', -1],
    ],
  ],
  [
    'net_income',
    [
      ['net_income_continuing', 1],
      ['net_income_discontinued', 1],
    ],
  ],
  [
    'comprehensive_income',
    [
      ['comprehensive_income_parent', 1],
      ['comprehensive_income_nci', 1],
    ],
  ],
  [
    'comprehensive_income_parent',
    [
      ['comprehensive_income', 1],
      ['comprehensive_income_nci', -1],
    ],
  ],
  [
    'comprehensive_income_nci',
    [
      ['comprehensive_income', 1],
      ['comprehensive_income_parent', -1],
    ],
  ],
  [
    'income_tax_expense',
    [
      ['income_tax_current', 1],
      ['income_tax_deferred', 1],
    ],
  ],
  [
    'income_tax_current',
    [
      ['income_tax_expense', 1],
      ['income_tax_deferred', -1],
    ],
  ],
  [
    'income_tax_deferred',
    [
      ['income_tax_expense', 1],
      ['income_tax_current', -1],
    ],
  ],
  [
    'total_pretax_income',
    [
      ['income_before_equity_method', 1],
      ['equity_method_investments', 1],
    ],
  ],
  [
    'income_before_equity_method',
    [
      ['total_pretax_income', 1],
      ['equity_method_investments', -1],
    ],
  ],
  [
    'net_income_to_noncontrolling_interest',
    [
      ['net_income_nci_redeemable', 1],
      ['net_income_nci_nonredeemable', 1],
    ],
  ],
]

export const BS_IMPUTE: Rule[] = [
  [
    'gross_ppe',
    [
      ['net_ppe', 1],
      ['accumulated_depreciation', 1],
    ],
  ],
  [
    'accumulated_depreciation',
    [
      ['gross_ppe', 1],
      ['net_ppe', -1],
    ],
  ],
  [
    'total_noncurrent_assets',
    [
      ['total_assets', 1],
      ['total_current_assets', -1],
    ],
  ],
  [
    'total_noncurrent_liabilities',
    [
      ['total_liabilities', 1],
      ['total_current_liabilities', -1],
    ],
  ],
  [
    'total_liabilities_and_equity',
    [
      ['total_assets', 1],
    ],
  ],
  [
    'total_liabilities',
    [
      ['total_liabilities_and_equity', 1],
      ['total_equity_and_noncontrolling_interests', -1],
      ['temporary_equity', -1],
    ],
  ],
  [
    'total_liabilities',
    [
      ['total_liabilities_and_equity', 1],
      ['total_equity_and_noncontrolling_interests', -1],
    ],
  ],
  [
    'total_equity_and_noncontrolling_interests',
    [
      ['total_equity', 1],
      ['noncontrolling_interests', 1],
    ],
  ],
  [
    'total_equity',
    [
      ['total_equity_and_noncontrolling_interests', 1],
      ['noncontrolling_interests', -1],
    ],
  ],
  [
    'total_common_equity',
    [
      ['total_equity', 1],
      ['total_preferred_equity', -1],
    ],
  ],
  [
    'total_common_equity',
    [
      ['total_equity', 1],
    ],
  ],
  [
    'total_equity_and_noncontrolling_interests',
    [
      ['total_equity', 1],
    ],
  ],
  [
    'redeemable_noncontrolling_interest',
    [
      ['redeemable_nci_common', 1],
      ['redeemable_nci_preferred', 1],
      ['redeemable_nci_other', 1],
    ],
  ],
]

export const CF_IMPUTE: Rule[] = [
  [
    'net_change_in_cash',
    [
      ['net_cash_from_operating_activities', 1],
      ['net_cash_from_investing_activities', 1],
      ['net_cash_from_financing_activities', 1],
      ['effect_of_exchange_rate_changes', 1],
    ],
  ],
  [
    'depreciation_and_amortization',
    [
      ['depreciation_expense', 1],
      ['amortization_expense', 1],
    ],
  ],
]

export const OTHER_LINES: Record<string, string[]> = {
  'total_gross_profit': ['total_cost_of_revenue'],
  'total_operating_income': ['total_operating_expenses', 'costs_and_expenses'],
  'total_pretax_income': ['total_other_income', 'benefits_costs_expenses'],
  'total_other_income': ['other_income'],
  'costs_and_expenses': ['other_operating_expenses'],
  'total_noninterest_expense': ['other_operating_expenses'],
  'benefits_costs_expenses': ['other_operating_expenses'],
  'net_interest_income': ['total_interest_expense'],
  'net_income_to_common': ['other_adjustments_to_net_income_to_common'],
  'comprehensive_income': ['comprehensive_income_nci'],
  'total_assets': ['total_noncurrent_assets'],
  'total_liabilities': ['total_noncurrent_liabilities', 'other_long_term_liabilities'],
  'total_equity': ['total_common_equity'],
  'total_liabilities_and_equity': ['temporary_equity'],
  'redeemable_noncontrolling_interest': ['redeemable_nci_other'],
  'total_common_equity': ['other_equity'],
  'net_cash_from_continuing_operating_activities': ['other_operating_activities'],
  'increase_decrease_in_operating_capital': ['change_in_other_operating_assets_and_liabilities'],
  'net_cash_from_continuing_investing_activities': ['other_investing_activities_net'],
  'net_cash_from_continuing_financing_activities': ['other_financing_activities_net'],
  'net_change_in_cash': ['other_net_changes_in_cash'],
}

export const ROLLUP_REQUIRES: Record<string, string[]> = {
  'total_gross_profit': ['total_cost_of_revenue'],
  'total_operating_income': [],
  'total_operating_expenses': [],
  'total_pretax_income': ['total_operating_income'],
  'net_interest_income': ['total_interest_expense'],
  'total_assets': ['total_noncurrent_assets'],
  'total_liabilities': ['total_noncurrent_liabilities'],
  'total_liabilities_and_equity': ['total_liabilities'],
  'comprehensive_income_parent': [],
  'comprehensive_income_nci': [],
}

export const WHOLE_REMAINDERS: ReadonlySet<string> = new Set(['total_equity'])

export const REMAINDER_REQUIRES: Record<string, string[]> = {
  'total_pretax_income': ['total_operating_income'],
}

export const ADDITIVE_PER_SHARE: ReadonlySet<string> = new Set(['cash_dividends_per_share'])

export const DILUTED_SHARES: Record<string, string> = {
  'weighted_ave_diluted_shares_os': 'weighted_ave_basic_shares_os',
}

export const EPS_NUMERATOR: string = 'net_income_to_common'

export const SINGLE_STEP: [string, string, string] = ['total_revenue', 'costs_and_expenses', 'total_pretax_income']

export const EVIDENCED_LINES: Record<string, string> = {
  'temporary_equity': 'total_liabilities',
}

export const NONNEGATIVE_CONCEPTS: ReadonlySet<string> = new Set(['us-gaap:AccountsPayableCurrent', 'us-gaap:AccountsReceivableNetCurrent', 'us-gaap:AccumulatedDepreciationDepletionAndAmortizationPropertyPlantAndEquipment', 'us-gaap:CashAndCashEquivalentsAtCarryingValue', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfGoodsSold', 'us-gaap:CostOfRevenue', 'us-gaap:Depreciation', 'us-gaap:Goodwill', 'us-gaap:InterestAndDebtExpense', 'us-gaap:InterestExpense', 'us-gaap:InterestExpenseDebt', 'us-gaap:InterestExpenseNonoperating', 'us-gaap:InterestPaid', 'us-gaap:InterestPaidNet', 'us-gaap:InventoryNet', 'us-gaap:LongTermDebtCurrent', 'us-gaap:LongTermDebtNoncurrent', 'us-gaap:PaymentsForRepurchaseOfCommonStock', 'us-gaap:PaymentsOfDividends', 'us-gaap:PaymentsOfDividendsCommonStock', 'us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PropertyPlantAndEquipmentGross', 'us-gaap:ResearchAndDevelopmentExpense', 'us-gaap:SellingGeneralAndAdministrativeExpense', 'us-gaap:ShortTermBorrowings', 'us-gaap:TreasuryStockCommonValue', 'us-gaap:TreasuryStockValue'])

export const FILER_SCALES: number[] = [1000, 1000000]

export const SCALED_FILING_MIN: number = 10

export const SCALE_SPAN: number = 1.0

export const WEIGHTED_SHARE_CONCEPTS: ReadonlySet<string> = new Set(['ifrs-full:AdjustedWeightedAverageShares', 'ifrs-full:WeightedAverageShares', 'us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding', 'us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'us-gaap:WeightedAverageNumberOfSharesOutstandingBasic'])

export const NET_POSITIONS: Record<string, string> = {
  'us-gaap:AmortizationOfIntangibleAssets': 'debit',
  'us-gaap:DeferredIncomeTaxLiabilities': 'credit',
  'us-gaap:DeferredIncomeTaxLiabilitiesNet': 'credit',
  'us-gaap:DeferredTaxAssetsLiabilitiesNetNoncurrent': 'debit',
  'us-gaap:DeferredTaxLiabilities': 'credit',
  'us-gaap:DeferredTaxLiabilitiesNoncurrent': 'credit',
  'us-gaap:DepreciationAmortizationAndAccretionNet': 'debit',
  'us-gaap:DepreciationAndAmortization': 'debit',
  'us-gaap:DepreciationDepletionAndAmortization': 'debit',
}

export const NONNEGATIVE_LINES: ReadonlySet<string> = new Set(['benefits_costs_expenses', 'costs_and_expenses', 'other_current_assets', 'other_current_liabilities', 'other_depreciation_and_amortization', 'other_net_ppe', 'other_noncurrent_assets', 'other_noncurrent_liabilities', 'other_temporary_equity', 'temporary_equity', 'total_cost_of_revenue', 'total_interest_expense', 'total_noncurrent_assets', 'total_noncurrent_liabilities'])

export const CLASSIFIED_SECTIONS: [string, string][] = [
  ['total_current_assets', 'total_noncurrent_assets'],
  ['total_current_liabilities', 'total_noncurrent_liabilities'],
]

export const BALANCE_TOTALS: string[] = ['total_assets', 'total_liabilities', 'total_liabilities_and_equity']

export const CHAIN_SUBSETS: Record<string, [string, string][]> = {
  'rd_expense': [
    ['us-gaap:ResearchAndDevelopmentExpense', 'us-gaap:ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
  ],
  'total_revenue': [
    ['us-gaap:Revenues', 'us-gaap:SalesRevenueNet'],
  ],
  'operating_revenue': [
    ['us-gaap:Revenues', 'us-gaap:SalesRevenueNet'],
  ],
  'total_cost_of_revenue': [
    ['us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfRevenue'],
  ],
  'operating_cost_of_revenue': [
    ['us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfRevenue'],
  ],
}

export const SOFT_TOTALS: ReadonlySet<string> = new Set(['net_cash_from_financing_activities', 'net_cash_from_investing_activities', 'net_cash_from_operating_activities'])

export const SCOPE_VARIANTS: ReadonlySet<string> = new Set(['effect_of_exchange_rate_changes', 'equity_method_investments', 'excise_and_sales_taxes', 'net_cash_from_discontinued_financing_activities', 'net_cash_from_discontinued_investing_activities', 'net_cash_from_discontinued_operating_activities', 'net_income_discontinued', 'other_gains', 'preferred_dividends', 'total_interest_expense', 'total_interest_income'])

export const CONTAINABLE: ReadonlySet<string> = new Set(['accrued_interest_payable', 'asset_retirement_and_litigation_obligation', 'capital_lease_obligations', 'current_deferred_revenue', 'current_deferred_tax_assets', 'current_employee_benefit_liabilities', 'current_portion_of_long_term_debt', 'dividends_payable', 'employee_benefit_assets', 'finance_lease_liability_current', 'finance_lease_right_of_use_asset', 'interest_bearing_deposits_at_other_banks', 'noncurrent_deferred_revenue', 'noncurrent_deferred_tax_assets', 'noncurrent_deferred_tax_liabilities', 'noncurrent_employee_benefit_liabilities', 'operating_lease_liability_current', 'operating_lease_liability_noncurrent', 'operating_lease_right_of_use_asset', 'other_taxes_payable', 'prepaid_expenses', 'restricted_cash'])

export const PROMOTABLE_MEMOS: ReadonlySet<string> = new Set(['depreciation_and_amortization', 'net_cash_from_discontinued_operations', 'total_operating_expenses'])

export const MAX_IMPUTE_PASSES: number = 10

export const CF_SIGN_KEEP: ReadonlySet<string> = new Set(['net_income', 'net_income_continuing', 'net_income_discontinued'])

export const IDENTITIES: Record<string, [string, [string, number][] | null][]> = {
  'balance_sheet': [
    [
      'total_assets',
      [
        ['total_liabilities_and_equity', 1],
      ],
    ],
    [
      'total_liabilities_and_equity',
      null,
    ],
    [
      'total_equity_and_noncontrolling_interests',
      null,
    ],
  ],
  'income_statement': [
    [
      'net_income_continuing',
      null,
    ],
    [
      'total_operating_income',
      null,
    ],
    [
      'total_gross_profit',
      null,
    ],
  ],
  'cash_flow': [
    [
      'net_change_in_cash',
      null,
    ],
    [
      'cash_at_end_of_period',
      [
        ['cash_at_beginning_of_period', 1],
        ['net_change_in_cash', 1],
      ],
    ],
  ],
}

export const BALANCE_IDENTITY_LINES: ReadonlySet<string> = new Set(['noncontrolling_interests', 'temporary_equity', 'total_assets', 'total_equity', 'total_equity_and_noncontrolling_interests', 'total_liabilities', 'total_liabilities_and_equity'])
