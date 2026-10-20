// deribit/volatility/{index,realized}, provider deribit. Ported from
// openbb_deribit/models/{volatility_index,historical_volatility}.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fromTimestamp, gather, isList, isRecord, toTimestamp } from './client.js'
import { REALIZED_VOLATILITY_CURRENCIES, VOLATILITY_INDEX_CURRENCIES, VOLATILITY_RESOLUTION_MAP } from './helpers.js'
import { by, items, shape } from './model.js'

const DAY_MS = 24 * 3600 * 1000

/** The query validator: one currency or several, each one the exchange publishes the series for. */
function listed(value: unknown, fallback: string, allowed: string[], what: string): string[] {
  const chosen = items(value ?? fallback, (s) => s.toUpperCase())
  const unlisted = chosen.filter((c) => !allowed.includes(c))
  if (unlisted.length > 0) {
    throw new Error(`Deribit publishes no ${what} for [${unlisted.map((c) => `'${c}'`).join(', ')}]. It publishes [${allowed.map((c) => `'${c}'`).join(', ')}].`)
  }
  return chosen
}

/** deribit/volatility/realized. */
export async function realized(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currencies = listed(params.currency, 'BTC', REALIZED_VOLATILITY_CURRENCIES, 'realized volatility')
  const results = await gather(ctx, currencies.map((currency) => ['get_historical_volatility', { currency }]))
  const data: Row[] = currencies.flatMap((currency, k) => (isList(results[k]) ? (results[k] as [number, number][]).map((point) => ({ date: point[0], currency, volatility: point[1] })) : []))
  if (data.length === 0) throw new Error(`Deribit published no realized volatility for ${currencies.join(', ')}.`)
  return data.sort(by((d) => d.date, (d) => d.currency)).map((r) => shape(r, {}, { date: fromTimestamp }))
}

/** deribit/volatility/index. */
export async function volatilityIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currencies = listed(params.currency, 'BTC', VOLATILITY_INDEX_CURRENCIES, 'volatility index')
  const now = ctx.now().getTime()
  const start = params.start_date ? toTimestamp(params.start_date) : now - 30 * DAY_MS
  const end = params.end_date ? toTimestamp(params.end_date) : now
  const resolution = VOLATILITY_RESOLUTION_MAP[String(params.interval ?? '1d')] ?? '1D'
  const results = await gather(ctx, currencies.map((currency) => ['get_volatility_index_data', { currency, start_timestamp: start, end_timestamp: end, resolution }]))
  const data: Row[] = currencies.flatMap((currency, k) => {
    const result = results[k]
    return isRecord(result) ? ((result.data as number[][] | undefined) ?? []).map((c) => ({ date: c[0], currency, open: c[1], high: c[2], low: c[3], close: c[4] })) : []
  })
  if (data.length === 0) throw new Error(`Deribit published no volatility index candles for ${currencies.join(', ')} over the span.`)
  return data.sort(by((d) => d.date, (d) => d.currency)).map((r) => shape(r, {}, { date: fromTimestamp }))
}
