// FX option implied-volatility analytics and the rate discount curves they use, from DTCC PPD records. Ported from
// openbb_cftc/utils/fx_vol.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are ISO strings.
import { pyRound } from '../helpers.js'
import { fxTenorBuckets, majorFxPairs, oisFisn, rateCurveFisns, currencyBasis, SINGLE_PAYMENT_MAX_DAYS, type MajorPairSpec } from './constants.js'
import { buildCurve, EmptyDataError, interpolateLogDf, parseDate, parseNotional, type Rec, type SliceRecord, type CurvePoints } from './curve.js'
import { diffDays, type D } from './dates.js'
import { extractFxObservations } from './fx.js'
import { calibrateSabr, impliedVol, sabrVol } from './fx-theory.js'
import { pyMedian } from './num.js'
import { extractForwardObservations } from './policy.js'
import { words } from './trades.js'

const STRIKE_OFFSETS = [-1000, -500, -250, -150, -100, -50, -25, 0, 25, 50, 100, 150, 250, 500, 1000]
const STRIKE_MAX_OFFSET = 1250.0
const MONEYNESS_OFFSETS = [-1500, -1000, -750, -500, -300, -200, -100, -50, 0, 50, 100, 200, 300, 500, 750, 1000, 1500]
const MONEYNESS_MAX_OFFSET = 1750.0
const VOL_TRIM_MIN = 0.5
const VOL_TRIM_MAX = 2.0

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/** A major pair's base, quote and pip, or an error for an unsupported one (`resolve_major_pair`). */
export function resolveMajorPair(pair: string): [string, string, number] {
  const key = (pair || '').trim().toUpperCase()
  const spec = majorFxPairs[key]
  if (!spec) throw new Error(`Invalid pair: '${pair}'. Valid pairs are: ${Object.keys(majorFxPairs).join(', ')}`)
  return [spec.base, spec.quote, spec.pip]
}

/** Whether a vol pair is non-deliverable, priced from NDF forwards and NDO options (`is_ndf_vol_pair`). */
export const isNdfVolPair = (pair: string): boolean => Boolean((majorFxPairs[(pair || '').trim().toUpperCase()] as MajorPairSpec | undefined)?.ndf)

/** Whether a FISN names both legs of the pair, in either order (`_pair_matches`). */
const pairMatches = (fisn: string, base: string, quote: string): boolean => {
  const parts = words(fisn)
  return parts.includes(base) && parts.includes(quote)
}

/** Whether any record is an option of the family naming both legs of the pair (`has_vanilla_options`). */
export function hasVanillaOptions(records: Iterable<SliceRecord>, base: string, quote: string, family = 'NA/O Van '): boolean {
  for (const r of records) {
    const fisn = r['UPI FISN'] ?? ''
    if (fisn.startsWith(family) && pairMatches(fisn, base, quote)) return true
  }
  return false
}

export type DiscountFn = (years: number) => number

/** A callable mapping a year-fraction to a currency's OIS discount factor (`ois_discount_factor`). */
export const oisDiscountFactor = (records: Iterable<SliceRecord>, currency: string, tradeDate: D, minTrades = 3, forwardAware = false): DiscountFn => discountFactor(records, oisFisn(currency), currency, tradeDate, minTrades, forwardAware)

/** Discount factor from a currency's rate curve, deepest swap family first (`rate_discount_factor`). */
export function rateDiscountFactor(records: Iterable<SliceRecord>, currency: string, tradeDate: D, minTrades = 3, forwardAware = false): DiscountFn {
  const rows = Array.isArray(records) ? records : [...records]
  for (const fisn of rateCurveFisns(currency)) {
    try {
      return discountFactor(rows, fisn, currency, tradeDate, minTrades, forwardAware)
    } catch (err) {
      if (err instanceof EmptyDataError) continue
      throw err
    }
  }
  throw new EmptyDataError(`No rate curve could be built for ${currency}.`)
}

const sortPairs = (xs: [number, number][]): [number, number][] => xs.sort((a, b) => a[0] - b[0] || a[1] - b[1])

