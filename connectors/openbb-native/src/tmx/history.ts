// equity/price/historical, etf/historical, index/price/historical, currency/price/historical and
// derivatives/futures/historical, provider tmx. Ported from openbb_tmx/models/{equity_historical,index_historical,
// currency_historical,futures_historical}.py and utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// rows instead of DataFrames and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { COMPANY_PRICE_HISTORY, TIME_SERIES } from './gql.js'
import { applyAliases, cleanSymbol, compact, dateChunks, gql, inOrder, isoDay, listParam, mapLimit, normalizeSymbol, oneOf, optFloat, percent, strParam, TmxError, toZonedIso, truthy, withoutRouteDefaults, zonedEpoch } from './helpers.js'

const EARLIEST_SESSION = '1970-01-01'
const INTRADAY_EPOCH = '2022-04-12'
const NY = 'America/New_York'
const CHUNK_DAYS = 28
const CONCURRENCY = 6

type Adjustment = 'splits_only' | 'unadjusted' | 'splits_and_dividends'
type Interval = 'day' | 'week' | 'month' | number

/** `validate_interval` of the TMX equity query. */
function parseInterval(raw: unknown): Interval {
  if (raw === undefined || raw === null || raw === '' || raw === 'day') return 'day'
  const v = String(raw)
  if (['1M', '1mo', 'month'].includes(v)) return 'month'
  if (v.includes('m')) return Number.parseInt(v.replace('m', ''), 10)
  if (v.includes('h')) return Number.parseInt(v.replace('h', ''), 10) * 60
  if (v === '1d') return 'day'
  if (['1W', '1w', 'week'].includes(v)) return 'week'
  if (/^\d+$/.test(v)) return Number(v)
  throw new TmxError(`Invalid interval: ${v}`)
}

/** `get_daily_price_history`: daily bars from `getCompanyPriceHistory`, four weeks per request, oldest first. */
async function dailyPriceHistory(ctx: NativeCtx, rawSymbol: string, start: string | undefined, end: string | undefined, adjustment: Adjustment): Promise<Row[]> {
  const symbol = cleanSymbol(rawSymbol)
  const from = start ?? EARLIEST_SESSION
  const to = end ?? isoDay(ctx.now())
  const chunks = dateChunks(from, to, CHUNK_DAYS)
  const pages = await mapLimit(chunks, CONCURRENCY, async ([s, e]) => {
    const variables: Row = { symbol, start: s, end: e, adjusted: adjustment !== 'unadjusted', unadjusted: adjustment === 'unadjusted' }
    if (adjustment === 'splits_only') variables.adjustmentType = 'SO'
    const data = await gql<Row>(ctx, 'getCompanyPriceHistory', COMPANY_PRICE_HISTORY, variables, symbol)
    return (data?.getCompanyPriceHistory as Row[] | undefined) ?? []
  })
  const rows = pages.flat().filter((d) => d.openPrice !== null && d.openPrice !== undefined)
  return rows.sort((a, b) => cmp(String(a.datetime), String(b.datetime)))
}

/** `get_weekly_or_monthly_price_history`. */
async function weeklyOrMonthly(ctx: NativeCtx, rawSymbol: string, start: string | undefined, end: string | undefined, interval: 'week' | 'month'): Promise<Row[]> {
  const symbol = cleanSymbol(rawSymbol)
  const data = await gql<Row>(ctx, 'getTimeSeriesData', TIME_SERIES, { symbol, freq: interval, start: start ?? EARLIEST_SESSION, end: end ?? isoDay(ctx.now()) }, symbol)
  const rows = (data?.getTimeSeriesData as Row[] | undefined) ?? []
  return rows.sort((a, b) => cmp(String(a.dateTime), String(b.dateTime)))
}

