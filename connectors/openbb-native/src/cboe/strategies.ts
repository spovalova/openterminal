// The three Cboe options strategy commands (cboe/options/straddle, strangle and spreads) and what they share. Ported
// from openbb_cboe/utils/options/data_handler.py (load_symbol) and strategies.py (to_strategies, to_spreads), and from
// the `OptionsChainsProperties` methods they call (openbb_core/provider/utils/options_chains_properties.py: dataframe,
// _identify_price_col, _get_nearest_expiration, _get_nearest_strike, _get_nearest_otm_strikes, straddle, strangle,
// vertical_call_spread, vertical_put_spread, strategies) (OpenBB Platform 5.0.0, Apache-2.0); modified: the chain is the
// rows of the derivatives/options/chains port instead of a pydantic model, the pandas frames are arrays of rows, and
// OpenBB's per-process memo of the first chain it loaded for a symbol (`LOADED_SYMBOLS`) is not kept: every call reads
// the chain afresh. Python's `round` on a numpy float is numpy's `rint(x * 10**n) / 10**n`, which differs from the
// correctly rounded float round in near-ties, so that is what `npRound` does.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { optionsChains } from './options-chains.js'

const BID_FIELDS = ['bid', 'last_trade_price', 'close', 'close_bid', 'prev_close', 'mark', 'settlement_price']
const ASK_FIELDS = ['ask', 'last_trade_price', 'close', 'close_ask', 'prev_close', 'mark', 'settlement_price']

const isNil = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))

/** numpy's `rint`: round half to even, keeping the sign of a zero. */
function rint(x: number): number {
  const floor = Math.floor(x)
  const rest = x - floor
  const rounded = rest < 0.5 ? floor : rest > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
  return rounded === 0 && (x < 0 || Object.is(x, -0)) ? -0 : rounded
}

/** `round(np.float64(x), 4)`: numpy rounds by scaling, not by the decimal expansion of the double. */
export function npRound(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return x
  const scale = 10 ** digits
  return rint(x * scale) / scale
}

/** An error OpenBB raises as OpenBBError, or pandas as it is. */
class OpenBBError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenBBError'
  }
}

/** The chain as `CboeOptionsChainsData` holds it, and the `dataframe` property built from it. */
type Chain = {
  /** The dataframe: contracts with a non-negative dte, in (expiration, strike, option_type) order. */
  frame: Row[]
  columns: Set<string>
  /** `self.strikes`: every strike of the model, expired contracts included. */
  strikes: number[]
  /** The model's first underlying price (`data.underlying_price[0]`). */
  firstUnderlying: number | undefined
}

/** `load_symbol`: the chain of a symbol, or the OpenBBError a symbol with no options gets. */
async function loadSymbol(symbol: string, ctx: NativeCtx): Promise<Chain> {
  const upper = symbol.toUpperCase()
  let rows: Row[]
  try {
    rows = await optionsChains({ symbol: upper }, ctx)
  } catch {
    throw new OpenBBError(`No options available for ${upper}.`)
  }
  if (rows.length === 0) throw new OpenBBError(`No options available for ${upper}.`)
  const columns = new Set(rows.flatMap((r) => Object.keys(r)))
  const frame = columns.has('dte') ? rows.filter((r) => (r.dte as number) >= 0) : rows
  const strikes = [...new Set(rows.map((r) => r.strike as number))].sort((a, b) => a - b)
  return { frame, columns, strikes, firstUnderlying: columns.has('underlying_price') ? (rows[0]!.underlying_price as number) : undefined }
}

/** The `dataframe` property refuses a chain that carries no underlying price. */
function requirePrice(chain: Chain): void {
  if (!chain.columns.has('underlying_price')) {
    throw new OpenBBError("'underlying_price' was not returned in the provider data.\n\n Please set the 'last_price' property and try again.\n\n Note: This error does not impact the standard OBBject `to_df()` method.")
  }
}

