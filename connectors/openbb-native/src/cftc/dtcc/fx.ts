// FX forward point construction from DTCC PPD records. Ported from openbb_cftc/utils/fx.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: dates are ISO strings.
import { fxPairs, fxTenorBuckets, type FxSpec } from './constants.js'
import { parseDate, parseNotional, percentile, recordTradeDate, type Rec, type SliceRecord } from './curve.js'
import { diffDays, type D } from './dates.js'
import { commaFixed, pyMedian, pySum } from './num.js'

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/** Units of quote per unit of base, derived from the leg notionals (`pair_rate`). */
export function pairRate(record: SliceRecord, base: string, quote: string): number | null {
  const [first] = parseNotional(record['Notional amount-Leg 1'])
  const [second] = parseNotional(record['Notional amount-Leg 2'])
  const firstCcy = sf(record, 'Notional currency-Leg 1')
  const secondCcy = sf(record, 'Notional currency-Leg 2')
  if (!first || !second) return null
  if (firstCcy === base && secondCcy === quote) return second / first
  if (secondCcy === base && firstCcy === quote) return first / second
  return null
}

/** The trade's notional expressed in the base currency (`base_notional`). */
export function baseNotional(record: SliceRecord, base: string): number | null {
  const [first] = parseNotional(record['Notional amount-Leg 1'])
  const [second] = parseNotional(record['Notional amount-Leg 2'])
  if (sf(record, 'Notional currency-Leg 1') === base) return first
  if (sf(record, 'Notional currency-Leg 2') === base) return second
  return null
}

/** A pair's canonical key and its spec (`resolve_pair`). */
export function resolvePair(pair: string): [string, FxSpec] {
  const key = (pair || '').trim().toUpperCase()
  const spec = fxPairs[key]
  if (!spec) throw new Error(`Invalid pair: '${pair}'. Valid pairs are: ${Object.keys(fxPairs).join(', ')}`)
  return [key, spec]
}

export type FxObservation = { days: number; trade_date: D; rate: number; notional: number; is_swap: boolean }

/** A deliverable forward or FX swap reduced to an observation, or null (`_fx_observation`). */
function fxObservation(record: SliceRecord, tradeDate: D, spec: FxSpec, minNotional: number): FxObservation | null {
  const { base, quote } = spec
  const fisn = sf(record, 'UPI FISN')
  if (fisn !== spec.forward_fisn && fisn !== spec.swap_fisn) return null
  if (sf(record, 'Action type') !== 'NEWT') return null
  if (sf(record, 'Event type') !== 'TRAD') return null
  const rate = pairRate(record, base, quote)
  const expiration = parseDate(record['Expiration Date'])
  if (rate === null || rate <= 0 || expiration === null) return null
  const notional = baseNotional(record, base)
  if (notional === null || notional < minNotional) return null
  const days = diffDays(expiration, tradeDate)
  if (days < 0) return null
  return { days, trade_date: tradeDate, rate: !spec.invert ? rate : 1.0 / rate, notional, is_swap: fisn === spec.swap_fisn }
}

const CARRY_FLOOR = 0.03
const CARRY_PER_YEAR = 0.25

/** Largest log distance from spot a forward's carry can open over a tenor (`carry_bound`). */
export const carryBound = (days: number): number => CARRY_FLOOR + (CARRY_PER_YEAR * Math.max(days, 0)) / 365.0

/** The record's exchange rate, oriented to the pair's prevailing level (`_stated_rate`). */
function statedRate(record: SliceRecord, anchor: number): number | null {
  const [rate] = parseNotional(record['Exchange rate'])
  if (!rate || rate <= 0.0 || anchor <= 0.0) return null
  return Math.abs(Math.log(rate / anchor)) <= Math.abs(Math.log(1.0 / rate / anchor)) ? rate : 1.0 / rate
}

/** Deliverable forwards and FX swaps for a pair, above a notional floor (`extract_fx_observations`). */
export function extractFxObservations(records: Iterable<SliceRecord>, pair: string, tradeDate: D, minNotional = 1_000_000.0): FxObservation[] {
  const [, spec] = resolvePair(pair)
  const candidates: [SliceRecord, FxObservation][] = []
  for (const record of records) {
    const observation = fxObservation(record, tradeDate, spec, minNotional)
    if (observation !== null) candidates.push([record, observation])
  }
  if (candidates.length === 0) return []
  const anchor = pyMedian(candidates.map(([, o]) => o.rate))
  const observations: FxObservation[] = []
  for (const [record, observation] of candidates) {
    const stated = statedRate(record, anchor)
    const rate = stated !== null ? stated : observation.rate
    if (Math.abs(Math.log(rate / anchor)) <= carryBound(observation.days)) observations.push({ ...observation, rate })
  }
  return observations
}

