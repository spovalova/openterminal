// index/constituents, provider cboe. Ported from openbb_cboe/models/index_constituents.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { getAuIndexConstituents, getEuCompanyNames } from './helpers.js'

/** Indices with constituents: Cboe Australia (CXA) and Cboe Europe (`CONSTITUENTS_AU`, `CONSTITUENTS_EU`). */
const CONSTITUENTS_AU = ['X2C', 'X2CF', 'X2CG', 'X2CN']
const CONSTITUENTS_EU = ['BAT20P', 'BBE20P', 'BCH20P', 'BCHM30P', 'BDE40P', 'BDEM50P', 'BDES50P', 'BDK25P', 'BEP50P', 'BEPACP', 'BEPBUS', 'BEPCNC', 'BEPCONC', 'BEPCONS', 'BEPENGY', 'BEPFIN', 'BEPHLTH', 'BEPIND', 'BEPNEM', 'BEPTEC', 'BEPTEL', 'BEPUTL', 'BEPXUKP', 'BES35P', 'BEZ50P', 'BEZACP', 'BFI25P', 'BFR40P', 'BFRM20P', 'BIE20P', 'BIT40P', 'BNL25P', 'BNLM25P', 'BNO25G', 'BNORD40P', 'BPT20P', 'BSE30P', 'BUK100P', 'BUK250P', 'BUK350P', 'BUKAC', 'BUKBISP', 'BUKBUS', 'BUKCNC', 'BUKCONC', 'BUKCONS', 'BUKENGY', 'BUKFIN', 'BUKHI50P', 'BUKHLTH', 'BUKIND', 'BUKLO50P', 'BUKMINP', 'BUKNEM', 'BUKSC', 'BUKTEC', 'BUKTEL', 'BUKUTL']

/** AU column → Cboe Australia's CSV header (`AU_ALIASES`), in the order the rows keep. */
const AU_ALIASES: Record<string, string> = {
  symbol: 'Symbol',
  name: 'Constituent Name',
  weight: 'Weight',
  close: 'Closing Price',
  currency: 'Currency',
  market: 'Market',
  region: 'Region',
  shares_outstanding: 'Shares in Issue',
  sedol: 'SEDOL Code',
  isin: 'ISIN Code',
  gics: 'GICS',
  security_state: 'Security State',
  float_ratio: 'Float Ratio',
  adjustment_factor: 'Adjustment Factor',
  exchange_rate: 'Exchange Rate',
  market_cap: 'Total Market Capitalisation',
  adjusted_market_cap: 'Adjusted Market Capitalisation',
}
const AU_NUMBERS = ['weight', 'close', 'shares_outstanding', 'float_ratio', 'adjustment_factor', 'exchange_rate', 'market_cap', 'adjusted_market_cap']

/** Cboe field → OpenBB field (`__alias_dict__`). */
const EU_ALIASES: Record<string, string> = { prev_day_close: 'prev_close', price_change: 'change', price_change_percent: 'change_percent', current_price: 'last_price', type: 'asset_type' }

/** `to_numeric(errors="coerce")`: a number, or undefined when the text is not one. */
function toNumeric(text: string | undefined): number | undefined {
  const t = (text ?? '').trim()
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : undefined
}

export async function indexConstituents(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol || 'BUK100P')
  const session = params.session === 'sod' ? 'sod' : 'eod'
  if (!CONSTITUENTS_AU.includes(symbol) && !CONSTITUENTS_EU.includes(symbol)) throw new Error(`symbol ${symbol} is not an index with constituents`)

  if (CONSTITUENTS_AU.includes(symbol)) {
    const rows = (await getAuIndexConstituents(ctx, symbol, session)).map((r) => {
      const out: Row = {}
      for (const [field, header] of Object.entries(AU_ALIASES)) if (header in r) out[field] = AU_NUMBERS.includes(field) ? toNumeric(r[header]) : r[header]
      // A handful of members are carried without a local ticker; the SEDOL is the only identifier present.
      if (out.symbol === '' || out.symbol === undefined) out.symbol = out.sedol
      return out
    })
    return rows.sort((a, b) => (typeof b.weight === 'number' ? b.weight : -Infinity) - (typeof a.weight === 'number' ? a.weight : -Infinity))
  }

  const body = await ctx.http.json<{ data?: Row[] } | Row[]>(`https://cdn.cboe.com/api/global/european_indices/constituent_quotes/${symbol}.json`)
  const data = Array.isArray(body) ? body : (body.data ?? [])
  if (data.length === 0) throw new Error('Cboe returned no constituents')
  let names: Map<string, string> | undefined
  try {
    names = await getEuCompanyNames(ctx)
  } catch {
    names = undefined
  }

  return data.map((raw) => {
    const row: Row = { ...raw }
    if (names && !('name' in row)) row.name = names.get(String(row.symbol ?? '').replace(/-[^-]*$/, ''))
    const out: Row = {}
    for (const [k, v] of Object.entries(row)) {
      // Percents become fractions; zeros and missing values are left out.
      const value = k === 'price_change_percent' && typeof v === 'number' ? v / 100 : v
      if (value === 0 || value === null || value === undefined || k === 'exchange_id') continue
      out[EU_ALIASES[k] ?? k] = value
    }
    return out
  })
}
