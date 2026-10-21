// The Deribit options optimizer: every combo structure an expiration can form, sized to a capital at risk and ranked
// against a view on the underlying. Ported from openbb_deribit/utils/options/optimizer.py and legs.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: positions and legs are plain objects, Python's frozenset keys are sorted
// text, and `math.erf` (absent from JavaScript) is a port of the C library's. Python's `min`, `max` and `sum` keep
// their treatment of NaN and their rounding. Ranking positions whose value is NaN (a contract with a mark of None,
// which Deribit does not publish) is stable here, while Python's sort orders such keys however its runs fall out.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { expirations, farExpiration, isInverse, loadCombos, nearestExpiration, parseDate, quotesAt, type ComboBook, type Contract, type Quote } from './chain.js'
import { erf } from './erf.js'
import { chainOr404 } from './strategies.js'

const PROBE_STEPS = 400
const PROBE_SPREAD = 0.6
const SCOUT_STEPS = 300
const WINDOW_PAD = 0.06
const MIN_PAD = 0.0025
const FLAT_SLOPE = 0.02
const ANCHOR_REACH = 0.35
const SHORTLIST = 40
const WING_REACH = 4
const STRIKE_WINDOW = 0.35
const STRESS_MOVE = 3.0
const STRESS_STEPS = 60
const DIAGONAL_REACH = 3

const NAMES: Record<string, string> = {
  'C|1': 'Long Call',
  'C|-1': 'Short Call',
  'P|1': 'Long Put',
  'P|-1': 'Short Put',
  'CS|1': 'Bull Call Spread',
  'CS|-1': 'Bear Call Spread',
  'PS|1': 'Bear Put Spread',
  'PS|-1': 'Bull Put Spread',
  'STRD|1': 'Long Straddle',
  'STRD|-1': 'Short Straddle',
  'STRG|1': 'Long Strangle',
  'STRG|-1': 'Short Strangle',
  'RR|1': 'Bearish Risk Reversal',
  'RR|-1': 'Bullish Risk Reversal',
  'REV|1': 'Synthetic Long',
  'REV|-1': 'Synthetic Short',
  'CSR12|1': 'Call Ratio Spread',
  'CSR12|-1': 'Call Backspread',
  'PSR12|1': 'Put Ratio Spread',
  'PSR12|-1': 'Put Backspread',
  'CBUT|1': 'Long Call Butterfly',
  'CBUT|-1': 'Short Call Butterfly',
  'PBUT|1': 'Long Put Butterfly',
  'PBUT|-1': 'Short Put Butterfly',
  'IBUT|1': 'Iron Butterfly',
  'IBUT|-1': 'Reverse Iron Butterfly',
  'CCOND|1': 'Long Call Condor',
  'CCOND|-1': 'Short Call Condor',
  'PCOND|1': 'Long Put Condor',
  'PCOND|-1': 'Short Put Condor',
  'ICOND|1': 'Iron Condor',
  'ICOND|-1': 'Reverse Iron Condor',
  'CCAL|1': 'Long Call Calendar',
  'CCAL|-1': 'Short Call Calendar',
  'PCAL|1': 'Long Put Calendar',
  'PCAL|-1': 'Short Put Calendar',
  'CDIAG|1': 'Long Call Diagonal',
  'CDIAG|-1': 'Short Call Diagonal',
  'PDIAG|1': 'Long Put Diagonal',
  'PDIAG|-1': 'Short Put Diagonal',
}

// ---- Python's number builtins ----

/** `max(a, b)`: the first, unless the second is greater (a NaN second never is). */
const max2 = (a: number, b: number): number => (b > a ? b : a)

/** `min(values)`: the first, unless a later one is smaller. */
function minOf(values: number[]): number {
  if (values.length === 0) throw new Error('min() iterable argument is empty')
  let m = values[0]!
  for (const v of values) if (v < m) m = v
  return m
}

/** `max(values)`. */
function maxOf(values: number[]): number {
  if (values.length === 0) throw new Error('max() iterable argument is empty')
  let m = values[0]!
  for (const v of values) if (v > m) m = v
  return m
}

