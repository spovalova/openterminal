// Ported from openbb_deribit/utils/helpers.py and constants.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the
// instrument and currency lists are held with ctx.cache for an hour (OpenBB keeps them in an on-disk response cache),
// and the windows of candles are counted without pandas.
import type { NativeCtx, Row } from '../types.js'
import { expirationDate, fromTimestamp, gather, isRecord, request, toTimestamp } from './client.js'
import { items } from './model.js'

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

export const UNDERLYING_CURRENCIES = ['BTC', 'ETH']
export const OPTION_KINDS = ['option', 'option_combo']
export const ORDER_BOOK_DEPTHS = [1, 5, 10, 20, 50, 100, 1000, 10000]
export const MAX_TRADE_COUNT = 1000
export const MAX_SETTLEMENT_COUNT = 1000
export const BLOCK_RFQ_MIN_COUNT = 10
export const BLOCK_RFQ_MAX_COUNT = 50
export const ROUTED_SPOT_ERROR = 'not_supported_for_coinbase_routed_spot'
export const VOLATILITY_INDEX_CURRENCIES = ['BTC', 'ETH']
export const REALIZED_VOLATILITY_CURRENCIES = ['BTC', 'ETH', 'EURR']
export const PERPETUAL_EXPIRATION = 32503708800000

/** Candle interval → the resolution the API takes (minutes, or `1D`). */
export const INTERVAL_MAP: Record<string, string> = { '1m': '1', '3m': '3', '5m': '5', '10m': '10', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '3h': '180', '6h': '360', '12h': '720', '1d': '1D' }
export const VOLATILITY_RESOLUTION_MAP: Record<string, string> = { '1m': '60', '1h': '3600', '12h': '43200', '1d': '1D' }

const MAX_CHART_WINDOWS = 15
const CHART_WINDOW_SIZE = 5000
const CURVE_LOOKBACK_HOURS = 24

/** `normalize_currency`: the exchange's spelling, the wildcard left alone. */
export const normalizeCurrency = (currency: string): string => (['any', 'all'].includes(currency.toLowerCase()) ? 'any' : currency.toUpperCase())

/** `reject_options_by_settlement`: options are listed by their underlying, not by a currency that only settles them. */
export function rejectOptionsBySettlement(currency: string, kind: string | undefined): void {
  if (UNDERLYING_CURRENCIES.includes(currency.toUpperCase()) || !kind || !OPTION_KINDS.includes(kind)) return
  throw new Error(
    `${currency.toUpperCase()} settles options, it is not an underlying, so there are no options on it to list. Ask for options by the underlying they are written on, such as BTC_USDC or SOL_USDC, using the symbol parameter.`,
  )
}

export function getCurrencies(ctx: NativeCtx): Promise<Row[]> {
  return ctx.cache('deribit:get_currencies', DAY_MS, () => request<Row[]>(ctx, 'get_currencies'))
}

/** `get_instruments`: the instruments of one currency (or `any`), optionally of one kind. */
export function getInstruments(ctx: NativeCtx, currency = 'any', kind?: string, expired = false): Promise<Row[]> {
  return ctx.cache(`deribit:get_instruments:${currency}:${kind ?? ''}:${expired}`, HOUR_MS, () => request<Row[]>(ctx, 'get_instruments', { currency: normalizeCurrency(currency), kind, expired }))
}

/** `flatten_ticker`: a ticker with its nested statistics and greeks at the top level. */
export function flattenTicker(data: Row): Row {
  const { stats, greeks, ...rest } = data
  return { ...rest, ...((stats as Row | null | undefined) ?? {}), ...((greeks as Row | null | undefined) ?? {}) }
}

/** `get_tickers`: the quotes of many instruments, skipping the ones that fail. */
export async function getTickers(ctx: NativeCtx, symbols: string[]): Promise<Row[]> {
  const results = await gather(ctx, symbols.map((s) => ['ticker', { instrument_name: s }]))
  return results.filter((r): r is Row => isRecord(r) && Object.keys(r).length > 0).map(flattenTicker)
}