/** `get_intraday_price_history`: minute bars from `getTimeSeriesData`, four weeks per request. */
async function intradayPriceHistory(ctx: NativeCtx, rawSymbol: string, start: string | undefined, end: string | undefined, interval: number): Promise<Row[]> {
  const symbol = normalizeSymbol(rawSymbol)
  const from = start && start > INTRADAY_EPOCH ? start : INTRADAY_EPOCH
  let to = end ?? isoDay(ctx.now())
  if (to < INTRADAY_EPOCH) to = isoDay(ctx.now())
  const chunks = dateChunks(from, to, CHUNK_DAYS)
  const pages = await mapLimit(chunks, CONCURRENCY, async ([s, e]) => {
    const data = await gql<Row>(ctx, 'getTimeSeriesData', TIME_SERIES, { symbol, interval, startDateTime: zonedEpoch(s, 9, 30, NY), endDateTime: zonedEpoch(e, 16, 0, NY) }, symbol)
    return (data?.getTimeSeriesData as Row[] | undefined) ?? []
  })
  const rows = pages.flat()
  return rows.length > 0 && 'dateTime' in rows[0]! ? rows.sort((a, b) => cmp(String(a.dateTime), String(b.dateTime))) : rows
}

/** `get_timeseries_history`: daily, weekly or monthly bars for any quotable instrument, oldest first. */
async function timeseriesHistory(ctx: NativeCtx, rawSymbol: string, start: string | undefined, end: string | undefined, interval: string): Promise<Row[]> {
  const symbol = normalizeSymbol(rawSymbol)
  const data = await gql<Row>(ctx, 'getTimeSeriesData', TIME_SERIES, { symbol, freq: interval, start: start ?? EARLIEST_SESSION, end: end ?? isoDay(ctx.now()) }, symbol)
  const rows = (data?.getTimeSeriesData as Row[] | undefined) ?? []
  return rows.sort((a, b) => cmp(String(a.dateTime), String(b.dateTime)))
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Pandas `purge_nulls`: the source's placeholders are missing values. */
const purged = (v: unknown): unknown => (v === 'N/A' || v === '-' || v === '' ? null : v)

const HISTORICAL_ALIASES: Record<string, string> = {
  date: 'datetime',
  open: 'openPrice',
  close: 'closePrice',
  transactions_value: 'tradeValue',
  transactions: 'numberOfTrade',
  change_percent: 'changePercent',
}

/** equity/price/historical and etf/historical. */
export async function equityHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params).map((s) => s.toUpperCase())
  const start = strParam(params, 'start_date')
  const end = strParam(params, 'end_date')
  const interval = parseInterval(params.interval)
  const adjustment = (strParam(params, 'adjustment') ?? 'splits_only') as Adjustment

  const perSymbol = await Promise.all(
    symbols.map(async (symbol) => {
      let data: Row[]
      if (interval === 'day') data = await dailyPriceHistory(ctx, symbol, start, end, adjustment)
      else if (interval === 'week' || interval === 'month') data = await weeklyOrMonthly(ctx, symbol, start, end, interval)
      else data = await intradayPriceHistory(ctx, symbol, start, end, interval)
      return data.map((d) => ({ ...d, symbol }))
    }),
  )
  const data = perSymbol.flat()
  if (data.length === 0) return []

  let rows = data.map((d) => {
    const row: Row = {}
    for (const [k, v] of Object.entries(d)) row[k === 'dateTime' ? 'datetime' : k] = v
    const when = String(row.datetime)
    if (interval === 'day') row.datetime = when.slice(0, 10)
    else if (interval === 'week' || interval === 'month') row.datetime = new Date(when).toISOString().slice(0, 10)
    else {
      // to_datetime(utc=True).dt.strftime("%Y-%m-%d %H:%M:%S%z")
      const iso = new Date(when).toISOString()
      row.datetime = `${iso.slice(0, 10)} ${iso.slice(11, 19)}+0000`
    }
    if ('changePercent' in row && row.changePercent !== null && row.changePercent !== undefined) row.changePercent = Number(row.changePercent) / 100
    if (interval === 'week' && (row.open === null || row.open === undefined)) row.open = 0
    return row
  })
  if (symbols.length > 1) {
    // set_index(["datetime", "symbol"]).sort_index()
    rows = rows.sort((a, b) => cmp(String(a.datetime), String(b.datetime)) || cmp(String(a.symbol), String(b.symbol)))
  } else rows = rows.map(({ symbol: _s, ...rest }) => rest)

  return rows.map((raw) => {
    const row = applyAliases(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, purged(v)])), HISTORICAL_ALIASES)
    // date_validate: a day is midnight, an intraday bar the New York wall time.
    const when = String(row.date)
    row.date = when.length > 10 ? toZonedIso(Date.parse(when.replace(' ', 'T').replace('+0000', 'Z')), NY) : `${when}T00:00:00`
    return compact(row)
  })
}