/**
 * `sum()` of floats. Python 3.12 adds them with Neumaier's compensated summation, which can differ from a plain
 * left-to-right sum in the last bit; it starts from the integer 0, which turns a first -0.0 into 0.0.
 */
export function pySum(values: number[]): number {
  if (values.length === 0) return 0
  let total = 0 + values[0]!
  let compensation = 0
  for (let i = 1; i < values.length; i++) {
    const x = values[i]!
    const t = total + x
    if (Math.abs(total) >= Math.abs(x)) compensation += total - t + x
    else compensation += x - t + total
    total = t
  }
  // Not for an infinite or overflowed sum, which the compensation would turn into NaN.
  if (compensation && Number.isFinite(compensation)) total += compensation
  return total
}

/** `statistics.NormalDist().cdf`. */
const normalCdf = (x: number): number => 0.5 * (1.0 + erf((x - 0.0) / (1.0 * Math.SQRT2)))

// ---- legs.py ----

/** One contract of a position: the unit leg, or the leg scaled by a number of lots. */
type Leg = {
  symbol: string
  expiration: string
  strike: number
  option_type: string
  quantity: number
  size: number
  price: number
  dte: number
  /** As a decimal; null where the chain has no volatility at all, NaN where only this contract has none. */
  implied_volatility: number | null
}

const isCall = (optionType: string): boolean => optionType.startsWith('c')

/** `intrinsic`: the exercise value of one unit of the underlying. */
const intrinsic = (price: number, strike: number, optionType: string): number => (isCall(optionType) ? max2(0.0, price - strike) : max2(0.0, strike - price))

/** `option_value`: one unit of the underlying valued off its forward. */
function optionValue(forward: number, strike: number, years: number, sigma: number, discount: number, optionType: string): number {
  if (years <= 0 || sigma <= 0 || forward <= 0 || strike <= 0) return discount * intrinsic(forward, strike, optionType)
  const deviation = sigma * Math.sqrt(years)
  const d1 = (Math.log(forward / strike) + 0.5 * (sigma * sigma) * years) / deviation
  const d2 = d1 - deviation
  if (isCall(optionType)) return discount * (forward * normalCdf(d1) - strike * normalCdf(d2))
  return discount * (strike * normalCdf(-d2) - forward * normalCdf(-d1))
}

/** `leg_value`: what one unit of a leg is worth at a price. */
function legValue(leg: Leg, price: number, elapsed: number): number {
  const remaining = Math.trunc(leg.dte || 0) - elapsed
  // `not leg.get("implied_volatility")`: None and 0 are false, NaN is true.
  if (remaining <= 0 || leg.implied_volatility === null || leg.implied_volatility === 0) return intrinsic(price, leg.strike, leg.option_type)
  return optionValue(price, leg.strike, remaining / 365, leg.implied_volatility, 1.0, leg.option_type)
}

/** `net_cost`: what a position costs to open; a credit is negative. */
const netCost = (legs: Leg[]): number => pySum(legs.map((leg) => leg.quantity * leg.size * leg.price))

/** `position_value`. */
const positionValue = (legs: Leg[], price: number, elapsed: number): number => pySum(legs.map((leg) => leg.quantity * leg.size * legValue(leg, price, elapsed)))

/** `payoff`: the profit and loss of a position across prices, in the quote currency. */
function payoff(legs: Leg[], prices: number[], elapsed: number, inverse: boolean, entryPrice: number | null, cost: number | null): number[] {
  const entry = cost === null ? netCost(legs) : cost
  if (!inverse) return prices.map((price) => positionValue(legs, price, elapsed) - entry)
  if (!entryPrice) throw new Error('An inverse position needs the price it was opened at, because its premium was paid in the coin at that price.')
  const paid = entry / entryPrice
  return prices.map((price) => positionValue(legs, price, elapsed) - paid * price)
}

/** `breakevens`: every price where a payoff crosses zero. */
function breakevens(prices: number[], values: number[]): number[] {
  const crossings: number[] = []
  for (let index = 1; index < values.length; index++) {
    if ((values[index - 1]! < 0) === (values[index]! < 0)) continue
    const low = values[index - 1]!
    const high = values[index]!
    const weight = low || high ? Math.abs(low) / (Math.abs(low) + Math.abs(high)) : 0
    crossings.push(prices[index - 1]! + weight * (prices[index]! - prices[index - 1]!))
  }
  return crossings
}

