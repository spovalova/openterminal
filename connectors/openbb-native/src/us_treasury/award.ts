// ustreasury/award, provider us_treasury. Ported from openbb_government_us/treasury/models/usaspending_award.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { validateModel } from './coerce.js'
import { AWARD_FIELDS } from './fields.js'
import { EmptyDataError, isNullToken, nullTokensToNone, optInt, optString } from './helpers.js'
import { getUsaspending, postUsaspending, pyQuote } from './usaspending.js'

const SECTIONS = ['detail', 'transactions', 'subawards', 'federal_accounts', 'funding', 'idv_children']
const IDV_CHILDREN_TYPES = ['child_idvs', 'child_awards', 'grandchild_awards']

const ENDPOINTS: Record<string, string> = {
  transactions: 'transactions/',
  subawards: 'subawards/',
  federal_accounts: 'awards/accounts/',
  funding: 'awards/funding/',
  idv_children: 'idvs/awards/',
}

/** The most rows a section serves per page. */
const SECTION_MAX_LIMIT: Record<string, number> = { transactions: 5000, subawards: 100, federal_accounts: 100, funding: 100, idv_children: 100 }

const SUBJECT_KEY = '_subject_award_id'

/** Per section: dotted source path → OpenBB field. */
const FIELD_MAP: Record<string, Record<string, string>> = {
  detail: {
    generated_unique_award_id: 'award_id',
    id: 'internal_id',
    category: 'category',
    type: 'award_type',
    type_description: 'award_type_description',
    description: 'description',
    piid: 'piid',
    fain: 'fain',
    uri: 'uri',
    record_type: 'record_type',
    date_signed: 'date_signed',
    total_obligation: 'total_obligation',
    base_and_all_options: 'base_and_all_options',
    base_exercised_options: 'base_exercised_options',
    total_outlay: 'total_outlay',
    total_account_obligation: 'total_account_obligation',
    total_account_outlay: 'total_account_outlay',
    subaward_count: 'subaward_count',
    total_subaward_amount: 'total_subaward_amount',
    total_subsidy_cost: 'total_subsidy_cost',
    total_loan_value: 'total_loan_value',
    non_federal_funding: 'non_federal_funding',
    total_funding: 'total_funding',
    transaction_obligated_amount: 'transaction_obligated_amount',
    'period_of_performance.start_date': 'period_start',
    'period_of_performance.end_date': 'period_end',
    'period_of_performance.potential_end_date': 'period_potential_end',
    'period_of_performance.last_modified_date': 'last_modified',
    'recipient.recipient_name': 'recipient_name',
    'recipient.recipient_uei': 'recipient_uei',
    'recipient.parent_recipient_name': 'parent_recipient_name',
    'recipient.parent_recipient_uei': 'parent_recipient_uei',
    'recipient.location.city_name': 'recipient_city',
    'recipient.location.state_code': 'recipient_state',
    'recipient.location.zip5': 'recipient_zip',
    'recipient.location.country_name': 'recipient_country',
    'recipient.location.congressional_code': 'recipient_congressional_district',
    'place_of_performance.city_name': 'place_of_performance_city',
    'place_of_performance.state_code': 'place_of_performance_state',
    'place_of_performance.country_name': 'place_of_performance_country',
    'place_of_performance.congressional_code': 'place_of_performance_congressional_district',
    'awarding_agency.toptier_agency.name': 'awarding_agency',
    'awarding_agency.subtier_agency.name': 'awarding_subagency',
    'awarding_agency.office_agency_name': 'awarding_office',
    'funding_agency.toptier_agency.name': 'funding_agency',
    'funding_agency.subtier_agency.name': 'funding_subagency',
    'funding_agency.office_agency_name': 'funding_office',
    'latest_transaction_contract_data.naics': 'naics',
    'latest_transaction_contract_data.naics_description': 'naics_description',
    'latest_transaction_contract_data.product_or_service_code': 'psc',
    'latest_transaction_contract_data.product_or_service_description': 'psc_description',
    'parent_award.generated_unique_award_id': 'parent_award_id',
    'parent_award.piid': 'parent_piid',
    'cfda_info.0.cfda_number': 'cfda_number',
    'cfda_info.0.cfda_title': 'cfda_title',
  },
  transactions: {
    id: 'transaction_id',
    type: 'award_type',
    type_description: 'award_type_description',
    action_date: 'action_date',
    action_type: 'action_type',
    action_type_description: 'action_type_description',
    modification_number: 'modification_number',
    description: 'description',
    federal_action_obligation: 'federal_action_obligation',
    face_value_loan_guarantee: 'face_value_loan_guarantee',
    original_loan_subsidy_cost: 'original_loan_subsidy_cost',
    cfda_number: 'cfda_number',
  },
  subawards: { id: 'subaward_id', subaward_number: 'subaward_number', description: 'description', action_date: 'action_date', amount: 'amount', recipient_name: 'recipient_name' },
  federal_accounts: {
    federal_account: 'federal_account',
    account_title: 'account_title',
    total_transaction_obligated_amount: 'total_transaction_obligated_amount',
    funding_agency_name: 'funding_agency',
    funding_agency_abbreviation: 'funding_agency_abbreviation',
  },
  funding: {
    transaction_obligated_amount: 'transaction_obligated_amount',
    gross_outlay_amount: 'gross_outlay_amount',
    disaster_emergency_fund_code: 'disaster_emergency_fund_code',
    federal_account: 'federal_account',
    account_title: 'account_title',
    funding_agency_name: 'funding_agency',
    awarding_agency_name: 'awarding_agency',
    object_class: 'object_class',
    object_class_name: 'object_class_name',
    program_activity_code: 'program_activity_code',
    program_activity_name: 'program_activity_name',
    reporting_fiscal_year: 'reporting_fiscal_year',
    reporting_fiscal_quarter: 'reporting_fiscal_quarter',
    reporting_fiscal_month: 'reporting_fiscal_month',
    is_quarterly_submission: 'is_quarterly_submission',
  },
  idv_children: {
    generated_unique_award_id: 'child_award_id',
    award_id: 'internal_id',
    award_type: 'award_type_description',
    description: 'description',
    piid: 'piid',
    obligated_amount: 'obligated_amount',
    last_date_to_order: 'last_date_to_order',
    period_of_performance_start_date: 'period_start',
    period_of_performance_current_end_date: 'period_end',
    funding_agency: 'funding_agency',
    awarding_agency: 'awarding_agency',
  },
}

