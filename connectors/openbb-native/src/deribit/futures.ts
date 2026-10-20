// derivatives/futures/{instruments,curve,historical,info}, provider deribit. Ported from
// openbb_deribit/models/futures_{instruments,curve,historical,info}.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { expirationDate, fromTimestamp, today } from './client.js'
import { getFuturesCurveByHoursAgo, getFuturesCurveSymbols, getInstruments, getOhlcData, getTickers, PERPETUAL_EXPIRATION, resolveSymbols } from './helpers.js'
import { tickerRow } from './market.js'
import { by, items, pyStr, shape } from './model.js'

const DAY_MS = 24 * 3600 * 1000
const INTERVAL_LOOKBACK: Record<string, number> = { '1m': 30, '3m': 60, '5m': 60, '10m': 90, '15m': 90, '30m': 90 }
const DEFAULT_LOOKBACK = 364
const INTERVALS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '3h', '6h', '12h', '1d']

/** derivatives/futures/instruments. */
export async function futuresInstruments(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await getInstruments(ctx, 'any', 'future')
  if (data.length === 0) throw new Error('Deribit lists no futures.')
  return [...data]
    .sort(by((d) => Number(d.expiration_timestamp || 0), (d) => pyStr(d.instrument_name)))
    .map((r) =>
      shape(r, { symbol: 'instrument_name' }, {
        // The model reads a number of milliseconds as a datetime; a perpetual carries a sentinel for no expiration.
        creation_timestamp: fromTimestamp,
        expiration_timestamp: (v) => (!v || Number(v) === PERPETUAL_EXPIRATION ? null : fromTimestamp(v)),
      }),
    )
}

/** derivatives/futures/curve. */
export async function futuresCurve(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The exchange serves no curve as of a date.
  if (params.date) throw new Error("Deribit serves no curve as of a date. Use 'hours_ago' instead.")
  const symbol = String(params.symbol ?? 'BTC').toUpperCase()
  const hoursAgo = items(params.hours_ago)

  const symbols = await getFuturesCurveSymbols(ctx, symbol)
  const data = await getTickers(ctx, symbols)
  for (const hour of hoursAgo.map((h) => Math.trunc(Number(h)))) data.push(...(await getFuturesCurveByHoursAgo(ctx, symbol, hour)))
  if (data.length === 0) throw new Error(`Deribit published no quote for the ${symbol} curve.`)

  const records: { symbol: string; expiration: string; price: number; last_price: unknown; hours_ago: number | null }[] = []
  for (const record of data) {
    const name = String(record.instrument_name ?? '')
    const code = name.includes('-') ? name.split('-')[1]! : ''
    const price = (record.mark_price as number | undefined) || (record.last_price as number | undefined)
    if (!name || price === undefined || price === null) continue
    records.push({
      symbol: name,
      expiration: code === 'PERPETUAL' ? today(ctx) : expirationDate(code),
      price,
      last_price: record.last_price,
      hours_ago: hoursAgo.length > 0 ? ((record.hours_ago as number | undefined) ?? null) : null,
    })
  }
  if (records.length === 0) throw new Error(`Deribit published no priced contract on the ${symbol} curve.`)
  return records.sort(by((d) => d.hours_ago || 0, (d) => d.expiration)).map((r) => shape(r))
}

/** derivatives/futures/historical. */
export async function futuresHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = String(params.interval ?? '1d')
  if (!INTERVALS.includes(interval)) throw new Error(`Input should be one of ${INTERVALS.map((i) => `'${i}'`).join(', ')}: interval=${interval}`)
  // A span the interval can be served over.
  const now = ctx.now().getTime()
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  const start = params.start_date ? String(params.start_date) : iso(now - (INTERVAL_LOOKBACK[interval] ?? DEFAULT_LOOKBACK) * DAY_MS)
  const end = params.end_date ? String(params.end_date) : iso(now + DAY_MS)

  const symbols = items(params.symbol, (s) => s.toUpperCase())
  const { resolved } = await resolveSymbols(ctx, params.symbol)
  const results: Row[] = []
  for (const symbol of resolved) results.push(...(await getOhlcData(ctx, symbol, start, end, interval)))
  if (results.length === 0) throw new Error(`Deribit published no candles over the span for ${symbols.join(', ')}.`)

  const single = symbols.length === 1
  return results.sort(by((d) => String(d.date), (d) => String(d.symbol))).map((record) => {
    const { symbol: _symbol, ...rest } = record
    return shape(single ? rest : record)
  })
}

/** derivatives/futures/info. */
export async function futuresInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { resolved } = await resolveSymbols(ctx, params.symbol)
  const data = await getTickers(ctx, resolved)
  if (data.length === 0) throw new Error(`Deribit published no quote for ${resolved.join(', ')}.`)
  const place = (d: Row): number => (resolved.includes(String(d.instrument_name)) ? resolved.indexOf(String(d.instrument_name)) : resolved.length)
  return [...data].sort((a, b) => place(a) - place(b)).map(tickerRow)
}