/** `_identify_price_col`: the first of the usual price columns the chain has. */
function priceColumn(columns: Set<string>, side: 'bid' | 'ask'): string {
  return (side === 'bid' ? BID_FIELDS : ASK_FIELDS).find((f) => columns.has(f)) ?? ''
}

/** `df[price_col]` on a column the chain lacks is a KeyError. */
function requireColumn(columns: Set<string>, column: string): void {
  if (!columns.has(column)) throw new Error(`'${column}'`)
}

const indexError = (): Error => new Error('single positional indexer is out-of-bounds')

/** Python's text of a float for an error message (`f"{x}"`). */
const pyFloat = (v: number | null): string => (v === null ? 'None' : Number.isInteger(v) ? v.toFixed(1) : String(v))

/**
 * `_get_nearest_expiration(days)` for a number of days: the expiration of the first contract whose dte is closest
 * (-1 stands for 0, whose distance to a dte of 0 is the smallest).
 */
function nearestExpiration(chain: Chain, days: number): string {
  const target = days === 0 ? -1 : days
  let best: Row | undefined
  let distance = Infinity
  for (const r of chain.frame) {
    const d = Math.abs((r.dte as number) - target)
    if (d < distance) {
      distance = d
      best = r
    }
  }
  if (!best) throw new Error('attempt to get argmin of an empty sequence')
  return String(best.expiration)
}

/** `_get_nearest_strike`: the strike of one expiration's calls or puts closest to a target (or the nearest out of the money). */
function nearestStrike(chain: Chain, optionType: 'call' | 'put', expiration: string, strike: number, priceColumnName: string, forceOtm: boolean): number | null {
  let df = chain.frame.filter((r) => r.expiration === expiration && r.option_type === optionType)
  requireColumn(chain.columns, priceColumnName)
  df = df.filter((r) => !isNil(r[priceColumnName]))
  if (df.length === 0) return null
  if (!forceOtm) {
    const strikes = [...new Set(df.map((r) => r.strike as number))]
    let best = strikes[0]!
    for (const s of strikes) if (Math.abs(s - strike) < Math.abs(best - strike)) best = s
    return best
  }
  const candidates = df.filter((r) => (optionType === 'put' ? (r.strike as number) <= strike : (r.strike as number) >= strike)).map((r) => r.strike as number)
  if (candidates.length === 0) return null
  return optionType === 'put' ? Math.max(...candidates) : Math.min(...candidates)
}

/** `_get_nearest_otm_strikes`: the strikes of the whole chain closest to a percent out of the money on each side. */
function nearestOtmStrikes(chain: Chain, underlyingPrice: number, moneyness: number): { call: number; put: number } {
  if (moneyness > 0 && moneyness < 100) moneyness = moneyness / 100
  if (moneyness > 100 || moneyness < 0) throw new OpenBBError('Error: Moneyness must be expressed as a percentage between 0 and 100')
  const closest = (target: number): number => {
    let best = chain.strikes[0]!
    for (const s of chain.strikes) if (Math.abs(target - s) < Math.abs(target - best)) best = s
    return best
  }
  return { call: closest(underlyingPrice * (1 + moneyness)), put: closest(underlyingPrice * (1 - moneyness)) }
}

/** One priced strategy, with OpenBB's column names. NaN stands for a column the strategy leaves empty. */
type Strategy = {
  name: string
  expiration: string
  dte: number
  strike1: number
  strike2: number
  strike1Premium: number
  strike2Premium: number
  underlyingPrice: number
  cost: number
  costPercent: number
  breakevenLower: number
  breakevenLowerPercent: number
  breakevenUpper: number
  breakevenUpperPercent: number
  maxProfit: number
  maxLoss: number
}