const DATE_FIELDS = new Set(['date_signed', 'period_start', 'period_end', 'period_potential_end', 'last_modified', 'action_date', 'last_date_to_order'])

const MISSING = Symbol('missing')

/** `_get_path`: a dotted path through nested objects and lists, where an integer segment indexes a list. */
function getPath(row: unknown, path: string): unknown {
  let current = row
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part) || Number(part) >= current.length) return MISSING
      current = current[Number(part)]
    } else if (current !== null && typeof current === 'object') {
      if (!(part in (current as Row))) return MISSING
      current = (current as Row)[part]
    } else return MISSING
  }
  return current
}

/** `_to_date`: a date-time string cut to its date. */
const toDate = (value: unknown): unknown => (typeof value === 'string' ? value.split(' ')[0]!.split('T')[0]! : value)

export async function award(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const awardId = optString(params, 'award_id')
  if (awardId === undefined) throw new Error('award_id: Field required')
  const section = optString(params, 'section') ?? 'detail'
  if (!SECTIONS.includes(section)) throw new Error(`Input should be one of: ${SECTIONS.join(', ')}: ${section}`)
  const childrenType = optString(params, 'idv_children_type') ?? 'child_awards'
  if (!IDV_CHILDREN_TYPES.includes(childrenType)) throw new Error(`Input should be one of: ${IDV_CHILDREN_TYPES.join(', ')}: ${childrenType}`)
  const page = optInt(params, 'page') ?? 1
  const limit = optInt(params, 'limit') ?? 100
  if (page < 1 || limit < 1) throw new Error('Input should be greater than or equal to 1')
  const maximum = SECTION_MAX_LIMIT[section]
  if (maximum !== undefined && limit > maximum) throw new Error(`The maximum limit for section '${section}' is ${maximum}, but ${limit} was requested.`)

  // Extract: the award itself, or one of its sections (a page of rows tagged with the award they belong to).
  let data: Row[]
  let subject = awardId
  if (section === 'detail') {
    data = [await getUsaspending(ctx, `awards/${pyQuote(subject)}/`)]
  } else {
    let payload: Row
    if (section === 'idv_children') {
      const detail = await getUsaspending(ctx, `awards/${pyQuote(subject)}/`)
      const category = detail.category
      if (category !== 'idv') {
        throw new Error(
          `Award '${subject}' has category '${String(category)}', not 'idv'. The 'idv_children' section is only valid for Indefinite Delivery Vehicles, whose award ids begin with 'CONT_IDV_'. The source returns an empty list, rather than an error, for non-IDV awards.`,
        )
      }
      subject = (detail.generated_unique_award_id as string | undefined) || subject
      payload = { award_id: awardId, type: childrenType, page, limit }
    } else payload = { award_id: awardId, page, limit }
    const response = await postUsaspending(ctx, ENDPOINTS[section]!, payload)
    const results = (response.results as Row[] | undefined) ?? []
    if (results.length === 0) throw new EmptyDataError(`The request was returned empty. No '${section}' rows were found for award '${subject}' at page ${page}.`)
    data = results.map((row) => ({ ...row, [SUBJECT_KEY]: subject }))
  }

  // Transform: source paths onto OpenBB's names, then every row serves the same set of columns.
  const mapping = FIELD_MAP[section]!
  const records = data.map((row) => {
    const record: Row = {}
    for (const [source, target] of Object.entries(mapping)) {
      let value = getPath(row, source)
      if (value === MISSING || value === null || value === undefined || isNullToken(value)) continue
      if (DATE_FIELDS.has(target)) value = toDate(value)
      record[target] = value
    }
    const rowSubject = row[SUBJECT_KEY]
    if (rowSubject !== undefined && rowSubject !== null) record.award_id = rowSubject
    if (!('award_id' in record)) record.award_id = awardId
    return record
  })
  const served = Object.keys(AWARD_FIELDS).filter((field) => records.some((r) => field in r))
  return records.map((record) => {
    const row = validateModel(AWARD_FIELDS, {}, nullTokensToNone(Object.fromEntries(served.map((f) => [f, record[f] ?? null]))), 'UsSpendingAwardData')
    return row
  })
}
