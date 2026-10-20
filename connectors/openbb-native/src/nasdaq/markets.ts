// nasdaq/markets/movers (and tmx/markets/movers, which the same fetcher answers), nasdaq/markets/status, index/search and
// index/snapshots, provider nasdaq. Ported from openbb_nasdaq/models/{market_movers,market_status,index_search,
// index_snapshots}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { INDEX_TYPE_MAP } from './filters.js'
import { cleanValue, compact, getNasdaqData, rowsFromTable, toDate, toNumber, toPercent, truthy, type Dict } from './helpers.js'

// --- movers ----------------------------------------------------------------------------------------------------

const MOVER_KEYS: Record<string, string> = {
  most_active_share_volume: 'MostActiveByShareVolume',
  most_active_dollar_volume: 'MostActiveByDollarVolume',
  most_advanced: 'MostAdvanced',
  most_declined: 'MostDeclined',
  nasdaq_100: 'Nasdaq100Movers',
}
const MOVER_ASSET_CLASSES: Record<string, string> = { stocks: 'STOCKS', etf: 'ETF', mutualfunds: 'MUTUALFUNDS' }
const MOVER_SESSION_KEYS: Record<string, string> = { market: 'currentMarket', pre_market: 'premarket', after_hours: 'afterHours' }

export async function marketMovers(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const category = String(params.category ?? 'most_active_share_volume')
  const assetClass = String(params.asset_class ?? 'stocks')
  const session = String(params.session ?? 'market')
  const limit = typeof params.limit === 'number' ? params.limit : 10
  if (!(category in MOVER_KEYS) || !(session in MOVER_SESSION_KEYS)) throw new NativeUnsupported(`nasdaq has no '${category}' movers list for the ${session} session`)
  const assetKey = MOVER_ASSET_CLASSES[assetClass]
  if (assetKey === undefined) throw new Error(`'${assetClass}' is not a Nasdaq market-movers asset class. Choose one of: ${Object.keys(MOVER_ASSET_CLASSES).join(', ')}.`)

  const data = await getNasdaqData(ctx, `marketmovers?assetclass=${assetKey}&exchangestatus=${MOVER_SESSION_KEYS[session]}&limit=${limit}`)
  const block: Dict = (data ?? {})[assetKey] ?? {}
  const listing: Dict | undefined = block[MOVER_KEYS[category]!]
  if (!truthy(listing)) throw new Error(`Nasdaq does not publish '${category}' for the '${assetClass}' asset class.`)

  const isVolumeList = category.includes('most_active')
  return rowsFromTable(listing!.table).map((row) => {
    const changeField = row.change
    const price = toNumber(row.lastSalePrice)
    const change = toNumber(row.lastSaleChange)
    let percent = toPercent(isVolumeList ? row.percentageChange : changeField)
    if (percent === null && price !== null && change !== null) {
      const previous = price - change
      percent = previous ? change / previous : null
    }
    return compact({ symbol: row.symbol, name: row.name, price, change, change_percent: percent, volume: isVolumeList ? toNumber(changeField) : null })
  })
}

// --- market status ---------------------------------------------------------------------------------------------

