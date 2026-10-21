// FX forward and option valuation from DTCC PPD forex prints. Ported from openbb_cftc/utils/fx_valuation.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are ISO strings.
import { fxPairs } from './constants.js'
import { EmptyDataError, parseDate, parseNotional, type Rec, type SliceRecord } from './curve.js'
import type { D } from './dates.js'
import { diffDays } from './dates.js'
import { baseNotional, carryBound, extractFxObservations, pairRate } from './fx.js'
import { garmanKohlhagen } from './fx-theory.js'
import { extractVanillaOptions, impliedDf, ndfForwardCurve, optionIsCall, priceOptions, rateDiscountFactor, type DiscountFn } from './fx-vol.js'
import { pyMedian } from './num.js'
import { forwardProduct, words } from './trades.js'
import { qualifiedKeys } from './dtcc.js'

const PRICEABLE_FORWARDS = new Set(['Forward', 'Non-Deliverable Forward'])
const OPTION_FAMILIES = new Set(['Van', 'NDO'])
const OPTION_FISN: Record<string, string> = { Van: 'NA/O Van ', NDO: 'NA/O NDO ' }
const DAYS_PER_YEAR = 365.0
const MIN_FORWARD_NODES = 2
const CURVE_MIN_NOTIONAL = 1_000.0
const LIVE_ACTION = 'NEWT'
const LIVE_EVENT = 'TRAD'

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/** Whether a print is a component of a package, whose level is the package's own (`is_package_leg`). */
export const isPackageLeg = (record: SliceRecord): boolean => sf(record, 'Package indicator').toUpperCase() === 'TRUE'

/** Whether a print's terms are standardized, so its rate is a market level (`is_standard_terms`). */
export const isStandardTerms = (record: SliceRecord): boolean => sf(record, 'Non-standardized term indicator').toUpperCase() !== 'TRUE'

/** Whether a print is a new trade rather than a lifecycle event (`is_live_print`). */
export const isLivePrint = (record: SliceRecord): boolean => sf(record, 'Action type') === LIVE_ACTION && sf(record, 'Event type') === LIVE_EVENT

/** A rate stated as unit/quoted currency converted into quote per base (`oriented_rate`). */
export function orientedRate(value: number, basis: string | null | undefined, base: string, quote: string): number | null {
  const parts = (basis ?? '').trim().toUpperCase().split('/')
  if (parts.length !== 2 || !value) return null
  const [unit, quoted] = parts as [string, string]
  if (unit === base && quoted === quote) return value
  if (unit === quote && quoted === base) return 1.0 / value
  return null
}

/** Pick the rate or its reciprocal, whichever the pair's spot supports (`orient_to_spot`). */
export function orientToSpot(rate: number, spot: number): number {
  if (rate <= 0.0 || spot <= 0.0) return rate
  return Math.abs(Math.log(rate / spot)) <= Math.abs(Math.log(1.0 / rate / spot)) ? rate : 1.0 / rate
}

/** Traded rate in quote per base, from the stated Exchange rate and its basis (`exchange_rate`). */
export function exchangeRate(record: SliceRecord, base: string, quote: string): number | null {
  const [rate] = parseNotional(record['Exchange rate'])
  const stated = rate ? orientedRate(rate, record['Exchange rate basis'], base, quote) : null
  return stated !== null ? stated : pairRate(record, base, quote)
}

/** Base, quote and pair key of a print's legs, in the key's convention (`pair_for`). */
export function pairFor(record: SliceRecord): [string, string, string] | null {
  const legs = words(sf(record, 'UPI Underlier Name').toUpperCase())
  if (legs.length !== 2) return null
  for (const key of [`${legs[0]}${legs[1]}`, `${legs[1]}${legs[0]}`]) if (key in fxPairs) return [key.slice(0, 3), key.slice(3), key]
  return null
}

/** 'forward' for forwards and FX swaps, 'option' for vanilla and non-deliverable options (`classify_fx_trade`). */
export function classifyFxTrade(record: SliceRecord): 'forward' | 'option' | null {
  const fisn = sf(record, 'UPI FISN')
  const product = forwardProduct(fisn)
  if (product !== null && PRICEABLE_FORWARDS.has(product)) return 'forward'
  const parts = words(fisn)
  if (parts.length >= 3 && parts[0] === 'NA/O' && OPTION_FAMILIES.has(parts[1]!)) return 'option'
  return null
}

/** FISN prefix of the option family a print belongs to (`option_family`). */
function optionFamily(record: SliceRecord): string | null {
  const parts = words(sf(record, 'UPI FISN'))
  if (parts.length < 3 || parts[0] !== 'NA/O') return null
  return OPTION_FISN[parts[1]!] ?? null
}