/** The premium at a strike of one side of an expiration (`chains[chains.strike == s].query(...)[col].values[0]`). */
function premiumAt(rows: Row[], strike: number | null, optionType: 'call' | 'put', column: string): number | undefined {
  const hit = rows.find((r) => r.strike === strike && r.option_type === optionType)
  return hit ? (hit[column] as number) : undefined
}

type Leg = { strike: number; premium: number }

/** The row `straddle` and `strangle` both build from their two legs; a short one is priced at the bids and its cost is negative. */
function twoLegs(chains: Row[], expiration: string, underlyingPrice: number, call: Leg, put: Leg, short: boolean, name: string): Strategy {
  const [callStrike, putStrike] = [call.strike, put.strike]
  const cost = call.premium + put.premium
  return {
    name,
    expiration,
    dte: chains[0]!.dte as number,
    strike1: callStrike,
    strike2: putStrike,
    strike1Premium: call.premium,
    strike2Premium: put.premium,
    underlyingPrice,
    cost: short ? cost * -1 : cost,
    costPercent: npRound((cost / underlyingPrice) * 100),
    breakevenUpper: callStrike + cost,
    breakevenUpperPercent: npRound(((callStrike + cost) / underlyingPrice) * 100 - 100),
    breakevenLower: putStrike - cost,
    breakevenLowerPercent: npRound(-100 + ((putStrike - cost) / underlyingPrice) * 100),
    maxProfit: short ? Math.abs(cost) : Infinity,
    maxLoss: short ? Infinity : cost * -1,
  }
}

/** The two legs of a straddle or strangle at their strikes, or OpenBB's error when a strike has no price. */
function legsAt(chains: Row[], column: string, callStrike: number | null, putStrike: number | null): { call: Leg; put: Leg } {
  const callPremium = premiumAt(chains, callStrike, 'call', column)
  const putPremium = premiumAt(chains, putStrike, 'put', column)
  if (callPremium === undefined || putPremium === undefined) {
    throw new OpenBBError(`Error: No premium data found for the selected strikes. Call: ${pyFloat(callStrike)}, Put: ${pyFloat(putStrike)}`)
  }
  return { call: { strike: callStrike!, premium: callPremium }, put: { strike: putStrike!, premium: putPremium } }
}

/** `straddle`: a straddle at the strike nearest the underlying (out of the money), or at a given one; negative is short. */
function straddle(chain: Chain, expiration: string, strikeParam: number | undefined): Strategy {
  const chains = chain.frame.filter((r) => r.expiration === expiration)
  if (chains.length === 0) throw indexError()
  const underlyingPrice = chains[0]!.underlying_price as number
  const forceOtm = strikeParam === undefined
  const strike = strikeParam ?? underlyingPrice
  const short = strike < 0
  const strikePrice = Math.abs(strike)
  const column = priceColumn(chain.columns, short ? 'bid' : 'ask')
  const callStrike = nearestStrike(chain, 'call', expiration, strikePrice, column, forceOtm)
  const putStrike = nearestStrike(chain, 'put', expiration, strikePrice, column, forceOtm)
  const { call, put } = legsAt(chains, column, callStrike, putStrike)
  return twoLegs(chains, expiration, underlyingPrice, call, put, short, short ? 'Short Straddle' : 'Long Straddle')
}

/** `strangle`: a strangle the given percent out of the money on both sides; a negative moneyness is short. */
function strangle(chain: Chain, expiration: string, moneynessParam: number): Strategy {
  const short = moneynessParam < 0
  const moneyness = Math.abs(moneynessParam)
  const chains = chain.frame.filter((r) => r.expiration === expiration)
  const column = priceColumn(chain.columns, short ? 'bid' : 'ask')
  if (chains.length === 0) throw indexError()
  const underlyingPrice = chains[0]!.underlying_price as number
  const strikes = nearestOtmStrikes(chain, underlyingPrice, moneyness)
  const callStrike = nearestStrike(chain, 'call', expiration, strikes.call, column, false)
  const putStrike = nearestStrike(chain, 'put', expiration, strikes.put, column, false)
  const { call, put } = legsAt(chains, column, callStrike, putStrike)
  return twoLegs(chains, expiration, underlyingPrice, call, put, short, short ? 'Short Strangle' : 'Long Strangle')
}