/** A pair's trades, dating each against its own dissemination day (`extract_fx_observations_by_day`). */
export function extractFxObservationsByDay(records: Iterable<SliceRecord>, pair: string, minNotional = 1_000_000.0): FxObservation[] {
  const [, spec] = resolvePair(pair)
  const observations: FxObservation[] = []
  for (const record of records) {
    const tradeDate = recordTradeDate(record)
    if (tradeDate === null) continue
    const observation = fxObservation(record, tradeDate, spec, minNotional)
    if (observation !== null) observations.push(observation)
  }
  return observations
}

/** The tenor bucket a settlement horizon falls in (`_bucket_of`). */
export function bucketOf(days: number): string | null {
  for (const [label, low, high] of fxTenorBuckets) if (low <= days && days <= high) return label
  return null
}

/** Drop observations whose rate is an outlier within its own tenor bucket (`trim_fx_observations`). */
export function trimFxObservations(observations: FxObservation[]): FxObservation[] {
  const groups = new Map<string, FxObservation[]>()
  for (const o of observations) {
    const label = bucketOf(o.days)
    if (label === null) continue
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(o)
  }
  const kept: FxObservation[] = []
  for (const members of groups.values()) {
    if (members.length < 3) {
      kept.push(...members)
      continue
    }
    const ordered = members.map((m) => m.rate).sort((a, b) => a - b)
    const low = percentile(ordered, 5)
    const high = percentile(ordered, 95)
    kept.push(...members.filter((m) => low <= m.rate && m.rate <= high))
  }
  return kept
}

/** Proxy spot with the median of the shortest-dated trades, or null (`_spot_rate`). */
const spotRate = (observations: FxObservation[], spotMaxDays: number): number | null => {
  const rates = observations.filter((o) => o.days <= spotMaxDays).map((o) => o.rate)
  return rates.length > 0 ? pyMedian(rates) : null
}

/** A T+2 spot for a non-deliverable pair from its two shortest tenor buckets (`_ndf_spot`). */
function ndfSpot(observations: FxObservation[]): number | null {
  const buckets = new Map<string, FxObservation[]>()
  for (const o of observations) {
    const label = bucketOf(o.days)
    if (label === null) continue
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label)!.push(o)
  }
  const nodes: [number, number][] = []
  for (const [label] of fxTenorBuckets) {
    const members = buckets.get(label)
    if (members && members.length > 0) nodes.push([pyMedian(members.map((m) => m.days)), pyMedian(members.map((m) => m.rate))])
  }
  if (nodes.length === 0) return null
  if (nodes.length === 1) return nodes[0]![1]
  const [dayNear, rateNear] = nodes[0]!
  const [dayNext, rateNext] = nodes[1]!
  const slope = (rateNext - rateNear) / (dayNext - dayNear)
  return rateNear + slope * (2.0 - dayNear)
}

/** Spot from the shortest NDF tenor, or the near-dated trades of a deliverable pair (`_establish_spot`). */
const establishSpot = (observations: FxObservation[], spec: FxSpec, spotMaxDays: number): number | null => (spec.ndf ? ndfSpot(observations) : spotRate(observations, spotMaxDays))

/** Drop the stray trades inside the spot window of a non-deliverable pair (`_drop_ndf_spot_window`). */
const dropNdfSpotWindow = (observations: FxObservation[], spotMaxDays: number): FxObservation[] => observations.filter((o) => o.days > spotMaxDays)

/** A bucket's trades reduced to a forward rate and its distance from spot (`_point`). */
function point(label: string, tenorDays: number, members: FxObservation[], spot: number, spec: FxSpec, pair: string): Rec {
  const rates = members.map((m) => m.rate)
  const rate = pyMedian(rates)
  return {
    pair,
    tenor: label,
    tenor_days: tenorDays,
    spot_rate: spot,
    forward_rate: rate,
    forward_points: (rate - spot) * spec.pip,
    num_trades: members.length,
    total_notional: pySum(members.map((m) => m.notional)),
    min_rate: Math.min(...rates),
    max_rate: Math.max(...rates),
  }
}

/** A pair's spot rate and forward points per tenor bucket, on one day (`build_forward_points`). */
export function buildForwardPoints(records: Iterable<SliceRecord>, pair: string, tradeDate: D, o: { minNotional?: number; minTrades?: number; spotMaxDays?: number } = {}): Rec[] {
  const minNotional = o.minNotional ?? 1_000_000.0
  const minTrades = o.minTrades ?? 1
  const spotMaxDays = o.spotMaxDays ?? 2
  const [key, spec] = resolvePair(pair)
  let observations = extractFxObservations(records, key, tradeDate, minNotional)
  if (observations.length === 0) throw new Error(`No ${key} forwards or FX swaps at or above a ${commaFixed(minNotional, 0)} ${spec.base} notional were reported for ${tradeDate}.`)
  observations = trimFxObservations(observations)
  if (spec.ndf) observations = dropNdfSpotWindow(observations, spotMaxDays)
  const spot = establishSpot(observations, spec, spotMaxDays)
  if (spot === null) {
    const horizon = spec.ndf ? 'any tenor bucket' : `${spotMaxDays} days`
    throw new Error(`No ${key} trades inside ${horizon} were reported for ${tradeDate}, so spot cannot be established.`)
  }
  const groups = new Map<string, FxObservation[]>()
  for (const obs of observations) {
    const label = bucketOf(obs.days)
    if (label === null) continue
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(obs)
  }
  const results: Rec[] = []
  for (const [label, low] of fxTenorBuckets) {
    const members = groups.get(label)
    if (!members || members.length === 0 || members.length < minTrades) continue
    const p = point(label, low, members, spot, spec, key)
    p.date = tradeDate
    p.as_of_date = tradeDate
    p.staleness_days = 0
    results.push(p)
  }
  if (results.length === 0) throw new Error(`No ${key} tenor buckets had at least ${minTrades} trades on ${tradeDate}.`)
  return results
}