/** Traded terms of an FX forward or option print, or null when they are unpriceable (`extract_fx_trade`). */
export function extractFxTrade(record: SliceRecord, curveDate: D, minNotional = 0.0): Rec | null {
  const family = classifyFxTrade(record)
  const resolved = pairFor(record)
  if (family === null || resolved === null || !isLivePrint(record)) return null
  if (isPackageLeg(record) || !isStandardTerms(record)) return null
  const [base, quote, key] = resolved
  const expiry = parseDate(record['Expiration Date'])
  if (expiry === null || diffDays(expiry, curveDate) <= 0) return null
  const notional = baseNotional(record, base)
  if (!notional || notional < minNotional) return null
  const fisn = sf(record, 'UPI FISN')
  const trade: Rec = {
    dissemination_identifier: sf(record, 'Dissemination Identifier'),
    trade_key: qualifiedKeys(record)['Trade Key'] ?? null,
    trade_type: `fx_${family}`,
    pair: key,
    base,
    quote,
    currency: quote,
    notional,
    expiration_date: expiry,
    effective_date: parseDate(record['Effective Date']),
    days: diffDays(expiry, curveDate),
    product: forwardProduct(fisn),
    upi_fisn: fisn,
    underlier: sf(record, 'UPI Underlier Name'),
    cleared: sf(record, 'Cleared') || null,
  }
  if (family === 'forward') {
    const rate = exchangeRate(record, base, quote)
    if (!rate) return null
    trade.traded_rate = rate
    return trade
  }
  const [rawStrike] = parseNotional(record['Strike Price'])
  let strike = rawStrike ? orientedRate(rawStrike, record['Strike price currency/currency pair'], base, quote) : null
  if (strike === null) strike = exchangeRate(record, base, quote)
  const [premium] = parseNotional(record['Option Premium Amount'])
  const premiumCcy = sf(record, 'Option Premium Currency')
  const isCall = optionIsCall(sf(record, 'Call currency'), sf(record, 'Put currency'), base, quote)
  if (!strike || !premium || isCall === null || (premiumCcy !== base && premiumCcy !== quote)) return null
  trade.strike = strike
  trade.premium = premium
  trade.premium_currency = premiumCcy
  trade.is_call = isCall
  trade.option_family = optionFamily(record)
  return trade
}

/** One pass reducing a day's prints to those whose FISN names both legs (`pair_records`). */
export function pairRecords(fxRecords: Iterable<SliceRecord>, base: string, quote: string): SliceRecord[] {
  const subset: SliceRecord[] = []
  for (const record of fxRecords) {
    const parts = words(record['UPI FISN'] ?? '')
    if (parts.includes(base) && parts.includes(quote)) subset.push(record)
  }
  return subset
}

export type Memo = Map<string, unknown>

/** The pair's own prints, extracted once per day and reused across trades (`_pair_subset`). */
function pairSubset(fxRecords: Iterable<SliceRecord>, trade: Rec, memo: Memo): SliceRecord[] {
  const key = `fx-pair:${trade.base}/${trade.quote}`
  if (!memo.has(key)) memo.set(key, pairRecords(fxRecords, trade.base as string, trade.quote as string))
  return memo.get(key) as SliceRecord[]
}

/** The currency's discount function, built once per day, or null (`_discount_for`). */
function discountFor(ratesRecords: Iterable<SliceRecord>, currency: string, curveDate: D, minTrades: number, memo: Memo): DiscountFn | null {
  const key = `fx-df:${currency}:${minTrades}`
  if (!memo.has(key)) {
    try {
      memo.set(key, rateDiscountFactor(ratesRecords, currency, curveDate, minTrades))
    } catch (err) {
      if (!(err instanceof EmptyDataError)) throw err
      memo.set(key, null)
    }
  }
  return memo.get(key) as DiscountFn | null
}

export type FxMarket = { spot: number; forward: DiscountFn; df_base: DiscountFn; df_quote: DiscountFn }

/** Both legs' curves and a covered-interest-parity forward, when prints are sparse (`_cip_market`). */
function cipMarket(peers: SliceRecord[], ratesRecords: Iterable<SliceRecord>, trade: Rec, curveDate: D, minTrades: number, memo: Memo): FxMarket | null {
  const near = extractFxObservations(peers, trade.pair as string, curveDate, CURVE_MIN_NOTIONAL)
    .filter((o) => o.days <= 9)
    .map((o) => o.rate)
  if (near.length === 0) return null
  const spot = pyMedian(near)
  if (spot <= 0.0) return null
  const dfBase = discountFor(ratesRecords, trade.base as string, curveDate, minTrades, memo)
  const dfQuote = discountFor(ratesRecords, trade.quote as string, curveDate, minTrades, memo)
  if (dfBase === null || dfQuote === null) return null
  return { spot, forward: (years) => (spot * dfBase(years)) / dfQuote(years), df_base: dfBase, df_quote: dfQuote }
}