/** Spot DF nodes extended with single-payment forward-starting swaps of the same family (`_forward_fill`). */
function forwardFill(nodes: CurvePoints, records: Iterable<SliceRecord>, fisn: string, currency: string, tradeDate: D): CurvePoints {
  const observations = extractForwardObservations(records, fisn, currency, tradeDate).filter((o) => o.tenor_days <= SINGLE_PAYMENT_MAX_DAYS)
  if (observations.length === 0) return nodes
  const groups = new Map<string, Map<D, typeof observations>>()
  for (const o of observations) {
    const key = `${pyRound(o.forward_days / 30.0, 0)},${pyRound(o.tenor_days / 30.0, 0)}`
    if (!groups.has(key)) groups.set(key, new Map())
    const byDay = groups.get(key)!
    if (!byDay.has(o.as_of_date)) byDay.set(o.as_of_date, [])
    byDay.get(o.as_of_date)!.push(o)
  }
  const basis = currencyBasis(currency)
  const forwards: [D, D, number][] = []
  for (const byDay of groups.values()) {
    const latest = [...byDay.keys()].sort().at(-1)!
    const members = byDay.get(latest)!
    const ordered = members.map((m, i) => ({ m, i })).sort((a, b) => (a.m.effective_date < b.m.effective_date ? -1 : a.m.effective_date > b.m.effective_date ? 1 : a.i - b.i))
    const representative = ordered[Math.floor(members.length / 2)]!.m
    forwards.push([representative.effective_date, representative.expiration_date, pyMedian(members.map((m) => m.rate))])
  }
  const enriched: CurvePoints = [...nodes]
  const byExpiration = forwards.map((f, i) => ({ f, i })).sort((a, b) => (a.f[1] < b.f[1] ? -1 : a.f[1] > b.f[1] ? 1 : a.i - b.i))
  for (const { f: [effective, expiration, rate] } of byExpiration) {
    const startYears = diffDays(effective, tradeDate) / 365.0
    const endYears = diffDays(expiration, tradeDate) / 365.0
    const denominator = 1.0 + (rate * diffDays(expiration, effective)) / basis
    if (denominator <= 0 || enriched.some(([years]) => Math.abs(years - endYears) < 0.04)) continue
    const dfEnd = interpolateLogDf(enriched, startYears) / denominator
    enriched.push([endYears, dfEnd])
    sortPairs(enriched)
  }
  return enriched
}

/** Bootstrap a currency's curve from one swap family and interpolate its DF by tenor (`_discount_factor`). */
function discountFactor(records: Iterable<SliceRecord>, fisn: string, currency: string, tradeDate: D, minTrades: number, forwardAware = false): DiscountFn {
  const rows = Array.isArray(records) ? records : [...records]
  const curve = buildCurve(rows, tradeDate, fisn, { currency, minTrades })
  let nodes: CurvePoints = sortPairs(curve.filter((n) => n.discount_factor !== null && n.discount_factor !== undefined).map((n) => [n.tenor_years as number, n.discount_factor as number] as [number, number]))
  if (forwardAware) nodes = forwardFill(nodes, rows, fisn, currency, tradeDate)
  return (years: number) => interpolateLogDf(nodes, years)
}

/** Median quote-per-base from the pair's own shortest-dated deliverable forwards (`_deliverable_spot`). */
function deliverableSpot(records: Iterable<SliceRecord>, base: string, quote: string, asOf: D): number | null {
  const rates: number[] = []
  for (const record of records) {
    const parts = words(sf(record, 'UPI FISN'))
    if (parts.length !== 3 || (parts[0] !== 'NA/Fwd' && parts[0] !== 'NA/Swaps') || !((parts[1] === base && parts[2] === quote) || (parts[1] === quote && parts[2] === base))) continue
    if (sf(record, 'Action type') !== 'NEWT') continue
    const effective = parseDate(record['Effective Date'])
    const [first] = parseNotional(record['Notional amount-Leg 1'])
    const [second] = parseNotional(record['Notional amount-Leg 2'])
    const ccy1 = sf(record, 'Notional currency-Leg 1')
    const ccy2 = sf(record, 'Notional currency-Leg 2')
    if (!(effective && first && second) || diffDays(effective, asOf) > 2) continue
    if (ccy1 === base && ccy2 === quote) rates.push(second / first)
    else if (ccy2 === base && ccy1 === quote) rates.push(first / second)
  }
  return rates.length > 0 ? pyMedian(rates) : null
}