/** `vertical_call_spread`: undefined where OpenBB returns an empty frame (the same strike on both legs, or no cost). */
function verticalCallSpread(chain: Chain, expiration: string, soldTarget: number, boughtTarget: number): Strategy | undefined {
  const chains = chain.frame.filter((r) => r.expiration === expiration && r.option_type === 'call')
  if (chains.length === 0) throw indexError()
  const lastPrice = chains[0]!.underlying_price as number
  const bid = priceColumn(chain.columns, 'bid')
  const ask = priceColumn(chain.columns, 'ask')
  const sold = nearestStrike(chain, 'call', expiration, soldTarget, bid, false)
  const bought = nearestStrike(chain, 'call', expiration, boughtTarget, ask, false)
  const soldRow = chains.find((r) => r.strike === sold)
  const boughtRow = chains.find((r) => r.strike === bought)
  if (!soldRow || !boughtRow) throw indexError()
  const soldPremium = (soldRow[bid] as number) * -1
  const boughtPremium = boughtRow[ask] as number
  const spreadCost = boughtPremium + soldPremium
  const breakevenPrice = bought! + spreadCost
  const maxProfit = sold! - bought! - spreadCost
  if (!(sold !== bought && spreadCost !== 0)) return undefined
  const out: Strategy = {
    name: 'Bull Call Spread',
    expiration,
    dte: chains[0]!.dte as number,
    strike1: sold!,
    strike2: bought!,
    strike1Premium: soldPremium,
    strike2Premium: boughtPremium,
    underlyingPrice: lastPrice,
    cost: spreadCost,
    costPercent: npRound((spreadCost / lastPrice) * 100),
    breakevenLower: breakevenPrice,
    breakevenLowerPercent: npRound((breakevenPrice / lastPrice) * 100 - 100),
    breakevenUpper: NaN,
    breakevenUpperPercent: NaN,
    maxProfit,
    maxLoss: spreadCost * -1,
  }
  if (out.cost < 0) {
    out.maxProfit = out.cost * -1
    out.maxLoss = -1 * (bought! - sold! + out.cost)
    const lower = sold! > bought! ? bought! : sold!
    out.breakevenUpper = lower + out.maxProfit
    out.breakevenUpperPercent = npRound((breakevenPrice / lastPrice) * 100 - 100)
    out.breakevenLower = NaN
    out.breakevenLowerPercent = NaN
    out.name = 'Bear Call Spread'
  }
  return out
}

/** `vertical_put_spread`. */
function verticalPutSpread(chain: Chain, expiration: string, soldTarget: number, boughtTarget: number): Strategy | undefined {
  const chains = chain.frame.filter((r) => r.expiration === expiration && r.option_type === 'put')
  if (chains.length === 0) throw indexError()
  const lastPrice = chains[0]!.underlying_price as number
  const bid = priceColumn(chain.columns, 'bid')
  const ask = priceColumn(chain.columns, 'ask')
  const sold = nearestStrike(chain, 'put', expiration, soldTarget, bid, false)
  const bought = nearestStrike(chain, 'put', expiration, boughtTarget, ask, false)
  const soldRow = chains.find((r) => r.strike === sold)
  const boughtRow = chains.find((r) => r.strike === bought)
  if (!soldRow || !boughtRow) throw indexError()
  const soldPremium = (soldRow[bid] as number) * -1
  const boughtPremium = boughtRow[ask] as number
  const spreadCost = boughtPremium + soldPremium
  const maxProfit = Math.abs(spreadCost)
  const breakevenPrice = sold! - maxProfit
  const maxLoss = (sold! - bought! - maxProfit) * -1
  if (!(sold !== bought && maxLoss !== 0)) return undefined
  const out: Strategy = {
    name: 'Bull Put Spread',
    expiration,
    dte: chains[0]!.dte as number,
    strike1: sold!,
    strike2: bought!,
    strike1Premium: soldPremium,
    strike2Premium: boughtPremium,
    underlyingPrice: lastPrice,
    cost: spreadCost,
    costPercent: npRound((maxProfit / lastPrice) * 100),
    breakevenLower: NaN,
    breakevenLowerPercent: NaN,
    breakevenUpper: breakevenPrice,
    breakevenUpperPercent: 100 - npRound((breakevenPrice / lastPrice) * 100),
    maxProfit,
    maxLoss,
  }
  if (out.cost > 0) {
    out.maxProfit = bought! - sold! - spreadCost
    out.maxLoss = spreadCost * -1
    out.breakevenLower = bought! - spreadCost
    out.breakevenLowerPercent = 100 - npRound((breakevenPrice / lastPrice) * 100)
    out.breakevenUpper = NaN
    out.breakevenUpperPercent = NaN
    out.name = 'Bear Put Spread'
  }
  return out
}

