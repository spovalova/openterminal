// OIS forward policy-rate path from single-period forward-starting OIS. Ported from openbb_cftc/utils/policy.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are ISO strings.
import { pyRound } from '../helpers.js'
import { MAX_CURVE_DAYS } from './constants.js'
import { EmptyDataError, interpolateMonotone, isVanillaPar, median, parseDate, parseNotional, parseRate, percentile, recordTradeDate, type SliceRecord } from './curve.js'
import { diffDays, type D } from './dates.js'

export type ForwardObservation = {
  forward_days: number
  tenor_days: number
  rate: number
  as_of_date: D
  effective_date: D
  expiration_date: D
  notional: number | null
  is_capped: boolean
  day_count: string | null
}

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/** Forward-starting new OIS trades reduced to observations (`extract_forward_observations`). */
export function extractForwardObservations(records: Iterable<SliceRecord>, fisn: string, currency: string, curveDate: D, minForwardDays = 5): ForwardObservation[] {
  const observations: ForwardObservation[] = []
  for (const record of records) {
    if (sf(record, 'UPI FISN') !== fisn) continue
    if (sf(record, 'Action type') !== 'NEWT') continue
    if (sf(record, 'Event type') !== 'TRAD') continue
    if (sf(record, 'Notional currency-Leg 1') !== currency) continue
    if (!isVanillaPar(record)) continue
    const asOf = recordTradeDate(record) ?? curveDate
    const rate = parseRate(record)
    const effective = parseDate(record['Effective Date'])
    const expiration = parseDate(record['Expiration Date'])
    if (rate === null || effective === null || expiration === null) continue
    const forwardDays = diffDays(effective, curveDate)
    if (forwardDays <= minForwardDays) continue
    const tenorDays = diffDays(expiration, effective)
    if (!(0 < tenorDays && tenorDays <= MAX_CURVE_DAYS)) continue
    const [notional, capped] = parseNotional(record['Notional amount-Leg 1'])
    observations.push({
      forward_days: forwardDays,
      tenor_days: tenorDays,
      rate,
      as_of_date: asOf,
      effective_date: effective,
      expiration_date: expiration,
      notional,
      is_capped: capped,
      day_count: sf(record, 'Fixed rate day count convention-leg 1') || null,
    })
  }
  return observations
}

export type PolicyNode = {
  forward_days: number
  tenor_days: number
  rate: number
  min_rate: number
  max_rate: number
  num_trades: number
  as_of_date: D
  start_date: D
  end_date: D
  is_capped: boolean
  staleness_days: number
}

/** The policy-rate path: one node per forward start of single-period OIS (`build_policy_path`). */
export function buildPolicyPath(records: Iterable<SliceRecord>, fisn: string, currency: string, curveDate: D, minTrades = 3, maxPeriodDays = 55): PolicyNode[] {
  const observations = extractForwardObservations(records, fisn, currency, curveDate).filter((o) => 0 < o.tenor_days && o.tenor_days <= maxPeriodDays)
  if (observations.length === 0) throw new EmptyDataError(`No single-period forward-starting ${currency} OIS matching '${fisn}' was disseminated in the window; the currency may trade no meeting-dated OIS.`)
  const groups = new Map<D, ForwardObservation[]>()
  for (const o of observations) {
    if (!groups.has(o.effective_date)) groups.set(o.effective_date, [])
    groups.get(o.effective_date)!.push(o)
  }
  const nodes: Omit<PolicyNode, 'staleness_days'>[] = []
  for (const [effective, members] of groups) {
    if (members.length < minTrades) continue
    let rates = members.map((m) => m.rate).sort((a, b) => a - b)
    if (rates.length >= 5) {
      const low = percentile(rates, 5)
      const high = percentile(rates, 95)
      const kept = rates.filter((r) => low <= r && r <= high)
      rates = kept.length > 0 ? kept : rates
    }
    const expirations = members.map((m) => m.expiration_date).sort()
    const expiration = expirations[Math.floor(expirations.length / 2)]!
    nodes.push({
      forward_days: diffDays(effective, curveDate),
      tenor_days: diffDays(expiration, effective),
      rate: median(rates),
      min_rate: rates[0]!,
      max_rate: rates[rates.length - 1]!,
      num_trades: members.length,
      as_of_date: members.map((m) => m.as_of_date).sort().at(-1)!,
      start_date: effective,
      end_date: expiration,
      is_capped: members.some((m) => m.is_capped),
    })
  }
  if (nodes.length === 0) throw new EmptyDataError(`No forward start cleared min_trades (currently ${minTrades}). Lower min_trades, or widen the window.`)
  const reference = nodes.map((n) => n.as_of_date).sort().at(-1)!
  const out = nodes.map((n) => ({ ...n, staleness_days: diffDays(reference, n.as_of_date) }))
  out.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0))
  return out
}

export type GridPoint = { tenor_years: number; tenor_days: number; forward_rate: number; forward_extrapolated: boolean; num_trades: number }

/** Forward par rates read from observed forward-starting swaps of the target tenor (`observed_forward_grid`). */
export function observedForwardGrid(
  records: Iterable<SliceRecord>,
  fisn: string,
  currency: string,
  curveDate: D,
  o: { forwardTenorDays: number; stepYears: number; count: number | null; minTrades: number; spotRate: number },
): GridPoint[] {
  const tolerance = Math.max(7, pyRound(o.forwardTenorDays * 0.1, 0))
  const buckets = new Map<number, number[]>()
  for (const observation of extractForwardObservations(records, fisn, currency, curveDate)) {
    if (Math.abs(observation.tenor_days - o.forwardTenorDays) <= tolerance) {
      const key = pyRound(observation.forward_days / 30.0, 0)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(observation.rate)
    }
  }
  const observed: [number, number, number][] = []
  for (const months of [...buckets.keys()].sort((a, b) => a - b)) {
    const rates = buckets.get(months)!
    if (rates.length >= o.minTrades) observed.push([(months * 30.0) / 365.0, median(rates), rates.length])
  }
  if (observed.length === 0) return []
  const anchored: [number, number][] = [[0.0, o.spotRate], ...observed.filter(([start]) => start > 0.05).map(([start, rate]) => [start, rate] as [number, number])]
  anchored.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lastStart = observed[observed.length - 1]![0]
  const points: GridPoint[] = []
  let index = 0
  while (index * o.stepYears <= lastStart + 1e-9 && (o.count === null || index < o.count)) {
    const start = index * o.stepYears
    index++
    let nearest = observed[0]!
    for (const item of observed) if (Math.abs(item[0] - start) < Math.abs(nearest[0] - start)) nearest = item
    points.push({ tenor_years: start, tenor_days: pyRound(start * 365.0, 0), forward_rate: interpolateMonotone(anchored, start), forward_extrapolated: false, num_trades: nearest[2] })
  }
  return points
}
