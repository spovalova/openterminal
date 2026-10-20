// Field tables of the Data models in openbb_government_us/treasury/models (OpenBB Platform 5.0.0, Apache-2.0), read off the
// pydantic classes: name → type (see coerce.ts), `__alias_dict__` as field → source key. Generated once from the models
// with pydantic's model_fields; edit by hand only to follow a change in the Python.
import type { FieldTable } from './coerce.js'

/** TreasuryAuctionResultsData: field types and the `__alias_dict__` (field → source key). */
export const AUCTION_RESULTS_FIELDS: FieldTable = {
  auction_date: 'date!', security_type: 'str!', security_term: 'str!', cusip: 'str!', issue_date: 'date!', maturity_date: 'date!',
  announcement_date: 'date!', price_per_100: 'float', accrued_interest_per_100: 'float', accrued_interest_per_1000: 'float',
  adjusted_accrued_interest_per_1000: 'float', adjusted_price: 'float', allocation_percentage: 'float', allocation_percentage_decimals: 'int',
  announced_cusip: 'str', auction_format: 'str', avg_median_discount_rate: 'float', avg_median_investment_rate: 'float', avg_median_price: 'float',
  avg_median_discount_margin: 'float', avg_median_yield: 'float', back_dated: 'bool', back_dated_date: 'date', bid_to_cover_ratio: 'float',
  callable: 'bool', call_date: 'date', called_date: 'date', cash_management_bill: 'bool!', closing_time_competitive: 'str',
  closing_time_noncompetitive: 'str', competitive_accepted: 'float', competitive_bid_decimals: 'int', competitive_tendered: 'float',
  competitive_tenders_accepted: 'bool', corpus_cusip: 'str', cpi_base_reference_period: 'str', currently_outstanding: 'float', dated_date: 'date',
  direct_bidder_accepted: 'float', direct_bidder_tendered: 'float', estimated_amount_of_publicly_held_maturing_securities: 'float',
  fima_included: 'bool', fima_noncompetitive_accepted: 'float', fima_noncompetitive_tendered: 'float', first_interest_period: 'str',
  first_interest_payment_date: 'date', floating_rate: 'bool!', frn_index_determination_date: 'date', frn_index_determination_rate: 'float',
  high_discount_rate: 'float', high_investment_rate: 'float', high_price: 'float', high_discount_margin: 'float', high_yield: 'float',
  index_ratio_on_issue_date: 'float', indirect_bidder_accepted: 'float', indirect_bidder_tendered: 'float', interest_payment_frequency: 'str',
  interest_rate: 'float', low_discount_rate: 'float', low_investment_rate: 'float', low_price: 'float', low_discount_margin: 'float',
  low_yield: 'float', maturing_date: 'date', maximum_competitive_award: 'float', maximum_noncompetitive_award: 'float', maximum_single_bid: 'float',
  minimum_bid_amount: 'float', minimum_strip_amount: 'float', minimum_to_issue: 'float', multiples_to_bid: 'float', multiples_to_issue: 'float',
  nlp_exclusion_amount: 'float', nlp_reporting_threshold: 'float', noncompetitive_accepted: 'float', noncompetitive_tenders_accepted: 'bool',
  offering_amount: 'float', original_cusip: 'str', original_dated_date: 'date', original_issue_date: 'date', original_security_term: 'str',
  pdf_announcement: 'str', pdf_competitive_results: 'str', pdf_noncompetitive_results: 'str', primary_dealer_accepted: 'float',
  primary_dealer_tendered: 'float', reference_cpi_on_dated_date: 'float', reference_cpi_on_issue_date: 'float', reopening: 'bool!',
  security_term_day_month: 'str', security_term_week_year: 'str', series: 'str', soma_accepted: 'float', soma_holdings: 'float',
  soma_included: 'bool', soma_tendered: 'float', spread: 'float', standard_interest_payment_per_1000: 'float', strippable: 'bool',
  tiin_conversion_factor_per_1000: 'float', total_accepted: 'float', total_tendered: 'float', treasury_retail_accepted: 'float',
  treasury_retail_tenders_accepted: 'bool', unadjusted_accrued_interest_per_1000: 'float', unadjusted_price: 'float', xml_announcement: 'str',
  xml_competitive_results: 'str', inflation_index_security: 'bool!', tint_cusip_1: 'str', tint_cusip_2: 'str', pdf_special_announcement: 'str',
}
export const AUCTION_RESULTS_ALIASES: Record<string, string> = {
  announcement_date: 'announcemt_date', price_per_100: 'price_per100', accrued_interest_per_100: 'accrued_int_per100',
  accrued_interest_per_1000: 'accrued_int_per1000', adjusted_accrued_interest_per_1000: 'adj_accrued_int_per1000', adjusted_price: 'adj_price',
  allocation_percentage: 'allocation_pctage', allocation_percentage_decimals: 'allocation_pctage_decimals', announced_cusip: 'announcemtd_cusip',
  avg_median_discount_rate: 'avg_med_discnt_rate', avg_median_investment_rate: 'avg_med_investment_rate', avg_median_price: 'avg_med_price',
  avg_median_discount_margin: 'avg_med_discnt_margin', avg_median_yield: 'avg_med_yield', cash_management_bill: 'cash_management_bill_cmb',
  closing_time_competitive: 'closing_time_comp', closing_time_noncompetitive: 'closing_time_noncomp', competitive_accepted: 'comp_accepted',
  competitive_bid_decimals: 'comp_bid_decimals', competitive_tendered: 'comp_tendered', competitive_tenders_accepted: 'comp_tenders_accepted',
  estimated_amount_of_publicly_held_maturing_securities: 'est_pub_held_mat_by_type_amt', fima_noncompetitive_accepted: 'fima_noncomp_accepted',
  fima_noncompetitive_tendered: 'fima_noncomp_tendered', first_interest_period: 'first_int_period',
  first_interest_payment_date: 'first_int_payment_date', high_discount_rate: 'high_discnt_rate', high_discount_margin: 'high_discnt_margin',
  interest_payment_frequency: 'int_payment_frequency', interest_rate: 'int_rate', low_discount_rate: 'low_discnt_rate',
  low_discount_margin: 'low_discnt_margin', maturing_date: 'mat_date', maximum_competitive_award: 'max_comp_award',
  maximum_noncompetitive_award: 'max_noncomp_award', maximum_single_bid: 'max_single_bid', minimum_bid_amount: 'min_bid_amt',
  minimum_strip_amount: 'min_strip_amt', minimum_to_issue: 'min_to_issue', nlp_exclusion_amount: 'nlp_exclusion_amt',
  noncompetitive_accepted: 'noncomp_accepted', noncompetitive_tenders_accepted: 'noncomp_tenders_accepted', offering_amount: 'offering_amt',
  pdf_announcement: 'pdf_filenm_announcemt', pdf_competitive_results: 'pdf_filenm_comp_results',
  pdf_noncompetitive_results: 'pdf_filenm_noncomp_results', reference_cpi_on_dated_date: 'ref_cpi_on_dated_date',
  reference_cpi_on_issue_date: 'ref_cpi_on_issue_date', standard_interest_payment_per_1000: 'std_int_payment_per1000',
  tiin_conversion_factor_per_1000: 'tiin_conversion_factor_per1000', treasury_retail_accepted: 'treas_retail_accepted',
  treasury_retail_tenders_accepted: 'treas_retail_tenders_accepted', unadjusted_accrued_interest_per_1000: 'unadj_accrued_int_per1000',
  unadjusted_price: 'unadj_price', xml_announcement: 'xml_filenm_announcemt', xml_competitive_results: 'xml_filenm_comp_results',
  pdf_special_announcement: 'pdf_filenm_spec_announcemt',
}