// ---- optimizer.py ----

type Position = {
  strategy: string
  code: string | null
  combo: string | null
  premium: number | null
  legs: Leg[]
}

type Scored = Position & { sized: Leg[]; lots: number; elapsed: number; unitCost: number; cost: number; expected: number }

/** `_leg`: one contract as a leg of a position, volatility as a decimal. */
function legOf(row: Quote, quantity: number): Leg {
  return {
    symbol: row.contract_symbol,
    expiration: row.expiration,
    strike: row.strike,
    option_type: row.option_type,
    quantity,
    size: row.contract_size || 1,
    price: quantity > 0 ? row.entry : row.exit,
    dte: Math.trunc(row.dte || 0),
    implied_volatility: row.implied_volatility === null ? null : row.implied_volatility / 100,
  }
}

/** `_describe`: the contracts a position trades and how many of each. */
function describe(legs: Leg[]): string {
  return legs
    .map((leg) => {
      const side = leg.quantity > 0 ? 'Buy' : 'Sell'
      const count = Math.abs(Math.trunc(leg.quantity))
      return count === 1 ? `${side} ${leg.symbol}` : `${side} ${count} ${leg.symbol}`
    })
    .join(' / ')
}

/** `_key`: what identifies a position, each contract and how much of it (a frozenset, so a repeated pair counts once). */
function keyOf(pairs: [string, number][]): string {
  return [...new Set(pairs.map(([name, amount]) => `${name}:${amount}`))].sort().join(' ')
}

const legsKey = (legs: Leg[]): string => keyOf(legs.map((leg) => [leg.symbol, Math.trunc(leg.quantity)]))

/** `_sign`: the direction of a quantity. */
const sign = (value: number): number => (value > 0 ? 1 : -1)

type Code = [string, number]

/** `_two_legs`: classify a two-legged position on one expiration. */
function twoLegs(first: Leg, second: Leg): Code {
  const kinds = new Set([first.option_type[0], second.option_type[0]])
  if (kinds.size === 2) {
    const [call, put] = first.option_type[0] === 'c' ? [first, second] : [second, first]
    if (Math.abs(call.quantity) !== 1 || Math.abs(put.quantity) !== 1) return ['', 1]
    const together = call.quantity === put.quantity
    if (put.strike === call.strike) return together ? ['STRD', sign(call.quantity)] : ['REV', sign(call.quantity)]
    if (put.strike < call.strike) return together ? ['STRG', sign(call.quantity)] : ['RR', sign(put.quantity)]
    return ['', 1]
  }
  const [low, high] = [first, second].sort((a, b) => a.strike - b.strike)
  const kind = low!.option_type[0] === 'c' ? 'C' : 'P'
  const units: [number, number] = [Math.trunc(low!.quantity), Math.trunc(high!.quantity)]
  if (low!.strike === high!.strike) return ['', 1]
  const is = (a: [number, number]): boolean => units[0] === a[0] && units[1] === a[1]
  if (is([1, -1]) || is([-1, 1])) return [`${kind}S`, sign(kind === 'C' ? units[0] : units[1])]
  const ratios: Record<string, [number, number][]> = { C: [[1, -2], [-1, 2]], P: [[-2, 1], [2, -1]] }
  const wanted = ratios[kind]!
  if (is(wanted[0]!) || is(wanted[1]!)) return [`${kind}SR12`, is(wanted[0]!) ? 1 : -1]
  return ['', 1]
}