const INDEX_ALIASES: Record<string, string> = {
  date: 'datetime',
  open: 'openPrice',
  close: 'closePrice',
  change_percent: 'changePercent',
  trade_value: 'tradeValue',
  transactions: 'numberOfTrade',
}

/** index/price/historical. */
export async function indexHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol).toUpperCase()
  const data = await dailyPriceHistory(ctx, symbol, strParam(params, 'start_date'), strParam(params, 'end_date'), 'splits_only')
  if (data.length === 0) return []
  return data
    .sort((a, b) => cmp(String(a.datetime), String(b.datetime)))
    .map((row) => {
      const clean = Object.fromEntries(Object.entries({ symbol, ...row }).map(([k, v]) => [k, v === 'N/A' || v === '' || v === '-' || v === 'null' ? null : v]))
      const out = applyAliases(clean, INDEX_ALIASES)
      out.change_percent = percent(out.change_percent) ?? null
      return compact(out)
    })
}

/** currency/price/historical. */
export async function currencyHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const interval = strParam(params, 'interval') ?? 'day'
  const results = await inOrder(listParam(params), async (raw) => {
    let symbol = raw.replaceAll('-', '').trim().toUpperCase()
    symbol = symbol.startsWith('$') ? symbol : `$${symbol}`
    const bars = await timeseriesHistory(ctx, symbol, strParam(params, 'start_date'), strParam(params, 'end_date'), interval)
    return bars.map((bar) => ({ symbol: symbol.replace(/^\$+/, ''), ...bar }))
  })
  if (results.length === 0) return []
  return results
    .sort((a, b) => cmp(String(a.dateTime ?? ''), String(b.dateTime ?? '')))
    .map((d) =>
      compact({
        date: zuluOut(d.dateTime),
        symbol: d.symbol,
        open: optFloat(d.open),
        high: optFloat(d.high),
        low: optFloat(d.low),
        close: optFloat(d.close),
        volume: truthy(d.volume) ? optFloat(d.volume) : undefined,
      }),
    )
}

/** derivatives/futures/historical. */
export async function futuresHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The route's default interval is 1d (another provider's); OpenBB drops it, so TMX's own `day` applies.
  const interval = oneOf(withoutRouteDefaults(params, { interval: '1d' }), 'interval', ['day', 'week', 'month'] as const, 'day')
  const results = await inOrder(listParam(params), async (raw) => {
    let symbol = raw.trim().toUpperCase()
    symbol = ['/', '^', '$'].includes(symbol.slice(0, 1)) ? symbol : `/${symbol}`
    const bars = await timeseriesHistory(ctx, symbol, strParam(params, 'start_date'), strParam(params, 'end_date'), interval)
    return bars.map((bar) => ({ symbol: symbol.replace(/^\/+/, ''), ...bar }))
  })
  if (results.length === 0) return []
  return results
    .sort((a, b) => cmp(String(a.dateTime ?? ''), String(b.dateTime ?? '')))
    .map((d) =>
      compact({
        date: zuluOut(d.dateTime),
        symbol: d.symbol,
        open: optFloat(d.open),
        high: optFloat(d.high),
        low: optFloat(d.low),
        close: optFloat(d.close),
        volume: optFloat(d.volume),
      }),
    )
}

/** An ISO timestamp as pydantic writes it: a zero offset is `Z`. */
function zuluOut(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined
  const s = String(v)
  return s.replace(/\+00:00$/, 'Z')
}