/** TreasuryBulletinData field types. */
export const BULLETIN_FIELDS: FieldTable = {
  table_code: 'str!', report_date: 'date', record_date: 'date!', auction_date: 'date', issue_date: 'date', maturity_date: 'date',
  days_to_maturity: 'int', fiscal_year: 'int', line_number: 'int', classification: 'str', sub_classification: 'str', issue_type: 'str',
  security_description: 'str', period_to_final_maturity: 'str', denomination: 'str', currency: 'str', state: 'str', district: 'str', port: 'str',
  port_code: 'str', bids_tendered: 'float', bids_accepted: 'float', bids_accepted_competitive: 'float', bids_accepted_noncompetitive: 'float',
  high_price_per_hundred: 'float', high_discount_rate: 'float', high_investment_rate: 'float', accepted_yield_discount_margin: 'float',
  equivalent_price: 'float', securities_amount: 'float', total_currency_and_coins: 'float', total_currency: 'float', federal_reserve_notes: 'float',
  us_notes: 'float', currency_no_longer_issued: 'float', total_coins: 'float', dollar_coins: 'float', fractional_coins: 'float', per_capita: 'float',
  spot_forward_futures_purchased: 'float', spot_forward_futures_sold: 'float', net_options_position: 'float', assets: 'float', liabilities: 'float',
  call_options_bought: 'float', call_options_written: 'float', put_options_bought: 'float', put_options_written: 'float', options_net_delta: 'float',
  exchange_rate: 'float', activity: 'float', balance: 'float', current_quarter_amount: 'float', fiscal_year_to_date_amount: 'float',
  total_collections: 'float', business_income_taxes: 'float', total_individual_taxes: 'float', withheld_income_and_fica_taxes: 'float',
  not_withheld_income_and_seca_taxes: 'float', unemployment_insurance_taxes: 'float', railroad_retirement_taxes: 'float',
  estate_and_trust_income_taxes: 'float', estate_taxes: 'float', gift_taxes: 'float', excise_taxes: 'float',
}