const SESSION_FIELDS: Record<string, string> = {
  pre_market_open: 'preMarketOpeningTime',
  pre_market_close: 'preMarketClosingTime',
  market_open: 'marketOpeningTime',
  market_close: 'marketClosingTime',
  after_hours_open: 'afterHoursMarketOpeningTime',
  after_hours_close: 'afterHoursMarketClosingTime',
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A session timestamp such as 'Jul 27, 2026 04:00 AM ET' as a naive US/Eastern ISO datetime (`parse_eastern`). */
function parseEastern(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const s = value.trim().replace(/ET$/, '').trim()
  const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec(s)
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1
  const hour12 = +m[4]!
  if (month < 1 || hour12 < 1 || hour12 > 12) return null
  const hour = (hour12 % 12) + (m[6] === 'PM' ? 12 : 0)
  const p = (n: number | string) => String(n).padStart(2, '0')
  return `${m[3]}-${p(month)}-${p(m[2]!)}T${p(hour)}:${m[5]}:00`
}

export async function marketStatus(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data: Dict = (await getNasdaqData(ctx, 'market-info')) ?? {}
  if (!Object.keys(data).length) return [] // EmptyDataError
  const record: Dict = {
    country: data.country,
    status: data.mrktStatus,
    indicator: data.marketIndicator,
    countdown: data.mrktCountDown,
    is_business_day: data.isBusinessDay,
    previous_trade_date: toDate(data.previousTradeDate),
    next_trade_date: toDate(data.nextTradeDate),
  }
  for (const [field, label] of Object.entries(SESSION_FIELDS)) record[field] = parseEastern(data[label])
  return [compact(record)]
}

// --- index/search and index/snapshots --------------------------------------------------------------------------

export async function indexSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const indexType = String(params.index_type ?? 'all_indexes')
  const typeKey = INDEX_TYPE_MAP[indexType]
  if (typeKey === undefined) throw new NativeUnsupported(`nasdaq has no index type ${indexType}`)
  const data = await getNasdaqData(ctx, `screener/index?tableonly=true&limit=10000&indextype=${typeKey}`)
  const rows: Dict[] = (((data ?? {}).records ?? {}).data ?? {}).rows ?? []
  if (!rows.length) return [] // EmptyDataError
  let results = rows
    .filter((row) => truthy(row.symbol))
    .map((row) =>
      compact({
        symbol: row.symbol,
        name: row.companyName,
        last_price: toNumber(row.lastSalePrice),
        change: toNumber(row.netChange),
        change_percent: toPercent(row.percentageChange),
      }),
    )
  const q = params.query === undefined ? '' : String(params.query)
  if (q) {
    const needle = q.toLowerCase()
    const bySymbol = params.is_symbol === true
    results = results.filter((r) => (bySymbol ? String(r.symbol ?? '').toLowerCase().includes(needle) : String(r.symbol ?? '').toLowerCase().includes(needle) || String(r.name ?? '').toLowerCase().includes(needle)))
  }
  return results
}

const REGION_SCREENERS: Record<string, string> = { all: 'ALL', us: 'US', international: 'GM' }
const NORDIC_REGION = 'nordic'

export async function indexSnapshots(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const regionParam = String(params.region ?? 'us')
  const region = regionParam.toLowerCase()
  let data: Dict[]
  if (region === NORDIC_REGION) {
    const payload = await getNasdaqData(ctx, 'nordic/screener/indexes?tableonly=false&lang=en&size=1000&page=1')
    data = ((payload ?? {}).instrumentListing ?? {}).rows ?? []
  } else {
    const typeKey = REGION_SCREENERS[region]
    if (typeKey === undefined) throw new Error(`'${regionParam}' is not a Nasdaq index region. Choose one of: ${[...Object.keys(REGION_SCREENERS), NORDIC_REGION].join(', ')}.`)
    const payload = await getNasdaqData(ctx, `screener/index?tableonly=true&limit=10000&indextype=${typeKey}`)
    data = ((((payload ?? {}).records ?? {}).data ?? {}).rows ?? []) as Dict[]
  }
  if (!data.length) return [] // EmptyDataError
  const results: Row[] = []
  for (const row of data) {
    const symbol = row.symbol
    if (!truthy(symbol)) continue
    results.push(
      compact({
        symbol,
        name: truthy(row.companyName) ? row.companyName : row.fullName,
        currency: cleanValue(row.currency),
        price: toNumber(row.lastSalePrice),
        high: toNumber(row.high),
        low: toNumber(row.low),
        volume: toNumber(row.volume),
        change: toNumber(row.netChange),
        change_percent: toPercent(row.percentageChange),
      }),
    )
  }
  return results
}