/** `classify`: the Deribit combo code of a position and the side it is taken on; an unrecognised position has an empty code. */
export function classify(legs: Leg[]): Code {
  const terms = [...new Set(legs.map((leg) => Math.trunc(leg.dte)))].sort((a, b) => a - b)
  const ordered = [...legs].sort((a, b) => a.strike - b.strike || (a.option_type < b.option_type ? -1 : a.option_type > b.option_type ? 1 : 0))
  const kinds = new Set(legs.map((leg) => leg.option_type[0]))

  if (legs.length === 1) return [legs[0]!.option_type[0] === 'c' ? 'C' : 'P', sign(legs[0]!.quantity)]

  if (terms.length === 2 && legs.length === 2 && kinds.size === 1) {
    const [near, far] = [...legs].sort((a, b) => a.dte - b.dte) as [Leg, Leg]
    const kind = near.option_type[0] === 'c' ? 'C' : 'P'
    if (near.quantity !== -far.quantity || Math.abs(far.quantity) !== 1) return ['', 1]
    const shape = near.strike === far.strike ? 'CAL' : 'DIAG'
    return [`${kind}${shape}`, sign(far.quantity)]
  }

  if (terms.length !== 1) return ['', 1]
  if (legs.length === 2) return twoLegs(legs[0]!, legs[1]!)

  const units = ordered.map((leg) => Math.trunc(leg.quantity))
  const strikes = ordered.map((leg) => leg.strike)
  const same = (a: number[]): boolean => a.length === units.length && a.every((x, i) => x === units[i])

  if (legs.length === 3 && kinds.size === 1 && new Set(strikes).size === 3) {
    const kind = ordered[0]!.option_type[0] === 'c' ? 'C' : 'P'
    const even = strikes[1]! - strikes[0]! === strikes[2]! - strikes[1]!
    if (even && (same([1, -2, 1]) || same([-1, 2, -1]))) return [`${kind}BUT`, units[0]!]
  }

  if (legs.length === 4 && kinds.size === 1 && new Set(strikes).size === 4) {
    const kind = ordered[0]!.option_type[0] === 'c' ? 'C' : 'P'
    if (same([1, -1, -1, 1]) || same([-1, 1, 1, -1])) return [`${kind}COND`, units[0]!]
  }

  if (legs.length === 4 && kinds.size === 2) {
    const puts = legs.filter((leg) => leg.option_type[0] === 'p').sort((a, b) => a.strike - b.strike)
    const calls = legs.filter((leg) => leg.option_type[0] === 'c').sort((a, b) => a.strike - b.strike)
    const putUnits = puts.map((leg) => Math.trunc(leg.quantity))
    const callUnits = calls.map((leg) => Math.trunc(leg.quantity))
    const shaped = (p: number[], c: number[]): boolean => p.length === putUnits.length && c.length === callUnits.length && p.every((x, i) => x === putUnits[i]) && c.every((x, i) => x === callUnits[i])
    if (puts.length === 2 && puts[1]!.strike <= calls[0]!.strike) {
      const body = puts[1]!.strike === calls[0]!.strike ? 'IBUT' : 'ICOND'
      if (shaped([1, -1], [-1, 1])) return [body, 1]
      if (shaped([-1, 1], [1, -1])) return [body, -1]
    }
  }

  return ['', 1]
}

/** The listed combos by the legs that make them up (`combo_book`): each one's name and what a unit costs in the quote currency. */
type Book = Map<string, [string, number]>

/** `combo_book`: each listed combo's price, bought at its offer and sold at its bid. */
function comboBook(books: ComboBook[], spot: number, inverse: boolean): Book {
  const carry = inverse ? spot : 1.0
  const lookup: Book = new Map()
  for (const book of books) {
    const bought = keyOf(book.legs)
    const sold = keyOf(book.legs.map(([name, amount]) => [name, -amount]))
    if (book.ask !== null) lookup.set(bought, [book.name, Number(book.ask) * carry])
    if (book.bid !== null) lookup.set(sold, [book.name, -Number(book.bid) * carry])
  }
  return lookup
}

/** `_position`: one position from contracts and quantities, priced off a combo book. */
function position(pairs: [Quote, number][], book: Book): Position {
  const legs = pairs.map(([row, quantity]) => legOf(row, quantity))
  const [code, side] = classify(legs)
  const listed = book.get(legsKey(legs))
  return {
    strategy: NAMES[`${code}|${side}`] ?? 'Custom',
    code: code || null,
    combo: listed ? listed[0] : null,
    premium: listed ? listed[1] * legs[0]!.size : null,
    legs,
  }
}

/** `_both`: a position bought and the same position sold. */
const both = (pairs: [Quote, number][], book: Book): Position[] => [position(pairs, book), position(pairs.map(([row, quantity]) => [row, -quantity] as [Quote, number]), book)]