/** UsTreasuryAuctionsData (standard model plus the provider's own fields) field types and `__alias_dict__`. */
export const TREASURY_AUCTIONS_FIELDS: FieldTable = {
  cusip: 'str!', issue_date: 'date!', security_type: 'str!', security_term: 'str!', maturity_date: 'date!', interest_rate: 'float',
  cpi_on_issue_date: 'float', cpi_on_dated_date: 'float', announcement_date: 'date', auction_date: 'date', auction_date_year: 'int',
  dated_date: 'date', first_payment_date: 'date', accrued_interest_per_100: 'float', accrued_interest_per_1000: 'float',
  adjusted_accrued_interest_per_100: 'float', adjusted_accrued_interest_per_1000: 'float', adjusted_price: 'float', allocation_percentage: 'float',
  allocation_percentage_decimals: 'float', announced_cusip: 'str', auction_format: 'str', avg_median_discount_rate: 'float',
  avg_median_investment_rate: 'float', avg_median_price: 'float', avg_median_discount_margin: 'float', avg_median_yield: 'float',
  back_dated: 'yesno', back_dated_date: 'date', bid_to_cover_ratio: 'float', call_date: 'date', callable: 'yesno', called_date: 'date',
  cash_management_bill: 'yesno', closing_time_competitive: 'str', closing_time_non_competitive: 'str', competitive_accepted: 'int',
  competitive_accepted_decimals: 'int', competitive_tendered: 'int', competitive_tenders_accepted: 'yesno', corp_us_cusip: 'str',
  cpi_base_reference_period: 'str', currently_outstanding: 'int', direct_bidder_accepted: 'int', direct_bidder_tendered: 'int',
  est_amount_of_publicly_held_maturing_security: 'int', fima_included: 'yesno', fima_non_competitive_accepted: 'int',
  fima_non_competitive_tendered: 'int', first_interest_period: 'str', first_interest_payment_date: 'date', floating_rate: 'yesno',
  frn_index_determination_date: 'date', frn_index_determination_rate: 'float', high_discount_rate: 'float', high_investment_rate: 'float',
  high_price: 'float', high_discount_margin: 'float', high_yield: 'float', index_ratio_on_issue_date: 'float', indirect_bidder_accepted: 'int',
  indirect_bidder_tendered: 'int', interest_payment_frequency: 'str', low_discount_rate: 'float', low_investment_rate: 'float', low_price: 'float',
  low_discount_margin: 'float', low_yield: 'float', maturing_date: 'date', max_competitive_award: 'int', max_non_competitive_award: 'int',
  max_single_bid: 'int', min_bid_amount: 'int', min_strip_amount: 'int', min_to_issue: 'int', multiples_to_bid: 'int', multiples_to_issue: 'int',
  nlp_exclusion_amount: 'int', nlp_reporting_threshold: 'int', non_competitive_accepted: 'int', non_competitive_tenders_accepted: 'yesno',
  offering_amount: 'int', original_cusip: 'str', original_dated_date: 'date', original_issue_date: 'date', original_security_term: 'str',
  pdf_announcement: 'str', pdf_competitive_results: 'str', pdf_non_competitive_results: 'str', pdf_special_announcement: 'str',
  price_per_100: 'float', primary_dealer_accepted: 'int', primary_dealer_tendered: 'int', reopening: 'yesno', security_term_day_month: 'str',
  security_term_week_year: 'str', series: 'str', soma_accepted: 'int', soma_holdings: 'int', soma_included: 'yesno', soma_tendered: 'int',
  spread: 'float', standard_payment_per_1000: 'float', strippable: 'yesno', term: 'str', tiin_conversion_factor_per_1000: 'float', tips: 'yesno',
  total_accepted: 'int', total_tendered: 'int', treasury_retail_accepted: 'int', treasury_retail_tenders_accepted: 'yesno', type: 'str',
  unadjusted_accrued_interest_per_1000: 'float', unadjusted_price: 'float', updated_timestamp: 'datetime', xml_announcement: 'str',
  xml_competitive_results: 'str', xml_special_announcement: 'str', tint_cusip1: 'str', tint_cusip2: 'str', tint_cusip1_due_date: 'date',
  tint_cusip2_due_date: 'date',
}
export const TREASURY_AUCTIONS_ALIASES: Record<string, string> = {
  issue_date: 'issueDate', security_type: 'securityType', security_term: 'securityTerm', maturity_date: 'maturityDate',
  interest_rate: 'interestRate', cpi_on_issue_date: 'refCpiOnIssueDate', cpi_on_dated_date: 'refCpiOnDatedDate',
  announcement_date: 'announcementDate', auction_date: 'auctionDate', auction_date_year: 'auctionDateYear', dated_date: 'datedDate',
  first_payment_date: 'firstInterestPaymentDate', accrued_interest_per_100: 'accruedInterestPer100',
  accrued_interest_per_1000: 'accruedInterestPer1000', adjusted_accrued_interest_per_100: 'adjustedAccruedInterestPer100',
  adjusted_accrued_interest_per_1000: 'adjustedAccruedInterestPer1000', adjusted_price: 'adjustedPrice',
  allocation_percentage: 'allocationPercentage', allocation_percentage_decimals: 'allocationPercentageDecimals', announced_cusip: 'announcedCusip',
  auction_format: 'auctionFormat', avg_median_discount_rate: 'averageMedianDiscountRate', avg_median_investment_rate: 'averageMedianInvestmentRate',
  avg_median_price: 'averageMedianPrice', avg_median_discount_margin: 'averageMedianDiscountMargin', avg_median_yield: 'averageMedianYield',
  back_dated: 'backDated', back_dated_date: 'backDatedDate', bid_to_cover_ratio: 'bidToCoverRatio', call_date: 'callDate', called_date: 'calledDate',
  cash_management_bill: 'cashManagementBillCMB', closing_time_competitive: 'closingTimeCompetitive',
  closing_time_non_competitive: 'closingTimeNoncompetitive', competitive_accepted: 'competitiveAccepted',
  competitive_accepted_decimals: 'competitiveBidDecimals', competitive_tendered: 'competitiveTendered',
  competitive_tenders_accepted: 'competitiveTendersAccepted', corp_us_cusip: 'corpusCusip', cpi_base_reference_period: 'cpiBaseReferencePeriod',
  currently_outstanding: 'currentlyOutstanding', direct_bidder_accepted: 'directBidderAccepted', direct_bidder_tendered: 'directBidderTendered',
  est_amount_of_publicly_held_maturing_security: 'estimatedAmountOfPubliclyHeldMaturingSecuritiesByType', fima_included: 'fimaIncluded',
  fima_non_competitive_accepted: 'fimaNoncompetitiveAccepted', fima_non_competitive_tendered: 'fimaNoncompetitiveTendered',
  first_interest_period: 'firstInterestPeriod', first_interest_payment_date: 'firstInterestPaymentDate', floating_rate: 'floatingRate',
  frn_index_determination_date: 'frnIndexDeterminationDate', frn_index_determination_rate: 'frnIndexDeterminationRate',
  high_discount_rate: 'highDiscountRate', high_investment_rate: 'highInvestmentRate', high_price: 'highPrice',
  high_discount_margin: 'highDiscountMargin', high_yield: 'highYield', index_ratio_on_issue_date: 'indexRatioOnIssueDate',
  indirect_bidder_accepted: 'indirectBidderAccepted', indirect_bidder_tendered: 'indirectBidderTendered',
  interest_payment_frequency: 'interestPaymentFrequency', low_discount_rate: 'lowDiscountRate', low_investment_rate: 'lowInvestmentRate',
  low_price: 'lowPrice', low_discount_margin: 'lowDiscountMargin', low_yield: 'lowYield', maturing_date: 'maturingDate',
  max_competitive_award: 'maximumCompetitiveAward', max_non_competitive_award: 'maximumNoncompetitiveAward', max_single_bid: 'maximumSingleBid',
  min_bid_amount: 'minimumBidAmount', min_strip_amount: 'minimumStripAmount', min_to_issue: 'minimumToIssue', multiples_to_bid: 'multiplesToBid',
  multiples_to_issue: 'multiplesToIssue', nlp_exclusion_amount: 'nlpExclusionAmount', nlp_reporting_threshold: 'nlpReportingThreshold',
  non_competitive_accepted: 'noncompetitiveAccepted', non_competitive_tenders_accepted: 'noncompetitiveTendersAccepted',
  offering_amount: 'offeringAmount', original_cusip: 'originalCusip', original_dated_date: 'originalDatedDate',
  original_issue_date: 'originalIssueDate', original_security_term: 'originalSecurityTerm', pdf_announcement: 'pdfFilenameAnnouncement',
  pdf_competitive_results: 'pdfFilenameCompetitiveResults', pdf_non_competitive_results: 'pdfFilenameNoncompetitiveResults',
  pdf_special_announcement: 'pdfFilenameSpecialAnnouncement', price_per_100: 'pricePer100', primary_dealer_accepted: 'primaryDealerAccepted',
  primary_dealer_tendered: 'primaryDealerTendered', security_term_day_month: 'securityTermDayMonth', security_term_week_year: 'securityTermWeekYear',
  soma_accepted: 'somaAccepted', soma_holdings: 'somaHoldings', soma_included: 'somaIncluded', soma_tendered: 'somaTendered',
  standard_payment_per_1000: 'standardInterestPaymentPer1000', tiin_conversion_factor_per_1000: 'tiinConversionFactorPer1000',
  total_accepted: 'totalAccepted', total_tendered: 'totalTendered', treasury_retail_accepted: 'treasuryRetailAccepted',
  treasury_retail_tenders_accepted: 'treasuryRetailTendersAccepted', unadjusted_accrued_interest_per_1000: 'unadjustedAccruedInterestPer1000',
  unadjusted_price: 'unadjustedPrice', updated_timestamp: 'updatedTimestamp', xml_announcement: 'xmlFilenameAnnouncement',
  xml_competitive_results: 'xmlFilenameCompetitiveResults', xml_special_announcement: 'xmlFilenameSpecialAnnouncement', tint_cusip1: 'tintCusip1',
  tint_cusip2: 'tintCusip2', tint_cusip1_due_date: 'tintCusip1DueDate', tint_cusip2_due_date: 'tintCusip2DueDate',
}

