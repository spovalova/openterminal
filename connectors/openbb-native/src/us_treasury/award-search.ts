// ustreasury/award_search, provider us_treasury. Ported from openbb_government_us/treasury/models/usaspending_award_search.py
// and utils/award_filters.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { validateModel } from './coerce.js'
import { AWARD_SEARCH_FIELDS } from './fields.js'
import { boundedInt, defaultStartDate, EmptyDataError, isoDate, literalParam, optString, today } from './helpers.js'
import { postUsaspending, REQUEST_TIMEOUT_MS } from './usaspending.js'

export const AWARD_GROUPS = ['contracts', 'idvs', 'grants', 'direct_payments', 'loans', 'other_assistance']
const SORT_FIELDS = ['Award Amount', 'Total Outlays', 'Start Date', 'End Date', 'Recipient Name', 'Award ID']

export const AWARD_TYPE_CODES: Record<string, string[]> = {
  contracts: ['A', 'B', 'C', 'D'],
  idvs: ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'],
  grants: ['02', '03', '04', '05'],
  direct_payments: ['06', '10'],
  loans: ['07', '08'],
  other_assistance: ['09', '11'],
}

export const CONTRACT_GROUPS = new Set(['contracts', 'idvs'])

const BASE_FIELDS = ['Award ID', 'Recipient Name', 'Recipient UEI', 'Award Amount', 'Total Outlays', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date', 'Description', 'generated_internal_id', 'recipient_id']

/** Source field → OpenBB field; a later entry wins when both are present. */
const FIELD_MAP: Record<string, string> = {
  generated_internal_id: 'award_id',
  'Award ID': 'award_number',
  'Recipient Name': 'recipient_name',
  'Recipient UEI': 'recipient_uei',
  'Award Amount': 'award_amount',
  'Total Outlays': 'total_outlays',
  'Awarding Agency': 'awarding_agency',
  'Awarding Sub Agency': 'awarding_sub_agency',
  'Start Date': 'start_date',
  'End Date': 'end_date',
  Description: 'description',
  recipient_id: 'recipient_id',
  internal_id: 'internal_id',
  'Contract Award Type': 'award_type',
  'Award Type': 'award_type',
}

const DATE_FIELDS = new Set(['start_date', 'end_date'])

// utils/award_filters.py: the fixed code lists the source silently ignores when a code is wrong.
const CONTRACT_PRICING: Record<string, string> = {
  A: 'Fixed Price Redetermination',
  B: 'Fixed Price Level of Effort',
  J: 'Firm Fixed Price',
  K: 'Fixed Price with Economic Price Adjustment',
  L: 'Fixed Price Incentive',
  M: 'Fixed Price Award Fee',
  R: 'Cost Plus Award Fee',
  S: 'Cost No Fee',
  T: 'Cost Sharing',
  U: 'Cost Plus Fixed Fee',
  V: 'Cost Plus Incentive Fee',
  Y: 'Time and Materials',
  Z: 'Labor Hours',
  '1': 'Order Dependent',
  '2': 'Combination',
  '3': 'Other',
}

const SET_ASIDE: Record<string, string> = {
  '8A': '8(a) Competed',
  '8AN': '8(a) Sole Source',
  '8ACCiv': 'SDB Set Aside 8(a)',
  HS3: '8(a) with HUBZone Preference',
  HS2Civ: 'Combination HUBZone and 8(a)',
  HZC: 'HUBZone Set Aside',
  HZS: 'HUBZone Sole Source',
  HMP: 'HBCU or MI Set Aside - Partial',
  HMT: 'HBCU or MI Set Aside - Total',
  BI: 'Buy Indian',
  ISEE: 'Indian Economic Enterprise',
  ISBEE: 'Indian Small Business Economic Enterprise',
  EDWOSB: 'Economically-Disadvantaged Women-Owned Small Business',
  EDWOSBSS: 'Economically Disadvantaged Women Owned Small Business Sole Source',
  WOSB: 'Women-Owned Small Business',
  WOSBSS: 'Women Owned Small Business Sole Source',
  SDVOSBC: 'Service-Disabled Veteran-Owned Small Business Set Aside',
  SDVOSBS: 'SDVOSB Sole Source',
  VSA: 'Veteran Set Aside',
  VSS: 'Veteran Sole Source',
  SBA: 'Small Business Set Aside - Total',
  SBP: 'Small Business Set Aside - Partial',
  ESB: 'Emerging Small Business Set Aside',
  RSBCiv: 'Reserved for Small Business $2,501 to $100K',
  VSBCiv: 'Very Small Business Set Aside',
  NONE: 'No Set Aside Used',
}

const EXTENT_COMPETED: Record<string, string> = {
  A: 'Full and Open Competition',
  D: 'Full and Open Competition after exclusion of sources',
  F: 'Competed under SAP',
  CDOCiv: 'Competitive Delivery Order',
  'E Civ': 'Follow On to Competed Action',
  B: 'Not Available for Competition',
  C: 'Not Competed',
  G: 'Not Competed under SAP',
  NDOCiv: 'Non-Competitive Delivery Order',
}

const CODE_LISTS: Record<string, Record<string, string>> = { contract_pricing: CONTRACT_PRICING, set_aside: SET_ASIDE, extent_competed: EXTENT_COMPETED }

/** Autocomplete endpoint and result key per reference-validated filter. */
const AUTOCOMPLETE: Record<string, [string, string]> = {
  naics: ['autocomplete/naics/', 'naics'],
  psc: ['autocomplete/psc/', 'product_or_service_code'],
  assistance_listing: ['autocomplete/cfda/', 'program_number'],
}

/** `split_codes`: a comma-separated list as stripped, non-empty entries. */
export function splitCodes(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** `validate_codes`: every code must be in the field's fixed list. */
function validateCodes(field: string, value: string | undefined): string[] {
  const codes = splitCodes(value)
  const allowed = CODE_LISTS[field]!
  const unknown = codes.filter((c) => !(c in allowed))
  if (unknown.length) {
    throw new Error(`Invalid ${field} code(s): ${unknown.join(', ')}. Valid codes are: ${Object.entries(allowed).map(([code, label]) => `${code} (${label})`).join(', ')}`)
  }
  return codes
}

/** `validate_reference_codes`: every code must match the source's autocomplete reference. */
async function validateReferenceCodes(ctx: NativeCtx, field: string, value: string | undefined): Promise<string[]> {
  const codes = splitCodes(value)
  if (codes.length === 0) return []
  const [path, key] = AUTOCOMPLETE[field]!
  for (const code of codes) {
    const response = await postUsaspending(ctx, path, { search_text: code, limit: 100 }, { timeoutMs: REQUEST_TIMEOUT_MS })
    const matches = new Set(((response.results as Row[] | undefined) ?? []).filter((row) => row[key]).map((row) => String(row[key])))
    if (!matches.has(code)) {
      const sorted = [...matches].sort()
      throw new Error(`Unknown ${field} code: '${code}'.${matches.size ? ` Did you mean one of: ${sorted.slice(0, 8).join(', ')}?` : " It matched nothing in the source's reference list."}`)
    }
  }
  return codes
}

/** `_strip_optional`: a text filter stripped to missing when blank, "none" or "null". */
function stripOptional(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  if (typeof v !== 'string') return v === undefined || v === null ? undefined : String(v)
  const value = v.trim()
  return !value || ['none', 'null'].includes(value.toLowerCase()) ? undefined : value
}

/** `datetime.strptime(value, "%Y-%m-%d").date()`. */
function strptimeDate(value: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw new Error(`time data '${value}' does not match format '%Y-%m-%d'`)
  return d.toISOString().slice(0, 10)
}

export async function awardSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const awardGroup = literalParam(params, 'award_group', AWARD_GROUPS, 'contracts')
  const sort = literalParam(params, 'sort', SORT_FIELDS, 'Award Amount')
  const order = literalParam(params, 'order', ['desc', 'asc'], 'desc')
  const page = boundedInt(params, 'page', 1, 1)
  const limit = boundedInt(params, 'limit', 100, 1, 100)
  const keywords = stripOptional(params, 'keywords')
  const recipient = stripOptional(params, 'recipient')
  const agency = stripOptional(params, 'agency')
  const awardNumber = stripOptional(params, 'award_number')
  const description = stripOptional(params, 'description')
  const naics = stripOptional(params, 'naics')
  const psc = stripOptional(params, 'psc')
  const assistanceListing = stripOptional(params, 'assistance_listing')
  const defc = stripOptional(params, 'defc')
  const minAmount = params.min_amount === undefined || params.min_amount === null || params.min_amount === '' ? undefined : Number(params.min_amount)
  const maxAmount = params.max_amount === undefined || params.max_amount === null || params.max_amount === '' ? undefined : Number(params.max_amount)

  const endDate = optString(params, 'end_date')
  const start = defaultStartDate(optString(params, 'start_date'), endDate, 365, ctx)
  const end = endDate ?? isoDate(today(ctx))
  const typeField = CONTRACT_GROUPS.has(awardGroup) ? 'Contract Award Type' : 'Award Type'

  const filters: Row = {
    award_type_codes: AWARD_TYPE_CODES[awardGroup],
    time_period: [{ start_date: start, end_date: end }],
  }
  if (keywords) filters.keywords = keywords.split(',').map((t) => t.trim()).filter(Boolean)
  if (recipient) filters.recipient_search_text = [recipient]
  if (agency) filters.agencies = [{ type: 'awarding', tier: 'toptier', name: agency }]
  const amount: Row = {}
  if (minAmount !== undefined) amount.lower_bound = minAmount
  if (maxAmount !== undefined) amount.upper_bound = maxAmount
  if (Object.keys(amount).length) filters.award_amounts = [amount]
  if (awardNumber) filters.award_ids = splitCodes(awardNumber)
  if (description) filters.description = description
  if (defc) filters.def_codes = splitCodes(defc)
  for (const [field, target, value] of [
    ['naics', 'naics_codes', naics],
    ['psc', 'psc_codes', psc],
    ['assistance_listing', 'program_numbers', assistanceListing],
  ] as const) {
    const codes = await validateReferenceCodes(ctx, field, value)
    if (codes.length) filters[target] = codes
  }
  for (const [field, target] of [
    ['contract_pricing', 'contract_pricing_type_codes'],
    ['set_aside', 'set_aside_type_codes'],
    ['extent_competed', 'extent_competed_type_codes'],
  ] as const) {
    const codes = validateCodes(field, stripOptional(params, field))
    if (codes.length) filters[target] = codes
  }

  const response = await postUsaspending(
    ctx,
    'search/spending_by_award/',
    { filters, fields: [...BASE_FIELDS, typeField], page, limit, sort, order, subawards: false },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  )
  const results = (response.results as Row[] | undefined) ?? []
  if (results.length === 0) throw new EmptyDataError(`The request was returned empty. No awards matched the search at page ${page}.`)

  const rows: Row[] = []
  for (const row of results) {
    const record: Row = {}
    for (const [source, target] of Object.entries(FIELD_MAP)) {
      if (!(source in row)) continue
      let value = row[source]
      if (DATE_FIELDS.has(target) && value) value = strptimeDate(String(value))
      record[target] = value
    }
    if (record.award_id) rows.push(validateModel(AWARD_SEARCH_FIELDS, {}, record, 'UsSpendingAwardSearchData'))
  }
  return rows
}