/** Spot in quote per base from deliverable forwards (`fx_spot`). */
export function fxSpot(records: Iterable<SliceRecord>, base: string, quote: string, asOf: D): number | null {
  const rows = Array.isArray(records) ? records : [...records]
  const direct = deliverableSpot(rows, base, quote, asOf)
  if (direct !== null || base === 'USD' || quote === 'USD') return direct
  const usdPerBase = deliverableSpot(rows, base, 'USD', asOf)
  const usdPerQuote = deliverableSpot(rows, quote, 'USD', asOf)
  if (usdPerBase === null || usdPerQuote === null) return null
  return usdPerBase / usdPerQuote
}

/** `bisect.bisect_right`. */
function bisectRight(xs: number[], x: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < xs[mid]!) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Spot and a year-fraction forward interpolator from a pair's non-deliverable forwards (`ndf_forward_curve`). */
export function ndfForwardCurve(records: Iterable<SliceRecord>, pair: string, asOf: D, minNotional = 0.0): [number | null, DiscountFn | null] {
  const observations = extractFxObservations(records, pair, asOf, minNotional).filter((o) => o.days > 2)
  if (observations.length === 0) return [null, null]
  const byDay = new Map<number, number[]>()
  for (const o of observations) {
    if (!byDay.has(o.days)) byDay.set(o.days, [])
    byDay.get(o.days)!.push(o.rate)
  }
  const nodes: [number, number][] = sortPairs([...byDay].map(([days, rates]) => [days, pyMedian(rates)] as [number, number]))
  const days = nodes.map((n) => n[0])
  const near: number[] = []
  for (const [day, rateList] of byDay) if (day <= 9) near.push(...rateList)
  const spot = near.length > 0 ? pyMedian(near) : nodes[0]![1]
  const forward = (years: number): number => {
    const target = years * 365.0
    if (target <= days[0]!) return nodes[0]![1]
    if (target >= days[days.length - 1]!) return nodes[nodes.length - 1]![1]
    const upper = bisectRight(days, target)
    const [dayLow, rateLow] = nodes[upper - 1]!
    const [dayHigh, rateHigh] = nodes[upper]!
    const weight = (target - dayLow) / (dayHigh - dayLow)
    return rateLow + weight * (rateHigh - rateLow)
  }
  return [spot, forward]
}

/** Domestic discount factor implied by the base DF and the observed forward curve (`implied_df`). */
export const impliedDf = (dfBase: DiscountFn, spot: number, forward: DiscountFn): DiscountFn => (years) => (dfBase(years) * spot) / forward(years)

/** Whether the option is a call on the base, from the currency bought and sold (`_option_is_call`). */
export function optionIsCall(callCcy: string, putCcy: string, base: string, quote: string): boolean | null {
  if (callCcy === base || putCcy === quote) return true
  if (putCcy === base || callCcy === quote) return false
  return null
}

export type VanillaOption = { tenor_days: number; strike: number; premium: number; is_call: boolean }
export type PricedOption = VanillaOption & { implied_vol: number }