/** UsTreasuryPricesData field types. */
export const TREASURY_PRICES_FIELDS: FieldTable = {
  issuer_name: 'str', cusip: 'str', isin: 'str', security_type: 'str', issue_date: 'date', maturity_date: 'date', call_date: 'date', bid: 'float',
  offer: 'float', eod_price: 'float', last_traded_date: 'date', total_trades: 'int', last_price: 'float', highest_price: 'float',
  lowest_price: 'float', rate: 'float', ytm: 'float', date: 'date!',
}

/** UsSpendingAwardData field types (the union of the six award sections). */
export const AWARD_FIELDS: FieldTable = {
  action_date: 'date', award_id: 'str!', child_award_id: 'str', transaction_id: 'str', modification_number: 'str', subaward_id: 'int',
  subaward_number: 'str', piid: 'str', fain: 'str', uri: 'str', parent_award_id: 'str', parent_piid: 'str', internal_id: 'int', record_type: 'int',
  category: 'str', award_type: 'str', award_type_description: 'str', action_type: 'str', action_type_description: 'str', amount: 'float',
  federal_action_obligation: 'float', obligated_amount: 'float', total_obligation: 'float', base_and_all_options: 'float',
  base_exercised_options: 'float', total_outlay: 'float', total_account_obligation: 'float', total_account_outlay: 'float', subaward_count: 'int',
  total_subaward_amount: 'float', total_subsidy_cost: 'float', total_loan_value: 'float', face_value_loan_guarantee: 'float',
  original_loan_subsidy_cost: 'float', non_federal_funding: 'float', total_funding: 'float', transaction_obligated_amount: 'float',
  gross_outlay_amount: 'float', total_transaction_obligated_amount: 'float', date_signed: 'date', period_start: 'date', period_end: 'date',
  period_potential_end: 'date', last_date_to_order: 'date', last_modified: 'date', recipient_name: 'str', recipient_uei: 'str',
  parent_recipient_name: 'str', parent_recipient_uei: 'str', recipient_city: 'str', recipient_state: 'str', recipient_zip: 'str',
  recipient_country: 'str', recipient_congressional_district: 'str', place_of_performance_city: 'str', place_of_performance_state: 'str',
  place_of_performance_country: 'str', place_of_performance_congressional_district: 'str', awarding_agency: 'str', awarding_subagency: 'str',
  awarding_office: 'str', funding_agency: 'str', funding_subagency: 'str', funding_office: 'str', funding_agency_abbreviation: 'str', naics: 'str',
  naics_description: 'str', psc: 'str', psc_description: 'str', cfda_number: 'str', cfda_title: 'str', federal_account: 'str', account_title: 'str',
  disaster_emergency_fund_code: 'str', object_class: 'str', object_class_name: 'str', program_activity_code: 'str', program_activity_name: 'str',
  reporting_fiscal_year: 'int', reporting_fiscal_quarter: 'int', reporting_fiscal_month: 'int', is_quarterly_submission: 'bool', description: 'str',
}

