// deribit/rates/{funding_history,funding_chart,apr_history}, provider deribit. Ported from
// openbb_deribit/models/{funding_rate_history,funding_chart,apr_history}.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fromDayNumber, fromTimestamp, gather, isList, isRecord, request, toTimestamp } from './client.js'
import { resolveSymbols } from './helpers.js'
import { asPercent, by, shape } from './model.js'

const DAY_MS = 24 * 3600 * 1000

/** deribit/rates/funding_history. */
export async function fundingHistory(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = ctx.now().getTime()
  const start = params.start_date ? toTimestamp(params.start_date) : now - 7 * DAY_MS
  const end = params.end_date ? toTimestamp(params.end_date) : now
  const { resolved } = await resolveSymbols(ctx, params.symbol ?? 'BTC-PERPETUAL')
  const results = await gather(ctx, resolved.map((symbol) => ['get_funding_rate_history', { instrument_name: symbol, start_timestamp: start, end_timestamp: end }]))
  const data: Row[] = resolved.flatMap((symbol, k) => (isList(results[k]) ? (results[k] as Row[]).map((record) => ({ symbol, ...record })) : []))
  if (data.length === 0) throw new Error(`Deribit published no funding over the span for ${resolved.join(', ')}.`)
  return data
    .sort(by((d) => Number(d.timestamp || 0), (d) => String(d.symbol)))
    .map((r) => shape(r, { date: 'timestamp' }, { date: fromTimestamp, interest_1h: asPercent, interest_8h: asPercent }))
}

/** deribit/rates/funding_chart. */
export async function fundingChart(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { resolved } = await resolveSymbols(ctx, params.symbol ?? 'BTC-PERPETUAL')
  const length = String(params.length ?? '8h')
  const results = await gather(ctx, resolved.map((symbol) => ['get_funding_chart_data', { instrument_name: symbol, length }]))
  const data: Row[] = resolved.flatMap((symbol, k) => {
    const result = results[k]
    return isRecord(result) ? ((result.data as Row[] | undefined) ?? []).map((record) => ({ symbol, current_interest: result.current_interest, ...record })) : []
  })
  if (data.length === 0) throw new Error(`Deribit published no funding over the span for ${resolved.join(', ')}.`)
  return data
    .sort(by((d) => Number(d.timestamp || 0), (d) => String(d.symbol)))
    .map((r) => shape(r, { date: 'timestamp' }, { date: fromTimestamp, interest_8h: asPercent, current_interest: asPercent }))
}

/** deribit/rates/apr_history. */
export async function aprHistory(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currency = String(params.currency ?? 'usde')
  const limit = params.limit === undefined ? 365 : Number(params.limit)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Input should be greater than or equal to 1: limit')
  const result = await request<{ data?: Row[] }>(ctx, 'get_apr_history', { currency: currency.toLowerCase(), limit })
  const data: Row[] = (result?.data ?? []).map((record) => ({ currency: currency.toUpperCase(), ...record }))
  if (data.length === 0) throw new Error(`Deribit published no yield history for ${currency.toUpperCase()}.`)
  return data.sort((a, b) => Number(a.day || 0) - Number(b.day || 0)).map((r) => shape(r, { date: 'day' }, { date: fromDayNumber }))
}