/** A pair's options of the family reduced to strike, tenor and premium per unit (`extract_vanilla_options`). */
export function extractVanillaOptions(records: Iterable<SliceRecord>, base: string, quote: string, asOf: D, spot: number, family = 'NA/O Van '): VanillaOption[] {
  const options: VanillaOption[] = []
  for (const record of records) {
    const fisn = sf(record, 'UPI FISN')
    if (!fisn.startsWith(family)) continue
    if (!pairMatches(fisn, base, quote)) continue
    if (sf(record, 'Action type') !== 'NEWT') continue
    if (sf(record, 'Event type') !== 'TRAD') continue
    if ((record['Execution Timestamp'] ?? '').slice(0, 10) !== asOf) continue
    let [strike] = parseNotional(record['Strike Price'])
    if (!strike) [strike] = parseNotional(record['Exchange rate'])
    const [premium] = parseNotional(record['Option Premium Amount'])
    const premiumCcy = sf(record, 'Option Premium Currency')
    const expiration = parseDate(record['Expiration Date'])
    const callCcy = sf(record, 'Call currency')
    const putCcy = sf(record, 'Put currency')
    const [callAmount] = parseNotional(record['Call amount'])
    const [putAmount] = parseNotional(record['Put amount'])
    const isCall = optionIsCall(callCcy, putCcy, base, quote)
    let baseNotional: number | null
    if (callCcy === base) baseNotional = callAmount
    else if (putCcy === base) baseNotional = putAmount
    else {
      const [first] = parseNotional(record['Notional amount-Leg 1'])
      const [second] = parseNotional(record['Notional amount-Leg 2'])
      baseNotional = sf(record, 'Notional currency-Leg 1') === base ? first : second
    }
    if (!(strike && premium && expiration && baseNotional) || isCall === null) continue
    if (Math.abs(Math.log(1.0 / strike / spot)) < Math.abs(Math.log(strike / spot))) strike = 1.0 / strike
    const tenorDays = diffDays(expiration, asOf)
    if (tenorDays <= 0) continue
    let perUnit = premium / baseNotional
    if (premiumCcy === base) perUnit *= spot
    else if (premiumCcy !== quote) continue
    options.push({ tenor_days: tenorDays, strike, premium: perUnit, is_call: isCall })
  }
  return options
}

/** An implied volatility attached to each out-of-the-money priceable option (`price_options`). */
export function priceOptions(options: VanillaOption[], spot: number, dfQuote: DiscountFn, dfBase: DiscountFn): PricedOption[] {
  const priced: PricedOption[] = []
  for (const option of options) {
    const years = option.tenor_days / 365.0
    const discQuote = dfQuote(years)
    const discBase = dfBase(years)
    const rDom = -Math.log(discQuote) / years
    const rFor = -Math.log(discBase) / years
    const forward = (spot * discBase) / discQuote
    const strike = option.strike
    if ((option.is_call && strike < forward) || (!option.is_call && strike > forward)) continue
    const vol = impliedVol(option.premium, spot, strike, years, rDom, rFor, option.is_call)
    if (vol === null) continue
    priced.push({ ...option, implied_vol: vol })
  }
  return priced
}

/** An option's tenor labelled by the FX bucket it falls in (`_tenor_of`). */
export function tenorOf(days: number): string | null {
  for (const [label, low, high] of fxTenorBuckets) if (label !== 'SPOT' && low <= days && days <= high) return label
  return null
}

/** Decimal places to round a strike price to, one past the pip (`_price_decimals`). */
const priceDecimals = (pip: number): number => String(Math.trunc(pip)).length

const snapTo = (grid: number[], value: number): number => {
  let best = grid[0]!
  for (const g of grid) if (Math.abs(g - value) < Math.abs(best - value)) best = g
  return best
}

const snapOffset = (pips: number): number | null => (Math.abs(pips) > STRIKE_MAX_OFFSET ? null : snapTo(STRIKE_OFFSETS, pips))
const snapMoneyness = (bp: number): number | null => (Math.abs(bp) > MONEYNESS_MAX_OFFSET ? null : snapTo(MONEYNESS_OFFSETS, bp))
const gridOffsets = (moneyness: boolean): number[] => (moneyness ? MONEYNESS_OFFSETS : STRIKE_OFFSETS)
const snapStrike = (strike: number, spot: number, pip: number, moneyness: boolean): number | null => (moneyness ? snapMoneyness((strike / spot - 1.0) * 10_000.0) : snapOffset((strike - spot) * pip))
const offsetStrike = (offset: number, spot: number, pip: number, moneyness: boolean): number => (moneyness ? spot * (1.0 + offset / 10_000.0) : spot + offset / pip)
const tenorColumn = (label: string): string => `vol_${label.toLowerCase()}`
const bucketLabels = (): string[] => fxTenorBuckets.filter(([label]) => label !== 'SPOT').map(([label]) => label)

