// fixedincome/government/treasury_auctions, provider us_treasury. Ported from openbb_government_us/treasury/models/treasury_auctions.py
// and openbb_core/provider/standard_models/treasury_auctions.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { pyFloat, validateModel } from './coerce.js'
import { TREASURY_AUCTIONS_ALIASES, TREASURY_AUCTIONS_FIELDS } from './fields.js'
import { isoDate, nullTokensToNone, optInt, optString, parseDate, shiftDays, today } from './helpers.js'

const BASE_URL = 'https://www.treasurydirect.gov/TA_WS/securities/search?'
const SECURITY_TYPES: Record<string, string> = { bill: 'Bill', note: 'Note', bond: 'Bond', cmb: 'CMB', tips: 'TIPS', frn: 'FRN' }

/** `YYYY-MM-DD` as `%m/%d/%Y`. */
const usDate = (iso: string): string => {
  const d = parseDate(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}

/** The model's `_normalize_percent` before-validator: percent-like keys become fractions, "Yes"/"No" stay, anything else is missing. */
function normalizePercent(data: Row): Row {
  const out: Row = { ...data }
  for (const [k, v] of Object.entries(out)) {
    if (k.endsWith('Rate') || k.endsWith('Yield') || k.endsWith('Margin') || k.endsWith('Percentage') || k.toLowerCase().includes('spread')) {
      if (v !== 'Yes' && v !== 'No' && v !== null && v !== undefined && v !== '') {
        if (!v) out[k] = null
        else {
          const n = typeof v === 'string' ? pyFloat(v) : typeof v === 'number' ? v : undefined
          if (n === undefined) throw new Error(`1 validation error for UsTreasuryAuctionsData\n  Value error, could not convert string to float: ${JSON.stringify(v)}`)
          out[k] = n / 100
        }
      } else out[k] = v === 'Yes' || v === 'No' ? v : null
    }
  }
  return out
}

export async function treasuryAuctions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const securityType = optString(params, 'security_type')
  if (securityType !== undefined && !(securityType in SECURITY_TYPES)) throw new Error(`Input should be 'bill', 'note', 'bond', 'cmb', 'tips' or 'frn': ${securityType}`)
  // The standard model's validator: the last 90 days when no window is given.
  const now = today(ctx)
  const startDate = optString(params, 'start_date') ?? isoDate(shiftDays(now, -90))
  const endDate = optString(params, 'end_date') ?? isoDate(now)

  const query: [string, string | number | undefined][] = [
    ['type', securityType === undefined ? undefined : SECURITY_TYPES[securityType]],
    ['cusip', optString(params, 'cusip')],
    ['pagesize', optInt(params, 'page_size')],
    ['pagenum', optInt(params, 'page_num')],
    ['startDate', usDate(startDate)],
    ['endDate', usDate(endDate)],
  ]
  const qs = query.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('&')
  const data = await ctx.http.json<Row[]>(`${BASE_URL}${qs}&format=json`)

  // DataFrame(...).replace({nan: None, "": None}): blank strings are missing.
  const records = data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === '' ? null : v])))
  return records.map((d) => validateModel(TREASURY_AUCTIONS_FIELDS, TREASURY_AUCTIONS_ALIASES, nullTokensToNone(normalizePercent(d)), 'UsTreasuryAuctionsData'))
}
