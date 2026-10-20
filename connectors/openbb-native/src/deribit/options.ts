// derivatives/options/chains, provider deribit. Ported from openbb_deribit/models/options_chains.py and
// utils/websocket.py (OpenBB Platform 5.0.0, Apache-2.0); modified: each contract's ticker is read with the REST
// `public/ticker` call (the same object the websocket channel `ticker.<symbol>.100ms` publishes, field for field)
// instead of one websocket subscription per expiration, and the rows are built without pandas.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { expirationDate, isRecord, request, today } from './client.js'
import { flattenTicker, getInstruments, getOptionsSymbols } from './helpers.js'
import { shape } from './model.js'

/** Contracts quoted in the underlying: their prices are carried to USD at the index level of the quote. */
const PRICE_FIELDS = ['last_price', 'settlement_price', 'mark_price', 'min_price', 'max_price', 'best_ask_price', 'best_bid_price', 'high', 'low']

/**
 * How many tickers are asked for at once. The exchange allows about 20 requests a second and answers 429 beyond that
 * (`request` then waits and asks again); a request takes 100 to 200 ms, so three at a time stay under the limit.
 */
const CONCURRENCY = 3

/** `__alias_dict__`: model field → the column it reads. */
const ALIASES = {
  contract_symbol: 'instrument_name',
  change_percent: 'price_change',
  underlying_symbol: 'underlying_index',
  underlying_spot_price: 'index_price',
  bid_size: 'best_bid_amount',
  ask_size: 'best_ask_amount',
  bid: 'best_bid_price',
  ask: 'best_ask_price',
  implied_volatility: 'mark_iv',
  mark: 'mark_price',
  last_trade_price: 'last_price',
  volume_notional: 'volume_usd',
}

/** What the answer carries per contract: the model's fields (the serializer writes only these, in this order). */
const FIELDS = [
  'underlying_symbol', 'underlying_price', 'contract_symbol', 'expiration', 'dte', 'strike', 'option_type', 'contract_size', 'open_interest', 'volume',
  'last_trade_price', 'bid', 'bid_size', 'ask', 'ask_size', 'mark', 'high', 'low', 'change_percent', 'implied_volatility', 'delta', 'gamma', 'theta', 'vega', 'rho',
  'bid_iv', 'ask_iv', 'interest_rate', 'settlement_price', 'min_price', 'max_price', 'underlying_spot_price', 'is_inverse', 'timestamp', 'volume_notional',
]

/** One contract's ticker, or undefined when it has none (a contract that fails is left out, as OpenBB leaves out one that never published). */
async function tickerOf(ctx: NativeCtx, symbol: string): Promise<Row | undefined> {
  try {
    const result = await request<Row>(ctx, 'ticker', { instrument_name: symbol })
    return isRecord(result) && Object.keys(result).length > 0 ? result : undefined
  } catch (error) {
    ctx.log(`${symbol}: ${String(error)}`)
    return undefined
  }
}

/** `str(Timestamp)` of an instant in New York: `2026-10-20 15:44:23.403000-04:00`. */
export function newYorkText(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  )
  const offset = String(parts.timeZoneName).replace('GMT', '').replace('−', '-') || '+00:00'
  const fraction = ms % 1000 === 0 ? '' : `.${String(ms % 1000).padStart(3, '0')}000`
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`
}

/** derivatives/options/chains. */
export async function optionsChains(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol).toUpperCase()
  const byExpiration = await getOptionsSymbols(ctx, symbol)
  const specs = new Map((await getInstruments(ctx, 'any', 'option')).map((d) => [String(d.instrument_name), d]))
  const contracts = [...byExpiration.values()].flat()

  // The tickers, a few at a time.
  const tickers = new Map<string, Row>()
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, contracts.length) }, async () => {
      while (next < contracts.length) {
        const contract = contracts[next++]!
        const ticker = await tickerOf(ctx, contract)
        if (ticker) tickers.set(contract, ticker)
      }
    }),
  )

  const day = Date.parse(`${today(ctx)}T00:00:00Z`)
  const results: Row[] = []
  for (const contract of contracts) {
    const ticker = tickers.get(contract)
    if (!ticker) continue
    const parts = contract.split('-')
    const flat = flattenTicker(ticker)
    delete flat.state
    const published = flat.timestamp as number
    delete flat.timestamp
    if (flat.underlying_index === 'index_price') flat.underlying_index = parts[0]!.replace(/_/g, '-')
    if (flat.estimated_delivery_price === flat.index_price) delete flat.estimated_delivery_price

    const expiration = expirationDate(parts[1]!)
    const spec = specs.get(contract) ?? {}
    results.push({
      expiration,
      strike: Number(parts[2]!.replace('d', '.')),
      option_type: contract.endsWith('-C') ? 'call' : 'put',
      dte: Math.round((Date.parse(`${expiration}T00:00:00Z`) - day) / 86_400_000),
      contract_size: spec.contract_size,
      is_inverse: spec.instrument_type === 'reversed',
      timestamp: newYorkText(published),
      ...flat,
    })
  }
  if (results.length === 0) throw new Error(`Deribit published no option quotes for ${symbol}.`)

  // A DataFrame: every record has every column, in the order they first appear, a missing value is None.
  const columns = [...new Set(results.flatMap((r) => Object.keys(r)))]
  let frame: Row[] = results.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])))
  if (frame.some((r) => r.is_inverse === true)) {
    frame = frame.map((r) => {
      const out = { ...r }
      for (const c of columns) if (PRICE_FIELDS.includes(c)) out[c] = r[c] === null ? null : (r[c] as number) * (r.index_price as number)
      return out
    })
  }
  frame.sort((a, b) => (a.expiration! < b.expiration! ? -1 : a.expiration! > b.expiration! ? 1 : 0) || (a.strike as number) - (b.strike as number) || (a.option_type! < b.option_type! ? -1 : a.option_type! > b.option_type! ? 1 : 0))

  // The model keeps its own fields, in its order; a field no contract filled is left out of every row.
  return frame.map((r) => {
    const named = shape(r, ALIASES)
    const row: Row = {}
    for (const f of FIELDS) if (f in named) row[f] = named[f]
    return row
  })
}