/** Forward points per tenor from that tenor's most recent qualifying day (`build_forward_points_as_of`). */
export function buildForwardPointsAsOf(records: Iterable<SliceRecord>, pair: string, o: { minNotional?: number; minTrades?: number; spotMaxDays?: number } = {}): Rec[] {
  const minNotional = o.minNotional ?? 1_000_000.0
  const minTrades = o.minTrades ?? 1
  const spotMaxDays = o.spotMaxDays ?? 2
  const [key, spec] = resolvePair(pair)
  let observations = extractFxObservationsByDay(records, key, minNotional)
  if (observations.length === 0) throw new Error(`No ${key} forwards or FX swaps at or above a ${commaFixed(minNotional, 0)} ${spec.base} notional were disseminated in the search window.`)
  if (spec.ndf) observations = dropNdfSpotWindow(observations, spotMaxDays)
  const byDay = new Map<D, FxObservation[]>()
  for (const obs of observations) {
    if (!byDay.has(obs.trade_date)) byDay.set(obs.trade_date, [])
    byDay.get(obs.trade_date)!.push(obs)
  }
  const spots = new Map<D, number>()
  const buckets = new Map<string, Map<D, FxObservation[]>>()
  for (const [day, raw] of byDay) {
    const members = trimFxObservations(raw)
    const spot = establishSpot(members, spec, spotMaxDays)
    if (spot === null) continue
    spots.set(day, spot)
    for (const obs of members) {
      const label = bucketOf(obs.days)
      if (label === null) continue
      if (!buckets.has(label)) buckets.set(label, new Map())
      const days = buckets.get(label)!
      if (!days.has(day)) days.set(day, [])
      days.get(day)!.push(obs)
    }
  }
  if (spots.size === 0) {
    const horizon = spec.ndf ? 'any tenor bucket' : `${spotMaxDays} days`
    throw new Error(`No ${key} trades inside ${horizon} were disseminated in the search window, so spot cannot be established.`)
  }
  const results: Rec[] = []
  for (const [label, low] of fxTenorBuckets) {
    const days = buckets.get(label)
    for (const day of [...(days?.keys() ?? [])].sort().reverse()) {
      const members = days!.get(day)!
      if (members.length < minTrades) continue
      const p = point(label, low, members, spots.get(day)!, spec, key)
      p.as_of_date = day
      results.push(p)
      break
    }
  }
  if (results.length === 0) throw new Error(`No ${key} tenor bucket had a single day with at least ${minTrades} trades in the search window.`)
  const freshest = results.map((p) => p.as_of_date as D).sort().at(-1)!
  for (const p of results) {
    p.date = freshest
    p.staleness_days = diffDays(freshest, p.as_of_date)
  }
  return results
}

/** A pair's forward points reoriented to the outright forward in the currency per USD (`_per_usd_curve`). */
function perUsdCurve(points: Rec[], pair: string): Rec[] {
  const invert = !pair.toUpperCase().startsWith('USD')
  return points.map((p) => {
    const forward = p.forward_rate as number
    const spot = p.spot_rate as number
    const low = p.min_rate as number
    const high = p.max_rate as number
    return {
      tenor: p.tenor,
      tenor_days: p.tenor_days,
      rate: invert ? 1.0 / forward : forward,
      spot: invert ? 1.0 / spot : spot,
      num_trades: p.num_trades,
      total_notional: p.total_notional,
      min_rate: invert ? 1.0 / high : low,
      max_rate: invert ? 1.0 / low : high,
      date: p.date,
      as_of_date: p.as_of_date,
      staleness_days: p.staleness_days,
    }
  })
}

/** Outright forward curve, the currency per USD, from one day's forward points (`build_fx_forward_curve`). */
export const buildFxForwardCurve = (records: Iterable<SliceRecord>, pair: string, tradeDate: D, o: { minNotional?: number; minTrades?: number } = {}): Rec[] => perUsdCurve(buildForwardPoints(records, pair, tradeDate, o), pair)

/** Outright forward curve, each tenor priced from its most recent qualifying day (`build_fx_forward_curve_as_of`). */
export const buildFxForwardCurveAsOf = (records: Iterable<SliceRecord>, pair: string, o: { minNotional?: number; minTrades?: number } = {}): Rec[] => perUsdCurve(buildForwardPointsAsOf(records, pair, o), pair)