/**
 * The expirations `strategies(days=-1)` visits: one per distinct dte among contracts with a bid, each the expiration
 * of the first contract nearest that dte, deduplicated and sorted.
 */
function expirationsToPrice(chain: Chain): string[] {
  const bid = priceColumn(chain.columns, 'bid')
  requireColumn(chain.columns, bid)
  const days = [...new Set(chain.frame.filter((r) => !isNil(r[bid])).map((r) => r.dte as number))]
  return [...new Set(days.map((day) => nearestExpiration(chain, day)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const NO_STRATEGIES = 'No strategies found for the given parameters.'

/** `to_strategies`: a straddle or strangle as OpenBB's `StrategyData` serialises it (NaN and infinity are empty). */
function strategyRow(s: Strategy): Row {
  return finite({
    expiration: s.expiration,
    dte: s.dte,
    strike_1: s.strike1,
    strike_2: s.strike2,
    underlying_price: s.underlyingPrice,
    cost_percent: s.costPercent,
    max_profit: s.maxProfit,
    max_loss: s.maxLoss,
    breakeven_upper: s.breakevenUpper,
    breakeven_upper_percent: s.breakevenUpperPercent,
    breakeven_lower: s.breakevenLower,
    breakeven_lower_percent: s.breakevenLowerPercent,
    strike_1_premium: s.strike1Premium,
    strike_2_premium: s.strike2Premium,
    cost: s.cost,
  })
}

/** `to_spreads`: a vertical spread as `SpreadData` serialises it. */
function spreadRow(s: Strategy): Row {
  return finite({
    strategy: s.name,
    expiration: s.expiration,
    dte: s.dte,
    sold_strike: s.strike1,
    bought_strike: s.strike2,
    underlying_price: s.underlyingPrice,
    cost: s.cost,
    cost_percent: s.costPercent,
    max_profit: s.maxProfit,
    max_loss: s.maxLoss,
    breakeven_lower: s.breakevenLower,
    breakeven_lower_percent: s.breakevenLowerPercent,
    breakeven_upper: s.breakevenUpper,
    breakeven_upper_percent: s.breakevenUpperPercent,
    sold_premium: s.strike1Premium,
    bought_premium: s.strike2Premium,
  })
}

/** `df.replace({nan: None, inf: None, -inf: None})`: those cells are empty, and an empty cell is left out. */
function finite(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => !(typeof v === 'number' && !Number.isFinite(v))))
}

const numberParam = (params: NativeParams, name: string): number | undefined => {
  const v = params[name]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`${name} must be a number`)
  return n
}

const symbolParam = (params: NativeParams, fallback: string): string => {
  const v = params.symbol
  return v === undefined || v === null || v === '' ? fallback : String(Array.isArray(v) ? v.join(',') : v)
}

// cboe/options/straddle (command, no provider). Ported from openbb_cboe/routers/options.py (straddle); modified: see the top of the file.
export async function optionsStraddle(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const chain = await loadSymbol(symbolParam(params, 'SPY'), ctx)
  requirePrice(chain)
  // A strike of 0 reads as none: `straddle_strike = None if straddle_strike == 0`.
  const given = numberParam(params, 'strike')
  const strike = given === 0 ? undefined : given
  const priced = expirationsToPrice(chain)
    .map((expiration) => straddle(chain, expiration, strike))
    .filter((s) => s.cost !== 0)
  if (priced.length === 0) throw new OpenBBError(NO_STRATEGIES)
  return priced.map(strategyRow)
}

// cboe/options/strangle (command, no provider). Ported from openbb_cboe/routers/options.py (strangle); modified: see the top of the file.
export async function optionsStrangle(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const chain = await loadSymbol(symbolParam(params, 'SPY'), ctx)
  requirePrice(chain)
  const moneyness = numberParam(params, 'moneyness') ?? 5
  // `strangle_moneyness=1 if moneyness == 0 else moneyness`
  const target = moneyness === 0 ? 1 : moneyness
  const priced = expirationsToPrice(chain)
    .map((expiration) => strangle(chain, expiration, target))
    .filter((s) => s.cost !== 0)
  // pandas: `.query("`Strike 1` != `Strike 2`")` on the empty frame no day filled has no such column.
  if (priced.length === 0) throw new Error("Unexpected Error -> UndefinedVariableError -> name 'BACKTICK_QUOTED_STRING_Strike_1' is not defined")
  // `drop_duplicates()` cannot drop a row here: every one has its own expiration.
  const kept = priced.filter((s) => s.strike1 !== s.strike2)
  if (kept.length === 0) throw new OpenBBError(NO_STRATEGIES)
  return kept.map(strategyRow)
}

// cboe/options/spreads (command, no provider). Ported from openbb_cboe/routers/options.py (spreads): the four vertical
// spreads of every expiration; modified: see the top of the file.
export async function optionsSpreads(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const chain = await loadSymbol(symbolParam(params, 'SPY'), ctx)
  const spreadType = String(params.spread_type ?? 'both')
  if (!['call', 'put', 'both'].includes(spreadType)) throw new Error(`spread_type must be call, put or both, not ${spreadType}`)
  const nearMoneyness = numberParam(params, 'near_moneyness') ?? 2.5
  const farMoneyness = numberParam(params, 'far_moneyness') ?? 7.5
  // `data.underlying_price[0]` of a chain with no underlying price
  if (chain.firstUnderlying === undefined) throw new Error('list index out of range')
  const last = chain.firstUnderlying
  const [nearM, farM] = [nearMoneyness / 100, farMoneyness / 100]
  const [nearCall, farCall] = [last * (1 + nearM), last * (1 + farM)]
  const [nearPut, farPut] = [last * (1 - nearM), last * (1 - farM)]
  const specs: ['call' | 'put', number, number][] = []
  if (spreadType === 'call' || spreadType === 'both') specs.push(['call', farCall, nearCall], ['call', nearCall, farCall])
  if (spreadType === 'put' || spreadType === 'both') specs.push(['put', nearPut, farPut], ['put', farPut, nearPut])

  const rows: Row[] = []
  for (const [kind, sold, bought] of specs) {
    // One `strategies()` call per spec: its spreads, or OpenBB's error when it finds none.
    const priced = expirationsToPrice(chain)
      .map((expiration) => (kind === 'call' ? verticalCallSpread(chain, expiration, sold, bought) : verticalPutSpread(chain, expiration, sold, bought)))
      .filter((s): s is Strategy => s !== undefined)
    if (priced.length === 0) throw new OpenBBError(NO_STRATEGIES)
    rows.push(...priced.map(spreadRow))
  }
  return rows
}
