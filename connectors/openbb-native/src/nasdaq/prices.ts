// equity/price/historical, crypto/price/historical, etf/historical, index/price/historical, provider nasdaq. Ported from
// openbb_nasdaq/models/{equity_historical,crypto_historical,etf_historical,index_historical}.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models.
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { EmptyDataError, compact, gatherHistoricalPrices, getNasdaqData, listParam, toNumber, type Dict } from './helpers.js'

const symbolList = (params: NativeParams): string => listParam(params, 'symbol').join(',')
const startOf = (params: NativeParams) => params.start_date as string | undefined
const endOf = (params: NativeParams) => params.end_date as string | undefined

/** An empty history is an EmptyDataError in OpenBB: no rows. */
async function history(ctx: NativeCtx, params: NativeParams, assetClass: string | null): Promise<Row[]> {
  try {
    return (await gatherHistoricalPrices(ctx, symbolList(params).toUpperCase(), assetClass, startOf(params), endOf(params))).map(compact)
  } catch (err) {
    if (err instanceof EmptyDataError) return []
    throw err
  }
}

export const equityHistorical = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => history(ctx, params, 'stocks')
export const cryptoHistorical = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => history(ctx, params, 'crypto')
/** The asset class of an ETF symbol is resolved from the listing directory, then probed. */
export const etfHistorical = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => history(ctx, params, null)

/** A chart timestamp such as '7/24/2026 9:30:58 AM' (US/Eastern wall time) as a naive ISO datetime. */
function parseChartTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(value.trim())
  if (!m) return null
  let hour = +m[4]!
  if (hour < 1 || hour > 12) return null
  hour = (hour % 12) + (m[7] === 'PM' ? 12 : 0)
  const p = (n: string | number) => String(n).padStart(2, '0')
  return `${m[3]}-${p(m[1]!)}-${p(m[2]!)}T${p(hour)}:${m[5]}:${m[6]}`
}

export async function indexHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = String(params.interval ?? '1d')
  if (interval !== '1m' && interval !== '1d') throw new NativeUnsupported(`nasdaq index history has no ${interval} interval`)
  if (interval === '1d') return history(ctx, params, 'index')

  // One-minute data: the current session's chart for each index.
  const symbols = symbolList(params)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const query = symbols.map((s) => `symbol=${s}&chartFor=${s}`).join('&')
  const data = await getNasdaqData(ctx, `quote/indices?${query}`)
  const results: Row[] = []
  for (const row of (Array.isArray(data) ? data : []) as Dict[]) {
    for (const point of (row.indexCharts ?? []) as Dict[]) {
      const stamped = parseChartTime((point.z ?? {}).dateTime)
      if (stamped === null) continue
      results.push(compact({ date: stamped, symbol: row.symbol, close: toNumber(point.y) }))
    }
  }
  if (!results.length) return [] // EmptyDataError
  const sym = (r: Row) => (r.symbol as string | undefined) ?? ''
  return results.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : sym(a) < sym(b) ? -1 : sym(a) > sym(b) ? 1 : 0))
}
