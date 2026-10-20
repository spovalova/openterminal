// Ported from openbb_cboe/utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: directories are memoised
// through ctx.cache instead of an on-disk aiohttp cache, and only the parts the ported routes use are here.
import { parseCsvRecords } from '../lib/csv.js'
import type { NativeCtx } from '../types.js'

export const TICKER_EXCEPTIONS = ['NDX', 'RUT']
const DAY_MS = 24 * 3600 * 1000

export type CompanyListing = { symbol: string; name: string; dpm_name: string; post_station: string }

/** The US company directory for Cboe options, by symbol (`get_company_directory`). */
export function getCompanyDirectory(ctx: NativeCtx): Promise<Map<string, CompanyListing>> {
  return ctx.cache('cboe:company_directory', DAY_MS, async () => {
    const csv = await ctx.http.text('https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv')
    const out = new Map<string, CompanyListing>()
    for (const r of parseCsvRecords(csv)) {
      const symbol = r['Stock Symbol'] ?? ''
      out.set(symbol, { symbol, name: r['Company Name'] ?? '', dpm_name: r['DPM Name'] ?? '', post_station: r['Post/Station'] ?? '' })
    }
    return out
  })
}

export type IndexListing = { index_symbol: string; name: string; source: string; [key: string]: unknown }

/**
 * Cboe's US and European index definitions, without the Morningstar-sourced rows (`get_index_directory`, US and EU
 * part). OpenBB also merges the Australian directory and the Global Indices feed; routes that need those columns
 * port them here.
 */
export function getIndexDirectory(ctx: NativeCtx): Promise<Map<string, IndexListing>> {
  return ctx.cache('cboe:index_directory', DAY_MS, async () => {
    const all = await ctx.http.json<Record<string, unknown>[]>('https://cdn.cboe.com/api/global/us_indices/definitions/all_indices.json')
    const out = new Map<string, IndexListing>()
    for (const r of all) {
      if (r.source === 'morningstar') continue
      const { featured: _f, featured_order: _o, display: _d, ...rest } = r
      out.set(String(r.index_symbol), rest as IndexListing)
    }
    return out
  })
}

/** Cboe's delayed-quote endpoints prefix index symbols with an underscore. */
export function cboeSymbol(symbol: string, indexes: Map<string, IndexListing>): string {
  const s = symbol.replace('^', '')
  return indexes.has(s) || TICKER_EXCEPTIONS.includes(s) ? `_${s}` : s
}