/** UsSpendingAwardSearchData field types. */
export const AWARD_SEARCH_FIELDS: FieldTable = {
  award_id: 'str!', award_number: 'str', recipient_name: 'str', recipient_uei: 'str', award_type: 'str', award_amount: 'float',
  total_outlays: 'float', awarding_agency: 'str', awarding_sub_agency: 'str', start_date: 'date', end_date: 'date', description: 'str',
  recipient_id: 'str', internal_id: 'int',
}

/** UsSpendingRecipientAwardsData field types. */
export const RECIPIENT_AWARDS_FIELDS: FieldTable = {
  award_id: 'str!', award_number: 'str', recipient_name: 'str', recipient_uei: 'str', award_type: 'str', award_amount: 'float',
  total_outlays: 'float', awarding_agency: 'str', awarding_subagency: 'str', start_date: 'date', end_date: 'date', description: 'str',
}

/** UsSpendingRecipientSearchData field types. */
export const RECIPIENT_SEARCH_FIELDS: FieldTable = {
  recipient_id: 'str!', name: 'str', recipient_level: 'str', uei: 'str', duns: 'str', amount: 'float',
}

/** UsSpendingExplorerData field types. */
export const EXPLORER_FIELDS: FieldTable = {
  name: 'str', amount: 'float', percent_of_total: 'float', code: 'str', account_number: 'str', explorer_id: 'str', as_of_date: 'str',
}

