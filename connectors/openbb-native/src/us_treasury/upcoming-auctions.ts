// ustreasury/upcoming_auctions, provider us_treasury. Ported from openbb_government_us/treasury/models/upcoming_auctions.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { type FieldTable, validateModel } from './coerce.js'
import { EmptyDataError, getFiscalData, optString, sortedAsc } from './helpers.js'

const ENDPOINT = 'v1/accounting/od/upcoming_auctions'

const SECURITY_TYPE_MAP: Record<string, string> = { bill: 'Bill', note: 'Note', bond: 'Bond', cmb: 'CMB', frn: 'FRN Note', tips: 'TIPS Note' }

const FIELDS: FieldTable = {
  auction_date: 'date!',
  security_type: 'str!',
  security_term: 'str!',
  cusip: 'str!',
  offering_amount: 'float',
  reopening: 'bool!',
  announcement_date: 'date!',
  issue_date: 'date!',
  as_of_date: 'date!',
}

export async function upcomingAuctions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const securityType = optString(params, 'security_type')
  if (securityType !== undefined && !(securityType in SECURITY_TYPE_MAP)) throw new Error(`Input should be 'bill', 'note', 'bond', 'cmb', 'frn' or 'tips': ${securityType}`)
  const data = await getFiscalData(ctx, ENDPOINT)

  // Only the latest published snapshot.
  const latest = data.map((r) => String(r.record_date)).reduce((a, b) => (b > a ? b : a))
  let rows = data.filter((r) => r.record_date === latest)
  if (securityType !== undefined) {
    const target = SECURITY_TYPE_MAP[securityType]
    rows = rows.filter((r) => r.security_type === target)
  }
  if (rows.length === 0) throw new EmptyDataError(`No upcoming auctions for security_type '${securityType}' in the ${latest} snapshot.`)
  rows = sortedAsc(rows, (r) => [String(r.auction_date), String(r.issue_date)])
  return rows.map((row) =>
    validateModel(
      FIELDS,
      {},
      {
        auction_date: row.auction_date,
        security_type: row.security_type,
        security_term: row.security_term,
        cusip: row.cusip,
        offering_amount: row.offering_amt,
        reopening: row.reopening === 'Yes',
        announcement_date: row.announcemt_date,
        issue_date: row.issue_date,
        as_of_date: row.record_date,
      },
      'UpcomingTreasuryAuctionsData',
    ),
  )
}