/** `_spaced`: every pair of strikes, lower first. */
function spaced<T>(rows: T[]): [T, T][] {
  const out: [T, T][] = []
  rows.forEach((low, index) => {
    for (const high of rows.slice(index + 1)) out.push([low, high])
  })
  return out
}

/** `_single_expiry`: every structure that trades one expiration. */
function singleExpiry(calls: Quote[], puts: Quote[], book: Book): Position[] {
  const built: Position[] = []
  const callAt = new Map(calls.map((row) => [row.strike, row]))
  const putAt = new Map(puts.map((row) => [row.strike, row]))

  for (const r of [...calls, ...puts]) built.push(...both([[r, 1]], book))

  for (const [low, high] of spaced(calls)) {
    built.push(...both([[low, 1], [high, -1]], book))
    built.push(...both([[low, 1], [high, -2]], book))
  }

  for (const [low, high] of spaced(puts)) {
    built.push(...both([[high, 1], [low, -1]], book))
    built.push(...both([[high, 1], [low, -2]], book))
  }

  for (const [strike, call] of callAt) {
    const put = putAt.get(strike)
    if (put) {
      built.push(...both([[call, 1], [put, 1]], book))
      built.push(...both([[call, 1], [put, -1]], book))
    }
  }

  for (const put of puts) {
    for (const call of calls) {
      if (put.strike < call.strike) {
        built.push(...both([[put, 1], [call, 1]], book))
        built.push(...both([[put, 1], [call, -1]], book))
      }
    }
  }

  for (const [rows, at] of [[calls, callAt], [puts, putAt]] as [Quote[], Map<number, Quote>][]) {
    for (const [low, middle] of spaced(rows)) {
      const width = middle.strike - low.strike
      const high = at.get(middle.strike + width)
      if (high !== undefined) built.push(...both([[low, 1], [middle, -2], [high, 1]], book))
    }

    rows.forEach((first, index) => {
      for (const second of rows.slice(index + 1, index + 1 + WING_REACH)) {
        const wing = second.strike - first.strike
        for (const third of rows) {
          const fourth = at.get(third.strike + wing)
          if (third.strike > second.strike && fourth) built.push(...both([[first, 1], [second, -1], [third, -1], [fourth, 1]], book))
        }
      }
    })
  }

  puts.forEach((low, index) => {
    for (const high of puts.slice(index + 1, index + 1 + WING_REACH)) {
      const wing = high.strike - low.strike
      for (const call of calls) {
        const upper = callAt.get(call.strike + wing)
        if (call.strike >= high.strike && upper) built.push(...both([[low, 1], [high, -1], [call, -1], [upper, 1]], book))
      }
    }
  })

  return built
}

/** `_two_expiries`: every calendar and diagonal between two expirations. */
function twoExpiries(near: Quote[], far: Quote[], book: Book): Position[] {
  const built: Position[] = []
  for (const kind of ['call', 'put']) {
    const later = far.filter((row) => row.option_type === kind)
    for (const row of near.filter((r) => r.option_type === kind)) {
      let position: number | undefined
      for (let index = 0; index < later.length; index++) {
        if (position === undefined || Math.abs(later[index]!.strike - row.strike) < Math.abs(later[position]!.strike - row.strike)) position = index
      }
      if (position === undefined) continue
      const reach = later.slice(Math.max(position - DIAGONAL_REACH, 0), position + DIAGONAL_REACH + 1)
      for (const other of reach) built.push(...both([[row, -1], [other, 1]], book))
    }
  }
  return built
}

/** `_window_rows`: the tradeable contracts near the money, by strike. */
function windowRows(quotes: Quote[], spot: number): Quote[] {
  return quotes.filter((q) => q.strike >= spot * (1 - STRIKE_WINDOW) && q.strike <= spot * (1 + STRIKE_WINDOW)).sort((a, b) => a.strike - b.strike)
}

