// equity/price/quote, provider cboe. Ported from openbb_cboe/models/equity_quote.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cboeSymbol, getCompanyDirectory, getIndexDirectory } from './helpers.js'

const PERCENT_COLUMNS = ['price_change_percent', 'iv30', 'iv30_change', 'iv30_change_percent', 'iv30_annual_high', 'iv30_annual_low', 'iv60_annual_high', 'iv60_annual_low', 'iv90_annual_high', 'iv90_annual_low', 'hv30_annual_high', 'hv30_annual_low', 'hv60_annual_high', 'hv60_annual_low', 'hv90_annual_high', 'hv90_annual_low']

/** Cboe field → OpenBB field (`__alias_dict__`). */
const ALIASES: Record<string, string> = {
  last_trade_time: 'last_timestamp',
  prev_day_close: 'prev_close',
  security_type: 'asset_type',
  current_price: 'last_price',
  annual_high: 'year_high',
  annual_low: 'year_low',
  tick: 'last_tick',
  price_change: 'change',
  price_change_percent: 'change_percent',
}

const QUOTES = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/'
const HISTORY = 'https://cdn.cboe.com/api/global/delayed_quotes/historical_data/'
const EU_QUOTES = 'https://cdn.cboe.com/api/global/european_indices/index_quotes/'

function symbolsOf(params: NativeParams): string[] {
  const v = params.symbol
  const list = Array.isArray(v) ? v : String(v ?? '').split(',')
  return list.map((s) => s.trim().toUpperCase()).filter(Boolean)
}

export async function equityQuote(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const [companies, indexes] = await Promise.all([getCompanyDirectory(ctx), getIndexDirectory(ctx)])
  const isEu = (s: string) => indexes.get(s)?.source === 'eu_proprietary_index'

  // Quotes and the implied-volatility history, symbol by symbol; a symbol Cboe does not know is left out.
  const quotes = await Promise.all(
    symbols.map(async (symbol) => {
      const url = isEu(symbol) ? `${EU_QUOTES}${symbol.replace('^', '')}.json` : `${QUOTES}${cboeSymbol(symbol, indexes)}.json`
      try {
        const body = await ctx.http.json<{ data: Row }>(url)
        return body.data
      } catch {
        return undefined
      }
    }),
  )
  const history = await Promise.all(
    symbols.map(async (symbol) => {
      if (isEu(symbol)) return undefined
      try {
        return (await ctx.http.json<{ data: Row }>(`${HISTORY}${cboeSymbol(symbol, indexes)}.json`)).data
      } catch {
        return undefined
      }
    }),
  )

  // concat([quotes, iv], axis=1) on the symbol, then names from the directories.
  const bySymbol = new Map<string, Row>()
  const keyOf = (s: unknown) => String(s ?? '').replace('^', '').split('-')[0]!
  for (const q of quotes) {
    if (!q) continue
    const { seqno: _s, exchange_id: _e, index: _i, ...rest } = q
    const symbol = keyOf(rest.symbol)
    bySymbol.set(symbol, { ...rest, symbol })
  }
  for (const h of history) {
    if (!h) continue
    const symbol = keyOf(h.symbol)
    bySymbol.set(symbol, { ...(bySymbol.get(symbol) ?? {}), ...h, symbol })
  }
  if (bySymbol.size === 0) throw new Error(`Cboe has no quote for ${symbols.join(', ')}`)
  for (const [symbol, row] of bySymbol) {
    // OpenBB assigns from the company, index and EU directories in turn, so the last one listing the symbol wins.
    const name = indexes.get(symbol)?.name ?? companies.get(symbol)?.name
    if (name !== undefined) row.name = name
  }

  // transform_data: zeros become missing, percents become fractions, then OpenBB's field names.
  return [...bySymbol.values()].map((raw) => {
    const out: Row = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v === 0 || v === null || v === undefined || v === '') continue
      const value = PERCENT_COLUMNS.includes(k) && typeof v === 'number' ? v / 100 : v
      out[ALIASES[k] ?? k] = value
    }
    return out
  })
}
