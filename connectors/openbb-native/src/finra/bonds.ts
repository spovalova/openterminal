// finra/fixedincome/bonds and fixedincome/corporate/bond_prices, provider finra. Ported from
// openbb_finra/models/bond_list.py and bond_prices.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models, and "today" is the UTC date.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { openTraceSession } from './client.js'
import { BOND_TYPES, UNFILTERED_BOND_TYPES } from './constants.js'
import { joinParam, splitSymbols, traceFields } from './helpers.js'
import { distinctBonds, readBonds, resolveBonds, type BondFilters } from './trace.js'

/** What the TRACE service does not publish: asking for any of it is an error, as in OpenBB. */
const UNSUPPORTED = ['country', 'isin', 'lei', 'currency', 'issued_amount_min', 'issued_amount_max']

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

function filtersOf(params: NativeParams): BondFilters {
  const filters: BondFilters = { include_matured: params.include_matured === true }
  if (params.issuer_name) filters.issuer_name = String(params.issuer_name)
  for (const k of ['coupon_min', 'coupon_max', 'ytm_min', 'ytm_max', 'limit'] as const) if (present(params[k])) filters[k] = Number(params[k])
  for (const k of ['maturity_date_min', 'maturity_date_max'] as const) if (present(params[k])) filters[k] = String(params[k])
  return filters
}

/** finra/fixedincome/bonds: every TRACE-reported bond of one type. */
export async function bondList(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bondType = String(params.bond_type || 'CA')
  const trace = await openTraceSession(ctx)
  const rows = await readBonds(ctx, trace, { include_matured: params.include_matured === true }, bondType, [])
  const values = distinctBonds([rows])
  if (values.length === 0) throw new Error(`TRACE holds no ${bondType} bonds.`)
  return values.map(traceFields)
}

/** fixedincome/corporate/bond_prices: bonds by CUSIP or FINRA symbol, or by type and filters. */
export async function bondPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const given = UNSUPPORTED.filter((name) => present(params[name]))
  if (given.length > 0) throw new Error(`FINRA TRACE does not publish ${given.join(', ')}. Remove ${given.length === 1 ? 'it.' : 'them.'}`)
  const query = filtersOf(params)
  const bondTypeParam = params.bond_type ? String(params.bond_type) : undefined
  const cusip = joinParam(params.cusip).toUpperCase()

  const trace = await openTraceSession(ctx)
  const groups = new Map<string, string[]>()
  if (cusip) {
    for (const record of await resolveBonds(trace, splitSymbols(cusip))) {
      if (bondTypeParam === undefined || bondTypeParam === record.bondType) {
        const type = String(record.bondType)
        groups.set(type, [...(groups.get(type) ?? []), String(record.cusip)])
      }
    }
  } else {
    const bondType = bondTypeParam ?? 'CA'
    const filtered = [query.issuer_name, query.coupon_min, query.coupon_max, query.maturity_date_min, query.maturity_date_max, query.ytm_min, query.ytm_max].some((v) => v !== undefined)
    if (!UNFILTERED_BOND_TYPES.includes(bondType) && !(filtered || query.limit)) {
      throw new Error(`The ${BOND_TYPES[bondType]?.label} universe holds millions of securities. Filter by issuer, coupon, maturity, or yield, or set a limit.`)
    }
    groups.set(bondType, [])
  }

  const pages = await Promise.all([...groups].map(([bondType, cusips]) => readBonds(ctx, trace, query, bondType, cusips)))
  const values = distinctBonds(pages)
  if (values.length === 0) throw new Error('No TRACE-reported bond matched the query.')
  return (query.limit ? values.slice(0, query.limit) : values).map(traceFields)
}