/** Spot, forward interpolator and both legs' discount curves for a pair, or null (`fx_market`). */
export function fxMarket(fxRecords: Iterable<SliceRecord>, ratesRecords: Iterable<SliceRecord>, trade: Rec, curveDate: D, minTrades = 1, memo: Memo = new Map()): FxMarket | null {
  const peers = pairSubset(fxRecords, trade, memo).filter((record) => sf(record, 'Dissemination Identifier') !== trade.dissemination_identifier && !isPackageLeg(record))
  const nodes = new Set(extractFxObservations(peers, trade.pair as string, curveDate, CURVE_MIN_NOTIONAL).filter((o) => o.days > 2).map((o) => o.days))
  if (nodes.size < MIN_FORWARD_NODES) return cipMarket(peers, ratesRecords, trade, curveDate, minTrades, memo)
  const [spot, forward] = ndfForwardCurve(peers, trade.pair as string, curveDate, CURVE_MIN_NOTIONAL)
  if (spot === null || forward === null || spot <= 0.0) return cipMarket(peers, ratesRecords, trade, curveDate, minTrades, memo)
  let dfBase = discountFor(ratesRecords, trade.base as string, curveDate, minTrades, memo)
  let dfQuote: DiscountFn
  if (dfBase !== null) dfQuote = impliedDf(dfBase, spot, forward)
  else {
    const q = discountFor(ratesRecords, trade.quote as string, curveDate, minTrades, memo)
    if (q === null) return null
    dfQuote = q
    dfBase = (years) => (q(years) * forward(years)) / spot
  }
  return { spot, forward, df_base: dfBase, df_quote: dfQuote }
}

/** Mark a forward to the pair's forward curve and discount to the curve date (`value_fx_forward`). */
export function valueFxForward(trade: Rec, market: FxMarket): Rec {
  const years = (trade.days as number) / DAYS_PER_YEAR
  const marketRate = market.forward(years)
  const discount = market.df_quote(years)
  const npv = (trade.notional as number) * (marketRate - (trade.traded_rate as number)) * discount
  return { market_rate: marketRate, discount_factor: discount, npv, spot: market.spot, years }
}

/** Implied volatility for a trade's strike, from the day's prints of its own family (`option_vol`). */
export function optionVol(fxRecords: Iterable<SliceRecord>, trade: Rec, market: FxMarket, curveDate: D, memo: Memo = new Map()): number | null {
  const family = trade.option_family as string | null | undefined
  if (family === null || family === undefined) return null
  const options = extractVanillaOptions(pairSubset(fxRecords, trade, memo), trade.base as string, trade.quote as string, curveDate, market.spot, family)
  const priced = priceOptions(options, market.spot, market.df_quote, market.df_base)
  if (priced.length === 0) return null
  const days = trade.days as number
  const nearest = Math.min(...priced.map((o) => Math.abs(o.tenor_days - days)))
  const atTenor = priced.filter((o) => Math.abs(o.tenor_days - days) === nearest)
  return pyMedian(atTenor.map((o) => o.implied_vol))
}

/** Garman-Kohlhagen mark of a vanilla FX option against the premium paid (`value_fx_option`). */
export function valueFxOption(trade: Rec, market: FxMarket, vol: number): Rec {
  const years = (trade.days as number) / DAYS_PER_YEAR
  const discQuote = market.df_quote(years)
  const discBase = market.df_base(years)
  const rateDom = -Math.log(discQuote) / years
  const rateFor = -Math.log(discBase) / years
  const perUnit = garmanKohlhagen(market.spot, trade.strike as number, years, rateDom, rateFor, vol, trade.is_call as boolean)
  const mark = perUnit * (trade.notional as number)
  let premium = trade.premium as number
  if (trade.premium_currency === trade.base) premium *= market.spot
  return { market_rate: (market.spot * discBase) / discQuote, discount_factor: discQuote, implied_vol: vol, mark, premium, npv: mark - premium, spot: market.spot, years }
}

/** Value an FX print end to end, or null when the day's prints cannot price it (`value_fx_trade`). */
export function valueFxTrade(record: SliceRecord, fxRecords: Iterable<SliceRecord>, ratesRecords: Iterable<SliceRecord>, curveDate: D, o: { minNotional?: number; minTrades?: number; memo?: Memo } = {}): Rec | null {
  const trade = extractFxTrade(record, curveDate, o.minNotional ?? 0.0)
  if (trade === null) return null
  const memo = o.memo ?? new Map()
  const market = fxMarket(fxRecords, ratesRecords, trade, curveDate, o.minTrades ?? 1, memo)
  if (market === null) return null
  const spot = market.spot
  const field = trade.trade_type === 'fx_forward' ? 'traded_rate' : 'strike'
  trade[field] = orientToSpot(trade[field] as number, spot)
  if (Math.abs(Math.log((trade[field] as number) / spot)) > carryBound(trade.days as number)) return null
  if (trade.trade_type === 'fx_forward') return { ...trade, ...valueFxForward(trade, market) }
  const vol = optionVol(fxRecords, trade, market, curveDate, memo)
  if (vol === null) return null
  return { ...trade, ...valueFxOption(trade, market, vol) }
}