export async function getIndexNames(ctx: NativeCtx, extended = false): Promise<unknown[]> {
  return request<unknown[]>(ctx, 'get_index_price_names', { extended })
}

export async function getExpirations(ctx: NativeCtx, currency = 'any', kind = 'any', currencyPair?: string): Promise<any> {
  return ctx.cache(`deribit:get_expirations:${currency}:${kind}:${currencyPair ?? ''}`, HOUR_MS, () => request(ctx, 'get_expirations', { currency, kind, currency_pair: currencyPair }))
}

/** Instruments grouped by the root of their name. */
function roots(instruments: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>()
  for (const instrument of instruments) {
    const root = String(instrument.instrument_name ?? '').split('-')[0]!
    if (root) grouped.set(root, [...(grouped.get(root) ?? []), instrument])
  }
  return grouped
}

/** Every underlying with dated futures (more than one besides the perpetual). */
export async function getFuturesRoots(ctx: NativeCtx): Promise<string[]> {
  const grouped = roots(await getInstruments(ctx, 'any', 'future'))
  return [...grouped].filter(([, listed]) => listed.filter((d) => d.settlement_period !== 'perpetual').length > 1).map(([root]) => root).sort()
}

/** `get_options_symbols`: the option contracts of one underlying, keyed by expiration. */
export async function getOptionsSymbols(ctx: NativeCtx, symbol = 'BTC'): Promise<Map<string, string[]>> {
  const root = symbol.toUpperCase()
  const grouped = roots(await getInstruments(ctx, 'any', 'option'))
  const listed = grouped.get(root)
  if (!listed || listed.length === 0) throw new Error(`Deribit lists no options on ${root}. Underlyings with listed options are: ${[...grouped.keys()].sort().join(', ')}`)
  const symbols = listed.map((d) => String(d.instrument_name)).filter((s) => s.endsWith('-C') || s.endsWith('-P')).sort()
  const byExpiration = new Map<string, string[]>()
  for (const contract of symbols) {
    const expiration = expirationDate(contract.split('-')[1]!)
    byExpiration.set(expiration, [...(byExpiration.get(expiration) ?? []), contract])
  }
  return new Map([...byExpiration].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** `get_futures_curve_symbols`: the dated futures of one underlying, nearest expiration first. */
export async function getFuturesCurveSymbols(ctx: NativeCtx, symbol = 'BTC'): Promise<string[]> {
  const root = symbol.toUpperCase()
  const grouped = roots(await getInstruments(ctx, 'any', 'future'))
  const listed = (grouped.get(root) ?? []).filter((d) => d.settlement_period !== 'perpetual' && String(d.instrument_name ?? '').split('-')[0] === root)
  if (listed.length === 0) {
    throw new Error(`Deribit lists no futures curve for ${root}. Underlyings with a curve are: ${(await getFuturesRoots(ctx)).join(', ')}`)
  }
  return [...listed].sort((a, b) => Number(a.expiration_timestamp || 0) - Number(b.expiration_timestamp || 0)).map((d) => String(d.instrument_name))
}

/** `get_perpetual_symbols`: every perpetual, keyed by its shortened root (`BTCUSDC` for `BTC_USDC-PERPETUAL`). */
export async function getPerpetualSymbols(ctx: NativeCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const d of await getInstruments(ctx, 'any', 'future')) {
    if (d.settlement_period === 'perpetual') out.set(String(d.instrument_name).split('-')[0]!.replace(/_/g, ''), String(d.instrument_name))
  }
  return out
}

/** The instrument names a comma-separated `symbol` refers to, a perpetual's short root resolved. */
export async function resolveSymbols(ctx: NativeCtx, symbol: unknown): Promise<{ symbols: string[]; resolved: string[] }> {
  const symbols = items(symbol, (s) => s.toUpperCase())
  const perpetuals = await getPerpetualSymbols(ctx)
  return { symbols, resolved: symbols.map((s) => perpetuals.get(s) ?? s) }
}

/** The step between two candles, in milliseconds. */
const stepMs = (resolution: string): number => (resolution === '1D' ? DAY_MS : Number(resolution) * 60_000)

/** `_chart_windows`: a span cut into windows of at most one page of candles each (each ends on the next one's first). */
export function chartWindows(start: number, end: number, resolution: string, window = CHART_WINDOW_SIZE): [number, number][] {
  const step = stepMs(resolution)
  // pandas.date_range(start, end, freq): start, start + step, … up to end.
  const count = end >= start ? Math.floor((end - start) / step) + 1 : 0
  if (count <= 1) return [[start, end]]
  const stamp = (i: number): number => start + i * step
  const windows: [number, number][] = []
  for (let index = 0; index < count; index += window) windows.push([stamp(index), stamp(Math.min(index + window, count - 1))])
  return windows
}

/** `get_ohlc_data`: the candles of one instrument over a span, oldest first. */
export async function getOhlcData(ctx: NativeCtx, symbol: string, startDate: unknown, endDate: unknown, interval = '1d'): Promise<Row[]> {
  const resolution = INTERVAL_MAP[interval] ?? interval
  const created = new Map((await getInstruments(ctx, 'any')).map((d) => [String(d.instrument_name), d.creation_timestamp]))
  if (!created.has(symbol)) throw new Error(`Deribit lists no instrument named ${symbol}.`)

  const start = Math.max(toTimestamp(startDate), Number(created.get(symbol) || 0))
  const end = toTimestamp(endDate)
  const windows = chartWindows(start, end, resolution)
  if (windows.length > MAX_CHART_WINDOWS) {
    throw new Error(`The span covers ${windows.length} pages of ${interval} candles, and Deribit serves at most ${MAX_CHART_WINDOWS} at a time. Narrow the dates, or widen the interval.`)
  }

  const results = await gather(ctx, windows.map(([s, e]) => ['get_tradingview_chart_data', { instrument_name: symbol, start_timestamp: s, end_timestamp: e, resolution }]))
  const records = new Map<number, Row>()
  for (const result of results) {
    if (!isRecord(result) || !Array.isArray(result.ticks) || result.ticks.length === 0) continue
    result.ticks.forEach((tick: number, i: number) => {
      records.set(tick, { date: tick, symbol, open: result.open[i], high: result.high[i], low: result.low[i], close: result.close[i], volume: result.volume[i], volume_notional: result.cost[i] })
    })
  }
  if (records.size === 0) throw new Error(`Deribit published no ${interval} candles for ${symbol}.`)
  return [...records.keys()].sort((a, b) => a - b).map((tick) => {
    const record = records.get(tick)!
    // Daily candles carry a date, the others a datetime.
    return { ...record, date: resolution === '1D' ? fromTimestamp(tick)!.slice(0, 10) : fromTimestamp(tick) }
  })
}

/** `get_futures_curve_by_hours_ago`: the curve of one underlying as it stood some hours ago. */
export async function getFuturesCurveByHoursAgo(ctx: NativeCtx, symbol: string, hours: number): Promise<Row[]> {
  const symbols = await getFuturesCurveSymbols(ctx, symbol)
  const now = Math.floor(ctx.now().getTime() / HOUR_MS) * HOUR_MS
  const target = now - hours * HOUR_MS
  const start = now - (hours + CURVE_LOOKBACK_HOURS) * HOUR_MS
  const results = await gather(ctx, symbols.map((contract) => ['get_tradingview_chart_data', { instrument_name: contract, start_timestamp: start, end_timestamp: target, resolution: '60' }]))
  const curve: Row[] = []
  symbols.forEach((contract, k) => {
    const result = results[k]
    if (!isRecord(result) || !Array.isArray(result.ticks) || result.ticks.length === 0) return
    const ticks: number[] = result.ticks
    let index = 0
    ticks.forEach((tick, position) => {
      if (Math.abs(tick - target) < Math.abs(ticks[index]! - target)) index = position
    })
    curve.push({ instrument_name: contract, hours_ago: hours, last_price: result.close[index] })
  })
  return curve
}
