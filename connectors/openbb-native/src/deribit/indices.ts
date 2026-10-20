// deribit/index/{price,historical,delivery_prices}, provider deribit. Ported from
// openbb_deribit/models/{index_price,index_historical,delivery_prices}.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fromTimestamp, gather, isList, isRecord } from './client.js'
import { by, items, shape } from './model.js'

/** deribit/index/price. */
export async function indexPrice(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const names = items(params.index_name ?? 'btc_usd', (s) => s.toLowerCase())
  const results = await gather(ctx, names.map((name) => ['get_index_price', { index_name: name }]))
  const data: Row[] = names.flatMap((name, k) => (isRecord(results[k]) && Object.keys(results[k] as Row).length > 0 ? [{ index_name: name, ...(results[k] as Row) }] : []))
  if (data.length === 0) throw new Error(`Deribit published no level for ${names.join(', ')}.`)
  return data.map((r) => shape(r))
}

/** deribit/index/historical. */
export async function indexHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const names = items(params.index_name ?? 'btc_usd', (s) => s.toLowerCase())
  const span = String(params.span ?? '1d')
  const results = await gather(ctx, names.map((name) => ['get_index_chart_data', { index_name: name, range: span }]))
  const data: Row[] = names.flatMap((name, k) => (isList(results[k]) ? (results[k] as [number, number][]).map((point) => ({ date: point[0], index_name: name, price: point[1] })) : []))
  if (data.length === 0) throw new Error(`Deribit published no series for ${names.join(', ')}.`)
  return data.sort(by((d) => d.date, (d) => d.index_name)).map((r) => shape(r, {}, { date: fromTimestamp }))
}

/** deribit/index/delivery_prices. */
export async function deliveryPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const names = items(params.index_name ?? 'btc_usd', (s) => s.toLowerCase())
  const limit = params.limit === undefined ? 100 : Number(params.limit)
  const offset = params.offset === undefined ? 0 : Number(params.offset)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Input should be greater than or equal to 1: limit')
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Input should be greater than or equal to 0: offset')
  const results = await gather(ctx, names.map((name) => ['get_delivery_prices', { index_name: name, count: limit, offset }]))
  const data: Row[] = names.flatMap((name, k) => (isRecord(results[k]) ? (((results[k] as Row).data as Row[] | undefined) ?? []).map((record) => ({ index_name: name, ...record })) : []))
  if (data.length === 0) throw new Error(`Deribit published no delivery prices for ${names.join(', ')}.`)
  return data.sort(by((d) => String(d.date), (d) => String(d.index_name))).map((r) => shape(r))
}