/** `candidates`: every combo structure an expiration can form, bought and sold. */
function candidates(frame: Contract[], expiration: string, spot: number, books: ComboBook[], inverse: boolean): Position[] {
  const book = comboBook(books, spot, inverse)
  const near = windowRows(quotesAt(frame, expiration), spot)
  const calls = near.filter((row) => row.option_type === 'call')
  const puts = near.filter((row) => row.option_type === 'put')
  const built = singleExpiry(calls, puts, book)
  const later = farExpiration(frame, expiration)
  if (later !== undefined) built.push(...twoExpiries(near, windowRows(quotesAt(frame, later), spot), book))

  const tradeable = new Map(quotesAt(frame).map((row) => [row.contract_symbol, row]))
  for (const listed of books) {
    const rows = listed.legs.flatMap(([name]) => (tradeable.has(name) ? [tradeable.get(name)!] : []))
    if (rows.length !== listed.legs.length) continue
    if (rows.length === 0) throw new Error('min() iterable argument is empty')
    if (rows.reduce((first, row) => (row.expiration < first ? row.expiration : first), rows[0]!.expiration) !== expiration) continue
    built.push(...both(rows.map((row, i) => [row, listed.legs[i]![1]] as [Quote, number]), book))
  }

  const unique = new Map<string, Position>()
  for (const item of built) {
    const key = legsKey(item.legs)
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()]
}

/** `_grid`: an evenly spaced range of prices. */
const grid = (low: number, high: number, steps: number): number[] => Array.from({ length: steps + 1 }, (_, step) => low + ((high - low) * step) / steps)

/** `_stress`: the prices a position's worst loss is sought over. */
function stress(legs: Leg[], spot: number, elapsed: number): number[] {
  const low = spot / STRESS_MOVE
  const high = spot * STRESS_MOVE
  const points = new Set<number>([low, spot, high, ...legs.map((leg) => leg.strike)])
  if (legs.some((leg) => Math.trunc(leg.dte || 0) > elapsed)) for (const p of grid(low, high, STRESS_STEPS)) points.add(p)
  return [...points].filter((p) => low <= p && p <= high).sort((a, b) => a - b)
}

/** `score`: size one position to one unit of capital at risk and value it at the target; undefined where nothing is at risk. */
function score(strategy: Position, spot: number, target: number, inverse: boolean): Scored | undefined {
  const legs = strategy.legs
  const unitCost = strategy.premium === null ? netCost(legs) : strategy.premium
  const elapsed = max2(minOf(legs.map((leg) => Math.trunc(leg.dte || 0))), 0)
  const points = stress(legs, spot, elapsed)
  let losses = payoff(legs, points, elapsed, inverse, spot, unitCost)
  if (inverse) losses = losses.map((loss, i) => (loss / points[i]!) * spot)
  const risk = -minOf(losses)
  if (risk <= 0) return undefined
  const lots = 1.0 / risk
  const sized = legs.map((leg) => ({ ...leg, quantity: leg.quantity * lots }))
  const expected = payoff(sized, [target], elapsed, inverse, spot, unitCost * lots)[0]!
  return { ...strategy, sized, lots, elapsed, unitCost, cost: unitCost * lots, expected }
}

/** `_moving`: the price range over which a payoff is still changing. */
function moving(prices: number[], curve: number[]): [number, number] {
  const slopes: number[] = []
  for (let step = 1; step < prices.length; step++) {
    const run = prices[step]! - prices[step - 1]!
    if (run === 0) throw new Error('float division by zero')
    slopes.push(Math.abs((curve[step]! - curve[step - 1]!) / run))
  }
  const steepest = maxOf(slopes)
  const steps = slopes.flatMap((slope, step) => (slope > steepest * FLAT_SLOPE ? [step] : []))
  if (steps.length === 0) return [prices[0]!, prices[prices.length - 1]!]
  return [prices[steps[0]!]!, prices[steps[steps.length - 1]! + 1]!]
}

