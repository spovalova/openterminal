// derivatives/options/chains, provider cboe. Ported from openbb_cboe/models/options_chains.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models. The route's `results` are one record
// per contract; the underlying's quote, which OpenBB keeps in the result's metadata, is not part of them.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compareText, getCompanyDirectory, getIndexDirectory, TICKER_EXCEPTIONS, useCacheOf } from './helpers.js'

const DAY_MS = 24 * 3600 * 1000
const EXPIRY_HOUR_MS = 16 * 3600 * 1000

/** Cboe option field → OpenBB field. */
const RENAMES: Record<string, string> = { option: 'contract_symbol', iv: 'implied_volatility', theo: 'theoretical_price', percent_change: 'change_percent', prev_day_close: 'prev_close' }

/** The fields of the options chain model, in its order; a field no contract fills is left out of every record. */
const FIELDS = [
  'underlying_symbol', 'underlying_price', 'contract_symbol', 'eod_date', 'expiration', 'dte', 'strike', 'option_type', 'contract_size', 'open_interest', 'volume',
  'theoretical_price', 'last_trade_price', 'last_trade_size', 'last_trade_time', 'tick', 'bid', 'bid_size', 'bid_time', 'bid_exchange', 'ask', 'ask_size', 'ask_time',
  'ask_exchange', 'mark', 'open', 'open_bid', 'open_ask', 'high', 'bid_high', 'ask_high', 'low', 'bid_low', 'ask_low', 'close', 'close_size', 'close_time', 'close_bid',
  'close_bid_size', 'close_bid_time', 'close_ask', 'close_ask_size', 'close_ask_time', 'prev_close', 'change', 'change_percent', 'implied_volatility', 'delta', 'gamma',
  'theta', 'vega', 'rho',
]
const INTEGER_COLUMNS = ['open_interest', 'volume', 'bid_size', 'ask_size']

/** The offset of America/New_York from UTC at an instant, in milliseconds. */
function newYorkOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant))
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000
}

/** Midnight of a date in New York, as an instant in milliseconds (`tz_localize("America/New_York")`). */
function newYorkMidnight(date: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`)
  return utcMidnight - newYorkOffsetMs(utcMidnight - newYorkOffsetMs(utcMidnight))
}

/** "261120" → "2026-11-20" (`DatetimeIndex(..., yearfirst=True)`). */
function yearFirstDate(text: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(text)
  if (!m) throw new Error(`Unknown datetime string format, unable to parse: ${text}`)
  return `20${m[1]}-${m[2]}-${m[3]}`
}

export async function optionsChains(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const useCache = useCacheOf(params)
  const symbol = String(params.symbol ?? '').replaceAll('^', '').split(',')[0]!.toUpperCase()
  const [indexes, companies] = await Promise.all([getIndexDirectory(ctx, useCache), getCompanyDirectory(ctx, useCache)])
  if (!companies.has(symbol)) throw new Error(`${symbol} was not found in the Cboe options directory.`)

  const prefix = TICKER_EXCEPTIONS.includes(symbol) || indexes.has(symbol) ? '_' : ''
  const body = await ctx.http.json<{ data?: { options?: Row[]; current_price?: number } }>(`https://cdn.cboe.com/api/global/delayed_quotes/options/${prefix}${symbol}.json`)
  const options = body.data?.options ?? []
  const currentPrice = body.data?.current_price
  if (!body.data) throw new Error('Cboe returned no options data')

  const now = ctx.now().getTime()
  const contracts: Row[] = []
  for (const raw of options) {
    const row: Row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [RENAMES[k] ?? k, v]))
    // The contract symbol is root, YYMMDD expiry, C or P, and the strike in thousandths; roots with digits fail the length test.
    const m = /^(\D*)(\d*)(\D*)(\d*)/.exec(String(row.contract_symbol))
    if (!m || m[2]!.length > 6) continue
    const strikeText = m[4]!.replace(/^0+/, '')
    if (strikeText === '') throw new Error("could not convert string to float: ''")
    const expiration = yearFirstDate(m[2]!.replace(/^1+/, ''))
    const dte = Math.floor((newYorkMidnight(expiration) + EXPIRY_HOUR_MS - now) / DAY_MS)
    contracts.push({
      ...row,
      underlying_symbol: m[1],
      expiration,
      option_type: m[3]!.replaceAll('C', 'call').replaceAll('P', 'put'),
      strike: Number(strikeText) * (1 / 1000),
      dte,
      ...(currentPrice ? { underlying_price: currentPrice } : {}),
    })
  }

  // sort_index on (expiration, strike, option_type)
  contracts.sort((a, b) => compareText(a.expiration, b.expiration) || (a.strike as number) - (b.strike as number) || compareText(a.option_type, b.option_type))

  return contracts.map((c) => {
    const out: Row = {}
    for (const field of FIELDS) {
      if (!(field in c)) continue
      let value = c[field]
      if (INTEGER_COLUMNS.includes(field)) value = Math.trunc(Number(value))
      else if (field === 'change_percent') value = typeof value === 'number' ? value / 100 : value
      else if (field === 'last_trade_time') value = typeof value === 'string' && value ? value : undefined
      out[field] = value
    }
    return out
  })
}
