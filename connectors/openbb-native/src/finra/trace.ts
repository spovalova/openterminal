// Ported from openbb_finra/utils/trace.py and the shared parts of openbb_finra/models/bond_prices.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain objects instead of pydantic models, and "today" is the UTC date (ctx.now() is
// the only clock; Python used the machine's local date).
import type { NativeCtx, Row } from '../types.js'
import type { TraceSession } from './client.js'
import { BOND_SEARCH_DATASET, BOND_SEARCH_FIELDS, BOND_TYPES } from './constants.js'
import { isCusip, matchFilters, normalizeTraceRecord, pyStr } from './helpers.js'

/** The TRACE bond-search record of each CUSIP or FINRA symbol (`resolve_bonds`). */
export async function resolveBonds(trace: TraceSession, identifiers: string[]): Promise<Row[]> {
  const queries = (
    [
      ['cusip', identifiers.filter((v) => isCusip(v))],
      ['issueSymbolIdentifier', identifiers.filter((v) => !isCusip(v))],
    ] as const
  )
    .filter(([, values]) => values.length > 0)
    .map(([field, values]) => trace.query(BOND_SEARCH_DATASET, { fields: BOND_SEARCH_FIELDS, domainFilters: [{ fieldName: field, values }] }))
  const records = new Map<string, Row>()
  for (const rows of await Promise.all(queries)) for (const row of rows) if (row.cusip && row.bondType) records.set(String(row.cusip), row)
  return [...records.values()]
}

/** The filters of a bond query, as the record fields they limit. */
export type BondFilters = {
  issuer_name?: string
  coupon_min?: number
  coupon_max?: number
  ytm_min?: number
  ytm_max?: number
  maturity_date_min?: string
  maturity_date_max?: string
  include_matured?: boolean
  limit?: number
}

/** The TRACE request filters for one bond type (`_filters`). */
function filtersFor(query: BondFilters, bondType: string, lookup: boolean, today: string): Row {
  const compare: Row[] = []
  const payload: Row = {}
  const bound = (field: string, value: unknown, operator: string) => {
    if (value !== undefined && value !== null) compare.push({ fieldName: field, fieldValue: pyStr(value), compareType: operator })
  }
  bound('couponRate', query.coupon_min, 'GTE')
  bound('couponRate', query.coupon_max, 'LTE')
  bound('lastSaleYield', query.ytm_min, 'GTE')
  bound('lastSaleYield', query.ytm_max, 'LTE')

  if (bondType !== 'TBA') {
    bound('maturityDate', query.maturity_date_min, 'GTE')
    bound('maturityDate', query.maturity_date_max, 'LTE')
    if (!(query.include_matured || lookup)) {
      payload.orFilters = [
        {
          compareFilters: [
            { fieldName: 'maturityDate', fieldValue: today, compareType: 'GREATER' },
            { fieldName: 'maturityDate', fieldValue: null, compareType: 'EQUAL' },
          ],
        },
      ]
    }
  }
  if (bondType === 'ABS') compare.push({ fieldName: 'finraSecurityIdentifier', fieldValue: null, compareType: 'NOT_EQUAL' })
  if (query.issuer_name) payload.multiFieldMatchFilters = matchFilters(query.issuer_name, bondType === 'TBA' || bondType === 'MBS' ? 'issuingAgency' : 'issuerName')
  if (compare.length > 0) payload.compareFilters = compare
  return payload
}

/** The TRACE records of one bond type that match a query, tagged with the type's label (`read_bonds`). */
export async function readBonds(ctx: NativeCtx, trace: TraceSession, query: BondFilters, bondType: string, cusips: string[]): Promise<Row[]> {
  const type = BOND_TYPES[bondType]
  if (!type) throw new Error(`Unknown bond type ${bondType}`)
  const payload: Row = {
    fields: type.fields,
    sortFields: ['finraSecurityIdentifier'],
    ...filtersFor(query, bondType, cusips.length > 0, ctx.now().toISOString().slice(0, 10)),
  }
  if (cusips.length > 0) payload.domainFilters = [{ fieldName: 'cusip', values: cusips }]
  const rows = await trace.query(type.dataset, payload, query.limit)
  return rows.map((row) => ({ ...normalizeTraceRecord(row, bondType), bondType: type.label }))
}

/** The first record of each FINRA security across the pages (`distinct_bonds`). */
export function distinctBonds(pages: Row[][]): Row[] {
  const records = new Map<string, Row>()
  for (const page of pages) {
    for (const row of page) {
      const key = String(row.finraSecurityIdentifier || row.cusip)
      if (!records.has(key)) records.set(key, row)
    }
  }
  return [...records.values()]
}