/** `_window`: the price range worth drawing for one position. */
function window(legs: Leg[], spot: number, target: number, elapsed: number, inverse: boolean, cost: number): [number, number] {
  const scout = grid(spot * (1 - PROBE_SPREAD), spot * (1 + PROBE_SPREAD), SCOUT_STEPS)
  const curve = payoff(legs, scout, elapsed, inverse, spot, cost)
  let [low, high] = moving(scout, scout.map((price) => positionValue(legs, price, elapsed)))
  const anchors = [target, ...breakevens(scout, curve)]
  if (low <= scout[0]!) {
    const below = anchors.filter((anchor) => anchor < high)
    low = minOf(below.length ? below : [spot])
  }
  if (high >= scout[scout.length - 1]!) {
    const above = anchors.filter((anchor) => anchor > low)
    high = maxOf(above.length ? above : [spot])
  }
  const reach = max2(high - low, spot * MIN_PAD) * ANCHOR_REACH
  const nearby = anchors.filter((anchor) => low - reach <= anchor && anchor <= high + reach)
  low = minOf([low, ...nearby])
  high = maxOf([high, ...nearby])
  const pad = max2((high - low) * WINDOW_PAD, spot * MIN_PAD)
  return [max2(low - pad, 0.0), high + pad]
}

/** `draw`: value one scored position across the price range worth drawing. */
function draw(scored: Scored, spot: number, target: number, budget: number, inverse: boolean): { row: Row; crossings: number[] } {
  const legs = scored.sized.map((leg) => ({ ...leg, quantity: leg.quantity * budget }))
  const cost = scored.cost * budget
  const [low, high] = window(legs, spot, target, scored.elapsed, inverse, cost)
  const probe = grid(low, high, PROBE_STEPS)
  const curve = payoff(legs, probe, scored.elapsed, inverse, spot, cost)
  const crossings = breakevens(probe, curve)
  return {
    crossings,
    row: {
      strategy: scored.strategy,
      code: scored.code,
      combo: scored.combo,
      legs: describe(scored.legs),
      contracts: scored.lots * budget,
      cost,
      expected_profit: scored.expected * budget,
      expected_return: scored.expected,
      max_profit: maxOf(curve),
      max_loss: minOf(curve),
    },
  }
}

/** `rank`: the best position of each structure, most profitable first. */
function rank(frame: Contract[], expiration: string, spot: number, target: number, budget: number, inverse: boolean, limit: number, books: ComboBook[]): { row: Row; crossings: number[] }[] {
  const scored: Scored[] = []
  for (const strategy of candidates(frame, expiration, spot, books, inverse)) {
    const result = score(strategy, spot, target, inverse)
    if (result) scored.push(result)
  }
  // list.sort(key=expected, reverse=True): stable, so equal returns keep the order they were built in.
  scored.sort((a, b) => (b.expected > a.expected ? 1 : b.expected < a.expected ? -1 : 0))
  const best = new Map<string, Scored>()
  for (const item of scored) if (!best.has(item.strategy)) best.set(item.strategy, item)
  return [...best.values()].slice(0, limit).map((item) => draw(item, spot, target, budget, inverse))
}

const optionalNumber = (params: NativeParams, name: string): number | undefined => {
  const v = params[name]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`${name} must be a number`)
  return n
}

/** `_ranked_row`: one ranked strategy as a grid row (a missing value is left out). */
function rankedRow({ row, crossings }: { row: Row; crossings: number[] }): Row {
  const out: Row = {
    ...row,
    breakeven_lower: crossings.length ? crossings[0] : null,
    breakeven_upper: crossings.length > 1 ? crossings[crossings.length - 1] : null,
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))))
}

// deribit/options/optimizer (command, no provider). Ported from openbb_deribit/routers/options.py (optimizer, _ranked_row)
// and utils/options/chain.py (load_combos): rank every combo structure against a view on the underlying; modified:
// see the top of the file.
export async function optionsOptimizer(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? 'BTC')
  const targetPrice = optionalNumber(params, 'target_price')
  const budget = optionalNumber(params, 'budget') ?? 5000.0
  const limitParam = optionalNumber(params, 'limit')
  const limit = limitParam === undefined ? SHORTLIST : Math.trunc(limitParam)
  // A date spelled any way but ISO is pandas' to read: refuse before any request.
  const targetDate = params.target_date === undefined || params.target_date === null || params.target_date === '' ? undefined : parseDate(String(params.target_date))

  const { frame, spot } = await chainOr404(ctx, symbol)
  const inverse = isInverse(frame)
  const target = targetPrice ? targetPrice : spot
  const expiration = nearestExpiration(frame, targetDate ?? expirations(frame)[0]!)
  const books = await loadCombos(ctx, symbol)
  return rank(frame, expiration, spot, target, budget, inverse, limit, books).map(rankedRow)
}