/** Empirical vol surface: median vol per strike offset and expiry (`vol_surface`). */
export function volSurface(priced: PricedOption[], spot: number, pip: number, moneyness = false): Rec[] {
  const tenors = bucketLabels()
  const decimals = priceDecimals(pip)
  const byTenor = new Map<string, [number, number][]>()
  for (const option of priced) {
    const tenor = tenorOf(option.tenor_days)
    const offset = snapStrike(option.strike, spot, pip, moneyness)
    if (tenor === null || offset === null) continue
    if (!byTenor.has(tenor)) byTenor.set(tenor, [])
    byTenor.get(tenor)!.push([offset, option.implied_vol])
  }
  const cells = new Map<number, Map<string, number[]>>()
  for (const [tenor, points] of byTenor) {
    const ref = pyMedian(points.map(([, vol]) => vol))
    const low = VOL_TRIM_MIN * ref
    const high = VOL_TRIM_MAX * ref
    for (const [offset, vol] of points) {
      if (low <= vol && vol <= high) {
        if (!cells.has(offset)) cells.set(offset, new Map())
        const row = cells.get(offset)!
        if (!row.has(tenor)) row.set(tenor, [])
        row.get(tenor)!.push(vol)
      }
    }
  }
  const rows: Rec[] = []
  for (const offset of [...cells.keys()].sort((a, b) => a - b)) {
    const row: Rec = { strike: pyRound(offsetStrike(offset, spot, pip, moneyness), decimals), strike_offset: offset }
    let numOptions = 0
    for (const tenor of tenors) {
      const vols = cells.get(offset)!.get(tenor)
      row[tenorColumn(tenor)] = vols && vols.length > 0 ? pyMedian(vols) : null
      numOptions += vols ? vols.length : 0
    }
    row.num_options = numOptions
    rows.push(row)
  }
  return rows
}

export type SabrFit = { forward: number; years: number; alpha: number; rho: number; nu: number }

/** SABR-fitted vol surface on the strike grid (`theoretical_surface`). */
export function theoreticalSurface(priced: PricedOption[], spot: number, dfQuote: DiscountFn, dfBase: DiscountFn, pip: number, moneyness = false): [Rec[], Record<string, SabrFit>] {
  const tenors = bucketLabels()
  const decimals = priceDecimals(pip)
  const byTenor = new Map<string, PricedOption[]>()
  for (const option of priced) {
    const tenor = tenorOf(option.tenor_days)
    if (tenor === null) continue
    if (!byTenor.has(tenor)) byTenor.set(tenor, [])
    byTenor.get(tenor)!.push(option)
  }
  const fits: Record<string, SabrFit> = {}
  for (const [tenor, options] of byTenor) {
    const years = pyMedian(options.map((o) => o.tenor_days)) / 365.0
    const forward = (spot * dfBase(years)) / dfQuote(years)
    const ref = pyMedian(options.map((o) => o.implied_vol))
    const low = VOL_TRIM_MIN * ref
    const high = VOL_TRIM_MAX * ref
    const pts = options.filter((o) => low <= o.implied_vol && o.implied_vol <= high).map((o) => [o.strike, o.implied_vol] as [number, number])
    const near = pts.filter(([strike]) => Math.abs(strike / forward - 1.0) < 0.015).map(([, v]) => v)
    const fit = calibrateSabr(forward, years, near.length > 0 ? pyMedian(near) : ref, pts)
    if (fit !== null) {
      const [alpha, rho, nu] = fit
      fits[tenor] = { forward, years, alpha, rho, nu }
    }
  }
  const rows: Rec[] = []
  for (const offset of gridOffsets(moneyness)) {
    const strike = offsetStrike(offset, spot, pip, moneyness)
    const row: Rec = { strike: pyRound(strike, decimals), strike_offset: offset }
    let numFits = 0
    for (const tenor of tenors) {
      const fit = fits[tenor]
      if (fit === undefined) {
        row[tenorColumn(tenor)] = null
        continue
      }
      row[tenorColumn(tenor)] = sabrVol(fit.forward, strike, fit.years, fit.alpha, fit.rho, fit.nu)
      numFits++
    }
    row.num_options = numFits
    rows.push(row)
  }
  return [rows, fits]
}

