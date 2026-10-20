// index/snapshots, provider cboe. Ported from openbb_cboe/models/index_snapshots.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { getIndexRows, isoDatetime } from './helpers.js'

const PERCENT_COLUMNS = ['price_change_percent', 'iv30', 'iv30_change', 'iv30_change_percent']
const DROP_COLUMNS = ['exchange_id', 'seqno', 'index', 'security_type', 'ask_size', 'bid_size']
/** Cboe field → OpenBB field (`__alias_dict__`). */
const ALIASES: Record<string, string> = { prev_day_close: 'prev_close', price_change: 'change', price_change_percent: 'change_percent', current_price: 'price' }

const REGION_URLS: Record<string, string> = {
  us: 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/all_us_indices.json',
  eu: 'https://cdn.cboe.com/api/global/european_indices/index_quotes/all-indices.json',
  au: 'https://cdn.cboe.com/api/global/au_indices/index_quotes/all-indices.json',
}

/** Name each index from the published directory, and drop the caret from its symbol (`_with_index_names`). */
async function withIndexNames(rows: Row[], ctx: NativeCtx): Promise<Row[]> {
  if (rows.length === 0) return rows
  let names: Map<string, string>
  try {
    names = new Map((await getIndexRows(ctx)).filter((r) => typeof r.name === 'string' && r.name).map((r) => [String(r.index_symbol), String(r.name)]))
  } catch {
    return rows
  }
  return rows.map((row) => {
    const symbol = String(row.symbol ?? '').replaceAll('^', '')
    const name = names.get(symbol)
    return { ...row, symbol, ...(name ? { name } : {}) }
  })
}

export async function indexSnapshots(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const region = String(params.region || 'us')
  const url = REGION_URLS[region]
  if (!url) throw new Error(`region must be us, eu or au, got ${region}`)
  const body = await ctx.http.json<{ data?: Row[] } | Row[]>(url)
  const data = await withIndexNames(Array.isArray(body) ? body : (body.data ?? []), ctx)
  if (data.length === 0) throw new Error('Cboe returned no index snapshots')

  return data.map((raw) => {
    const out: Row = {}
    for (const [k, v] of Object.entries(raw)) {
      // Percents become fractions; zeros, empty strings and missing values are left out.
      const value = PERCENT_COLUMNS.includes(k) && typeof v === 'number' ? v / 100 : v
      if (value === 0 || value === '' || value === null || value === undefined || DROP_COLUMNS.includes(k)) continue
      if (k === 'name' && typeof value !== 'string') continue
      out[ALIASES[k] ?? k] = k === 'last_trade_time' && typeof value === 'string' ? isoDatetime(value) : value
    }
    return out
  })
}
