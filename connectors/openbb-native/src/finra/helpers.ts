// Ported from openbb_finra/utils/helpers.py and openbb_finra/utils/trace.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain objects instead of dicts and pydantic models.
import type { Row } from '../types.js'
import {
  AMORTIZATION_TYPES,
  COUPON_TYPES,
  INDUSTRY_GROUPS,
  INTEREST_TYPES,
  MONTHS,
  MORTGAGE_PRODUCTS,
  NA_TOKENS,
  PRICE_TYPES,
  PRODUCT_SUB_TYPES,
  PRODUCT_TYPES,
  SUB_PRODUCT_TYPES,
  TRACE_BOOL_FIELDS,
  TRACE_DATE_FIELDS,
  TRACE_GRADES,
  TRACE_NUMBER_FIELDS,
} from './constants.js'

/** A stripped string, or undefined for a blank or not-available value (`clean`). */
export function clean(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = (typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)).trim()
  return NA_TOKENS.includes(text.toUpperCase()) ? undefined : text
}

/** A number, or undefined when the value is not one (`to_float`). */
export function toFloat(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return value
  const text = clean(value)?.replaceAll(',', '').trim()
  if (text === undefined) return undefined
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text)
  // What Python's float() reads besides decimals.
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity
  return /^[+-]?nan$/i.test(text) ? Number.NaN : undefined
}

/** A flag, or undefined when the value is not a recognised one (`to_bool`). */
export function toBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const text = clean(value)
  if (text === undefined) return undefined
  const upper = text.toUpperCase()
  if (['Y', 'YES', 'TRUE', 'T', '1'].includes(upper)) return true
  if (['N', 'NO', 'FALSE', 'F', '0'].includes(upper)) return false
  return undefined
}

/** An ISO date from YYYY-MM-DD, YYYYMMDD or MM/DD/YYYY text, else undefined (`to_date`). */
export function toDate(value: unknown): string | undefined {
  const text = clean(value) ?? ''
  if (text.length >= 10 && text[4] === '-' && text[7] === '-') return text.slice(0, 10)
  if (text.length === 8 && /^\d+$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
  const m = /^(\d{2})[-/](\d{2})[-/](\d{4})(?:\s.*)?$/.exec(text)
  return m ? `${m[3]}-${m[1]}-${m[2]}` : undefined
}

/** The description of a code, the code itself when the table has none, undefined when it is blank (`decode`). */
export function decode(table: Record<string, string>, value: unknown): string | undefined {
  const text = clean(value)
  if (text === undefined) return undefined
  const key = text.toUpperCase()
  return Object.hasOwn(table, key) ? table[key] : text
}

/** The distinct, upper-cased symbols of a comma-separated string, in the order given (`split_symbols`). */
export function splitSymbols(value: string): string[] {
  return [...new Set(value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))]
}

/** The `symbol`-like param as one comma-separated string: the connector sends lists as arrays. */
export function joinParam(value: unknown): string {
  return Array.isArray(value) ? value.join(',') : String(value ?? '')
}

/** A TRACE record with typed values and decoded codes (`normalize_trace_record`); missing values are left out. */
export function normalizeTraceRecord(record: Row, bondType?: string): Row {
  const decodes: Record<string, Record<string, string>> = {
    couponType: COUPON_TYPES[bondType ?? ''] ?? {},
    industryGroup: INDUSTRY_GROUPS,
    traceGradeCode: TRACE_GRADES,
    productSubTypeCode: PRODUCT_SUB_TYPES,
    subProductType: SUB_PRODUCT_TYPES,
    interestType: INTEREST_TYPES,
    mortgageProduct: MORTGAGE_PRODUCTS,
    amortizationType: AMORTIZATION_TYPES,
    settlementDateMonth: MONTHS,
    priceType: PRICE_TYPES,
    productType: PRODUCT_TYPES,
  }
  const out: Row = {}
  for (const [field, value] of Object.entries(record)) {
    let normalized: unknown
    if (TRACE_NUMBER_FIELDS.has(field)) normalized = toFloat(value)
    else if (field === 'isPerpetual' && typeof value === 'string') {
      const flag = value.trim().toUpperCase()
      normalized = ['PERPETUAL', 'NOT PERPETUAL', 'Y', 'N'].includes(flag) ? ['PERPETUAL', 'Y'].includes(flag) : undefined
    } else if (TRACE_BOOL_FIELDS.has(field)) normalized = toBool(value)
    else if (TRACE_DATE_FIELDS.has(field)) normalized = toDate(value)
    else {
      const text = clean(value)
      normalized = text !== undefined && field in decodes ? decode(decodes[field]!, text) : text
    }
    if (normalized !== undefined) out[field] = normalized
  }
  return out
}

/** TRACE (camelCase) field → OpenBB field (the models' `__alias_dict__` entries and the camel-case aliases of the rest). */
const TRACE_FIELD_NAMES: Record<string, string> = {
  tradeDate: 'date',
  issueSymbolIdentifier: 'symbol',
  finraSecurityIdentifier: 'finra_security_id',
  lastSalePrice: 'price',
  dailyLastSaleYieldDirection: 'yield_direction',
  nextCallDate: 'call_date',
  productSubTypeCode: 'product_sub_type',
  traceGradeCode: 'grade',
  moodyRatingDate: 'moodys_rating_date',
  standardAndPoorsRating: 'sp_rating',
  standardAndPoorsRatingDate: 'sp_rating_date',
  benchmarkTermCode: 'benchmark_term',
  is144A: 'is_144a',
  priceChangeNumber: 'price_change',
  priceChangePercent: 'price_change_percent',
  settlementDateMonth: 'settlement_month',
  referenceDataIdentifier: 'reference_data_id',
  loanToValueRatio: 'loan_to_value',
}

/** A TRACE record under OpenBB's field names; a key no model field claims keeps its own name, as an extra field does. */
export function traceFields(record: Row): Row {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [TRACE_FIELD_NAMES[k] ?? k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]))
}

// ---- TRACE bond search (openbb_finra/utils/trace.py) ----

/** Whether a value is a CUSIP with a valid check digit (`is_cusip`). */
export function isCusip(value: string): boolean {
  const text = value.trim().toUpperCase()
  if (text.length !== 9 || !/^[A-Z0-9]+$/.test(text) || !/\d/.test(text[8]!)) return false
  let total = 0
  for (let position = 0; position < 8; position++) {
    const ch = text[position]!
    let number = /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10
    if (position % 2) number *= 2
    total += Math.floor(number / 10) + (number % 10)
  }
  return (10 - (total % 10)) % 10 === Number(text[8])
}

/** One case-insensitive substring filter per word of a text, all within one field (`match_filters`). */
export function matchFilters(text: string, field: string): Row[] {
  return text
    .replaceAll('%', ' ')
    .replaceAll('_', ' ')
    .split(/\s+/)
    .filter((word) => word.trim())
    .map((word) => ({ searchValue: word, fuzzy: false, synonym: false, fields: [{ name: field, boost: 1 }] }))
}

/** Python's `str(float)` for the numbers FINRA filters compare: a whole number keeps its ".0". */
export function pyStr(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1e16 ? value.toFixed(1) : String(value)
}
