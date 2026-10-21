// Swap curve construction from DTCC PPD slice records: observations, nodes, bootstrapped discount factors, the
// Svensson fit and forward rates. Ported from openbb_cftc/utils/curve.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: dates are ISO strings (dates.ts), no on-disk curve cache.
import { pyRound } from '../helpers.js'
import { BENCHMARK_TENORS, DAY_COUNT_CODES, dayCountBasis, currencyBasis, MAX_ABS_ZERO_RATE, MAX_CURVE_DAYS, oisIndices, fixedFloatSpecs, OIS_PAYMENT_PERIOD_DAYS, rateCurveFisns, SINGLE_PAYMENT_MAX_DAYS, ZERO_RATE_BASIS } from './constants.js'
import { addDays, diffDays, parseIso, type D } from './dates.js'
import { FIXING_BASES } from './fixings.js'
import { pyMedian, pySum } from './num.js'

/** One row of a PPD slice, keyed by the CSV headers. */
export type SliceRecord = Record<string, string | null | undefined>
export type Rec = Record<string, any>

const field = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/** A notional and whether it was disseminated at a cap (`parse_notional`). */
export function parseNotional(value: string | null | undefined): [number | null, boolean] {
  let text = (value ?? '').trim()
  if (!text) return [null, false]
  const capped = text.endsWith('+')
  text = text.replace(/\++$/, '')
  const digits = text.replace(/,/g, '').replace(/\./g, '')
  if (digits && /^9+$/.test(digits)) return [null, capped]
  return [pyFloat(text.replace(/,/g, '')), capped]
}

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
/** Python's `float(text)`, or null where it raises ValueError. */
export function pyFloat(text: string): number | null {
  const t = text.trim()
  if (FLOAT_RE.test(t)) return Number(t)
  if (/^\d+(_\d+)*(\.\d+(_\d+)*)?$/.test(t)) return Number(t.replace(/_/g, ''))
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t)
  if (special) return special[2]!.toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity
  return null
}

/** A trade's fixed rate, reported on either leg (`parse_rate`). */
export function parseRate(record: SliceRecord): number | null {
  for (const f of ['Fixed rate-Leg 1', 'Fixed rate-Leg 2']) {
    const text = field(record, f)
    if (!text) continue
    const rate = pyFloat(text)
    if (rate === null) continue
    if (rate !== 0) return rate
  }
  return null
}

/** A PPD date field (`parse_date`). */
export const parseDate = (value: string | null | undefined): D | null => ((value ?? '').trim() ? parseIso(value) : null)

/** A compact label for a tenor in days (`tenor_label`). */
export function tenorLabel(days: number): string {
  if (days % 365 === 0 && days >= 365) return `${Math.floor(days / 365)}Y`
  if (days >= 365) return `${days}D`
  if (days % 30 === 0 && days >= 30) return `${Math.floor(days / 30)}M`
  return `${days}D`
}

/** Snap a tenor to its benchmark node (`bucket_tenor`). */
export function bucketTenor(days: number): [string, number] | null {
  for (const [label, node] of BENCHMARK_TENORS) if (Math.abs(days - node) <= Math.max(4, node * 0.02)) return [label, node]
  return null
}

/** The dissemination date a search record was reported on (`record_trade_date`). */
export const recordTradeDate = (record: SliceRecord): D | null => parseDate(record['Dissemination Timestamp'])

/** Whether a rate-swap print quotes a standalone par rate (`is_vanilla_par`). */
export function isVanillaPar(record: SliceRecord): boolean {
  const isSet = (f: string): boolean => Boolean(field(record, f))
  return field(record, 'Package indicator') !== 'TRUE' && !isSet('Package transaction price') && !isSet('Package transaction spread') && !isSet('Other payment amount') && !isSet('Spread-Leg 1') && !isSet('Spread-Leg 2') && field(record, 'Non-standardized term indicator') !== 'TRUE' && !isSet('Fixed rate-Leg 2')
}

/** A reported payment or reset frequency as (unit, count) (`parse_frequency`). */
export function parseFrequency(period: string | null | undefined, multiplier: string | null | undefined): [string, number] | null {
  const unit = (period ?? '').trim().toUpperCase()
  if (unit === 'EXPI') return ['EXPI', 1]
  if (!['YEAR', 'MNTH', 'WEEK', 'DAIL'].includes(unit)) return null
  const text = (multiplier ?? '').trim()
  if (!/^\d+$/.test(text) || Number(text) <= 0) return null
  return [unit, Number(text)]
}

/** Payment period in days from a reported frequency (`frequency_days`). */
export function frequencyDays(period: string | null | undefined, multiplier: string | null | undefined): number | null {
  const countText = (multiplier ?? '').trim()
  if (!/^\d+$/.test(countText)) return null
  const count = Number(countText)
  const unit = ({ YEAR: 365.0, MNTH: 365.0 / 12.0, WEEK: 7.0, DAIL: 1.0 } as Record<string, number>)[(period ?? '').trim().toUpperCase()]
  if (unit === undefined || count <= 0) return null
  return pyRound(count * unit, 0)
}

const paymentPeriodDays = (record: SliceRecord): number | null => frequencyDays(record['Fixed rate payment frequency period-Leg 1'], record['Fixed rate payment frequency period multiplier-Leg 1'])

export type Observation = {
  rate: number
  tenor_days: number
  trade_date: D
  effective_date: D
  expiration_date: D
  notional: number | null
  is_capped: boolean
  cleared: string | null
  day_count: string | null
  payment_period: number | null
}

/** A priceable new trade reduced to its curve observation, or null (`_observation`). */
function observation(record: SliceRecord, tradeDate: D, fisn: string, currency: string, spotOnly: boolean, spotWindow: number): Observation | null {
  if (field(record, 'UPI FISN') !== fisn) return null
  if (field(record, 'Action type') !== 'NEWT') return null
  if (field(record, 'Event type') !== 'TRAD') return null
  if (field(record, 'Notional currency-Leg 1') !== currency) return null
  const rate = parseRate(record)
  const effective = parseDate(record['Effective Date'])
  const expiration = parseDate(record['Expiration Date'])
  if (rate === null || effective === null || expiration === null) return null
  const forwardDays = diffDays(effective, tradeDate)
  if (spotOnly && !(forwardDays >= 0 && forwardDays <= spotWindow)) return null
  const tenorDays = diffDays(expiration, effective)
  if (!(tenorDays > 0 && tenorDays <= MAX_CURVE_DAYS)) return null
  const [notional, capped] = parseNotional(record['Notional amount-Leg 1'])
  return {
    rate,
    tenor_days: tenorDays,
    trade_date: tradeDate,
    effective_date: effective,
    expiration_date: expiration,
    notional,
    is_capped: capped,
    cleared: field(record, 'Cleared').toUpperCase() || null,
    day_count: field(record, 'Fixed rate day count convention-leg 1') || null,
    payment_period: paymentPeriodDays(record),
  }
}

const isCleared = (o: Observation): boolean => o.cleared === 'Y' || o.cleared === 'I'

/** Priceable new trades of one report date (`extract_observations`). */
export function extractObservations(records: Iterable<SliceRecord>, o: { tradeDate: D; fisn: string; currency?: string; spotOnly?: boolean; spotWindow?: number; clearedOnly?: boolean }): Observation[] {
  const out: Observation[] = []
  for (const record of records) {
    const obs = observation(record, o.tradeDate, o.fisn, o.currency ?? 'USD', o.spotOnly ?? true, o.spotWindow ?? 5)
    if (obs === null || (o.clearedOnly && !isCleared(obs))) continue
    out.push(obs)
  }
  return out
}

/** Priceable new trades, each dated against its own dissemination day (`extract_observations_by_day`). */
export function extractObservationsByDay(records: Iterable<SliceRecord>, o: { fisn: string; currency?: string; spotOnly?: boolean; spotWindow?: number; clearedOnly?: boolean }): Observation[] {
  const out: Observation[] = []
  for (const record of records) {
    const tradeDate = recordTradeDate(record)
    if (tradeDate === null) continue
    const obs = observation(record, tradeDate, o.fisn, o.currency ?? 'USD', o.spotOnly ?? true, o.spotWindow ?? 5)
    if (obs === null || (o.clearedOnly && !isCleared(obs))) continue
    out.push(obs)
  }
  return out
}

/** Linearly interpolated percentile of a sorted list of two or more values (`_percentile`). */
export function percentile(ordered: number[], pct: number): number {
  const rank = (pct / 100.0) * (ordered.length - 1)
  const low = Math.trunc(rank)
  const frac = rank - low
  return ordered[low]! + frac * (ordered[low + 1]! - ordered[low]!)
}

/** The benchmark tenor, in days, closest to a given tenor (`_nearest_benchmark_days`). */
function nearestBenchmarkDays(days: number): number {
  let best: number = BENCHMARK_TENORS[0]![1]
  for (const [, d] of BENCHMARK_TENORS) if (Math.abs(d - days) < Math.abs(best - days)) best = d
  return best
}

/** Drop observations whose rate is an outlier within its nearest benchmark tenor (`trim_observations`). */
export function trimObservations(observations: Observation[]): Observation[] {
  const groups = new Map<number, Observation[]>()
  for (const o of observations) {
    const key = nearestBenchmarkDays(o.tenor_days)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }
  const kept: Observation[] = []
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

const sum = pySum
export const median = pyMedian

function aggregate(rates: number[], notionals: (number | null)[], method: string): number {
  if (method === 'mean') return sum(rates) / rates.length
  if (method === 'vwap') {
    const weights = notionals.map((n) => n || 0.0)
    const total = sum(weights)
    if (total > 0) return sum(rates.map((r, i) => r * weights[i]!)) / total
  }
  return median(rates)
}

/** The most common value among those present; the first met wins a tie (`Counter.most_common(1)`). */
export function mostCommon<T>(values: (T | null | undefined)[]): T | undefined {
  const counts = new Map<T, number>()
  for (const v of values) if (v !== null && v !== undefined && (v as unknown) !== '' && (v as unknown) !== 0) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: T | undefined
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

function nodeKey(o: Observation, granularity: string): [string, number] | null {
  const days = o.tenor_days
  return granularity === 'observed' ? [tenorLabel(days), days] : bucketTenor(days)
}

/** A node's observations aggregated into a par rate and its quality markers (`_node`). */
function makeNode(label: string, days: number, members: Observation[], aggregation: string, dayCountDefault: string): Rec {
  const rates = members.map((m) => m.rate)
  const notionals = members.map((m) => m.notional)
  const total = sum(notionals.filter((n): n is number => n !== null))
  const code = mostCommon(members.map((m) => m.day_count)) ?? dayCountDefault
  const period = mostCommon(members.map((m) => m.payment_period)) ?? OIS_PAYMENT_PERIOD_DAYS
  return {
    tenor: label,
    tenor_days: days,
    tenor_years: pyRound(days / 365.0, 6),
    par_rate: aggregate(rates, notionals, aggregation),
    num_trades: members.length,
    total_notional: total || null,
    min_rate: Math.min(...rates),
    max_rate: Math.max(...rates),
    is_capped: members.some((m) => m.is_capped),
    day_count: (DAY_COUNT_CODES as Record<string, string>)[code] ?? code,
    day_count_basis: dayCountBasis(code, dayCountDefault),
    payment_period_days: period,
  }
}

/** Group observations into curve nodes and aggregate each to a par rate (`build_nodes`). */
export function buildNodes(observations: Observation[], o: { granularity?: string; aggregation?: string; minTrades?: number; dayCountDefault?: string } = {}): Rec[] {
  const granularity = o.granularity ?? 'benchmark'
  const groups = new Map<string, { label: string; days: number; members: Observation[] }>()
  for (const obs of observations) {
    const key = nodeKey(obs, granularity)
    if (key === null) continue
    const id = `${key[0]}\u0000${key[1]}`
    if (!groups.has(id)) groups.set(id, { label: key[0], days: key[1], members: [] })
    groups.get(id)!.members.push(obs)
  }
  return [...groups.values()]
    .sort((a, b) => a.days - b.days)
    .filter((g) => g.members.length >= (o.minTrades ?? 1))
    .map((g) => makeNode(g.label, g.days, g.members, o.aggregation ?? 'median', o.dayCountDefault ?? 'A004'))
}

/** Each node from the most recent dissemination day that clears min_trades (`build_nodes_as_of`). */
export function buildNodesAsOf(observations: Observation[], o: { granularity?: string; aggregation?: string; minTrades?: number; dayCountDefault?: string } = {}): Rec[] {
  const granularity = o.granularity ?? 'benchmark'
  const groups = new Map<string, { label: string; days: number; byDay: Map<D, Observation[]> }>()
  for (const obs of observations) {
    const key = nodeKey(obs, granularity)
    if (key === null) continue
    const id = `${key[0]}\u0000${key[1]}`
    if (!groups.has(id)) groups.set(id, { label: key[0], days: key[1], byDay: new Map() })
    const g = groups.get(id)!
    if (!g.byDay.has(obs.trade_date)) g.byDay.set(obs.trade_date, [])
    g.byDay.get(obs.trade_date)!.push(obs)
  }
  const nodes: Rec[] = []
  for (const g of [...groups.values()].sort((a, b) => a.days - b.days)) {
    for (const asOf of [...g.byDay.keys()].sort().reverse()) {
      const members = g.byDay.get(asOf)!
      if (members.length < (o.minTrades ?? 1)) continue
      const node = makeNode(g.label, g.days, members, o.aggregation ?? 'median', o.dayCountDefault ?? 'A004')
      node.as_of_date = asOf
      nodes.push(node)
      break
    }
  }
  if (nodes.length > 0) {
    const freshest = nodes.map((n) => n.as_of_date as D).sort().at(-1)!
    for (const node of nodes) node.staleness_days = diffDays(freshest, node.as_of_date)
  }
  return nodes
}

/** Fritsch-Butland monotone Hermite slopes (`_monotone_slopes`). */
function monotoneSlopes(times: number[], values: number[]): number[] {
  const count = values.length
  if (count === 1) return [0.0]
  const widths = Array.from({ length: count - 1 }, (_v, i) => times[i + 1]! - times[i]!)
  const secants = Array.from({ length: count - 1 }, (_v, i) => (values[i + 1]! - values[i]!) / widths[i]!)
  const slopes = [secants[0]!, ...Array.from({ length: count - 2 }, () => 0.0), secants[secants.length - 1]!]
  for (let i = 1; i < count - 1; i++) {
    if (secants[i - 1]! * secants[i]! <= 0) slopes[i] = 0.0
    else {
      const wl = 2 * widths[i]! + widths[i - 1]!
      const wr = widths[i]! + 2 * widths[i - 1]!
      slopes[i] = (wl + wr) / (wl / secants[i - 1]! + wr / secants[i]!)
    }
  }
  return slopes
}

/** `bisect.bisect_left`. */
function bisectLeft(xs: number[], x: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export type CurvePoints = [number, number][]

/** Interpolate a discount factor in time, on the log of the discount factor (`_interpolate_log_df`). */
export function interpolateLogDf(curve: CurvePoints, years: number, interpolation = 'log_linear'): number {
  if (curve.length === 0) return 1.0
  const times = curve.map(([t]) => t)
  const logs = curve.map(([, f]) => Math.log(f))
  if (years <= times[0]!) return Math.exp((logs[0]! * years) / times[0]!)
  if (years >= times[times.length - 1]!) return Math.exp((logs[logs.length - 1]! * years) / times[times.length - 1]!)
  const index = bisectLeft(times, years)
  const t0 = times[index - 1]!
  const t1 = times[index]!
  const y0 = logs[index - 1]!
  const y1 = logs[index]!
  if (interpolation === 'log_linear' || curve.length < 3) return Math.exp(y0 + ((y1 - y0) * (years - t0)) / (t1 - t0))
  const slopes = monotoneSlopes(times, logs)
  const width = t1 - t0
  const s = (years - t0) / width
  const s2 = s * s
  const s3 = s2 * s
  const value = (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * width * slopes[index - 1]! + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * width * slopes[index]!
  return Math.exp(value)
}

/** Shape-preserving monotone Hermite interpolation (`interpolate_monotone`). */
export function interpolateMonotone(points: CurvePoints, x: number): number {
  if (points.length === 0) return 0.0
  const times = points.map(([t]) => t)
  const values = points.map(([, v]) => v)
  if (x <= times[0]!) return values[0]!
  if (x >= times[times.length - 1]!) return values[values.length - 1]!
  const slopes = monotoneSlopes(times, values)
  const index = bisectLeft(times, x)
  const t0 = times[index - 1]!
  const t1 = times[index]!
  const y0 = values[index - 1]!
  const y1 = values[index]!
  const width = t1 - t0
  const s = (x - t0) / width
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * width * slopes[index - 1]! + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * width * slopes[index]!
}

/** A fixed-leg schedule rolled back from maturity, leaving a front stub (`_payment_offsets`). */
export function paymentOffsets(tenorDays: number, periodDays?: number | null): number[] {
  const period = periodDays || OIS_PAYMENT_PERIOD_DAYS
  const threshold = period + (SINGLE_PAYMENT_MAX_DAYS - OIS_PAYMENT_PERIOD_DAYS)
  const offsets: number[] = []
  let remaining = tenorDays
  while (remaining > threshold) {
    offsets.push(remaining)
    remaining -= period
  }
  offsets.push(remaining)
  return offsets.reverse()
}

/** Bootstrap discount factors and zero rates from par rates (`bootstrap`). */
export function bootstrap(nodes: Rec[], interpolation = 'log_linear'): Rec[] {
  let curve: CurvePoints = []
  const results: Rec[] = []
  for (const node of [...nodes].sort((a, b) => a.tenor_days - b.tenor_days)) {
    const days = node.tenor_days as number
    const par = node.par_rate as number
    const years = days / ZERO_RATE_BASIS
    const basis = node.day_count_basis as number
    const period = (node.payment_period_days as number | undefined) ?? OIS_PAYMENT_PERIOD_DAYS
    const result: Rec = { ...node }
    delete result.day_count_basis
    delete result.payment_period_days

    const offsets = paymentOffsets(days, period)
    let accrued = 0.0
    let previousOffset = 0
    for (const offset of offsets.slice(0, -1)) {
      const tau = (offset - previousOffset) / basis
      accrued += tau * interpolateLogDf(curve, offset / ZERO_RATE_BASIS, interpolation)
      previousOffset = offset
    }
    const tauN = (offsets[offsets.length - 1]! - previousOffset) / basis
    const denominator = 1.0 + par * tauN
    const df = denominator > 0 ? (1.0 - par * accrued) / denominator : 0.0
    const logZero = df > 0.0 ? -Math.log(df) / years : null
    if (logZero === null || Math.abs(logZero) > MAX_ABS_ZERO_RATE) {
      Object.assign(result, { discount_factor: null, zero_rate: null })
      results.push(result)
      continue
    }
    Object.assign(result, { discount_factor: df, zero_rate: Math.pow(1.0 / df, 1.0 / years) - 1.0 })
    results.push(result)
    curve = [...curve, [years, df] as [number, number]].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  }
  return results
}

/** Forward par swap rate for a tenor-year OIS starting at start_years (`forward_par_rate`). */
export function forwardParRate(dfs: CurvePoints, startYears: number, tenorYears: number, basis: number, periodDays?: number | null, interpolation = 'log_linear'): number | null {
  if (dfs.length === 0 || startYears < 0 || startYears > dfs[dfs.length - 1]![0] + 1e-9) return null
  const tenorDays = pyRound(tenorYears * ZERO_RATE_BASIS, 0)
  if (tenorDays <= 0) return null
  const endYears = startYears + tenorDays / ZERO_RATE_BASIS
  let annuity = 0.0
  let previousOffset = 0
  for (const offset of paymentOffsets(tenorDays, periodDays)) {
    const tau = (offset - previousOffset) / basis
    annuity += tau * interpolateLogDf(dfs, startYears + offset / ZERO_RATE_BASIS, interpolation)
    previousOffset = offset
  }
  const dfStart = interpolateLogDf(dfs, startYears, interpolation)
  const dfEnd = interpolateLogDf(dfs, endYears, interpolation)
  return (dfStart - dfEnd) / annuity
}

const NSS_MIN_NODES = 6
const NSS_TAU1 = Array.from({ length: 20 }, (_v, i) => 0.5 + 0.25 * i)
const NSS_TAU2 = Array.from({ length: 37 }, (_v, i) => 2.0 + 0.5 * i)

type Nss = [number, number, number, number, number, number]

function nssBasis(t: number, tau1: number, tau2: number): [number, number, number, number] {
  const a = t / tau1
  const b = t / tau2
  const e1 = Math.exp(-a)
  const e2 = Math.exp(-b)
  const slope = (1.0 - e1) / a
  return [1.0, slope, slope - e1, (1.0 - e2) / b - e2]
}

/** Solve a 4x4 linear system by Gaussian elimination with partial pivoting (`_solve4`). */
function solve4(matrix: number[][], rhs: number[]): number[] | null {
  const m = matrix.map((row, i) => [...row, rhs[i]!])
  for (let col = 0; col < 4; col++) {
    let pivot = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    if (Math.abs(m[col]![col]!) < 1e-15) return null
    for (let r = 0; r < 4; r++) {
      if (r !== col) {
        const factor = m[r]![col]! / m[col]![col]!
        for (let k = col; k < 5; k++) m[r]![k]! -= factor * m[col]![k]!
      }
    }
  }
  return [0, 1, 2, 3].map((i) => m[i]![4]! / m[i]![i]!)
}

/** Fit a Svensson curve to weighted points (`fit_nss`). */
export function fitNss(points: [number, number][], weights: number[]): Nss | null {
  if (points.length < NSS_MIN_NODES) return null
  let best: { sse: number; betas: number[]; tau1: number; tau2: number } | null = null
  for (const tau1 of NSS_TAU1) {
    for (const tau2 of NSS_TAU2) {
      if (tau2 <= tau1) continue
      const ata = Array.from({ length: 4 }, () => [0.0, 0.0, 0.0, 0.0])
      const aty = [0.0, 0.0, 0.0, 0.0]
      points.forEach(([t, z], k) => {
        const f = nssBasis(t, tau1, tau2)
        const w = weights[k]!
        for (let i = 0; i < 4; i++) {
          aty[i]! += w * f[i]! * z
          for (let j = 0; j < 4; j++) ata[i]![j]! += w * f[i]! * f[j]!
        }
      })
      const betas = solve4(ata, aty)
      if (betas === null) continue
      // Python's sum() is compensated in 3.12, so the fit and the error are summed the same way here.
      const sse = pySum(
        points.map(([t, z], k) => {
          const f = nssBasis(t, tau1, tau2)
          const fit = pySum(f.map((fi, i) => betas[i]! * fi))
          return weights[k]! * (fit - z) ** 2
        }),
      )
      if (best === null || sse < best.sse) best = { sse, betas, tau1, tau2 }
    }
  }
  if (best === null) return null
  const [b0, b1, b2, b3] = best.betas as [number, number, number, number]
  return [b0, b1, b2, b3, best.tau1, best.tau2]
}

/** Continuously-compounded zero rate from a fitted Svensson parameter set (`nss_zero`). */
export function nssZero(params: Nss, t: number): number {
  const f = nssBasis(t, params[4], params[5])
  return pySum([0, 1, 2, 3].map((i) => params[i]! * f[i]!))
}

/** Dense discount-factor grid from a Svensson fit, weighted by trade count (`smooth_forward_dfs`). */
export function smoothForwardDfs(curve: Rec[], extendYears = 0.0): CurvePoints {
  const nodes = curve
    .filter((n) => n.discount_factor !== null && n.discount_factor !== undefined && n.tenor_years > 0.0)
    .map((n) => [n.tenor_years as number, n.discount_factor as number, Number(n.num_trades)] as [number, number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  const raw: CurvePoints = nodes.map(([t, df]) => [t, df])
  const params = fitNss(nodes.map(([t, df]) => [t, -Math.log(df) / t] as [number, number]), nodes.map(([, , w]) => w))
  if (params === null) return raw
  const end = raw[raw.length - 1]![0] + Math.max(extendYears, 0.0)
  const times: number[] = []
  for (let i = 1; i <= Math.trunc(end * 12); i++) times.push(i / 12.0)
  if (times.length === 0 || times[times.length - 1]! < end - 1e-9) times.push(end)
  return times.map((t) => [t, Math.exp(-nssZero(params, t) * t)] as [number, number])
}

/** Trades behind the curve nodes spanning [start, end) years of tenor (`_local_trade_count`). */
function localTradeCount(nodes: Rec[], startYears: number, endYears: number): number {
  const spanning = nodes.filter((n) => startYears <= n.tenor_years && n.tenor_years < endYears)
  if (spanning.length > 0) return sum(spanning.map((n) => n.num_trades))
  let nearest = nodes[0]!
  for (const n of nodes) if (Math.abs(n.tenor_years - startYears) < Math.abs(nearest.tenor_years - startYears)) nearest = n
  return nearest.num_trades
}

/** Forward par rates off the smooth Svensson curve, at start dates `step` apart (`forward_curve_grid`). */
export function forwardCurveGrid(curve: Rec[], forwardTenor: number, step: number, basis: number, count?: number | null, periodDays?: number | null): Rec[] {
  const nodes = curve.filter((n) => n.discount_factor !== null && n.discount_factor !== undefined)
  const observed = nodes.map((n) => n.tenor_years as number).sort((a, b) => a - b)
  if (observed.length === 0) return []
  const last = observed[observed.length - 1]!
  const dfs = smoothForwardDfs(curve, forwardTenor)
  const points: Rec[] = []
  let index = 0
  while (index * step <= last + 1e-9 && (count === null || count === undefined || index < count)) {
    const years = index * step
    index++
    points.push({
      tenor_years: years,
      tenor_days: pyRound(years * 365.0, 0),
      forward_rate: forwardParRate(dfs, years, forwardTenor, basis, periodDays),
      forward_extrapolated: years + forwardTenor > last + 1e-9,
      num_trades: localTradeCount(nodes, years, years + forwardTenor),
    })
  }
  return points
}

/** Spot-starting par swap rate at a tenor, read off a discount-factor curve (`_par_rate_at`). */
export function parRateAt(dfs: CurvePoints, tenorDays: number, basis: number, periodDays: number | null | undefined, interpolation: string): number {
  let annuity = 0.0
  let previous = 0
  for (const offset of paymentOffsets(tenorDays, periodDays)) {
    const tau = (offset - previous) / basis
    annuity += tau * interpolateLogDf(dfs, offset / ZERO_RATE_BASIS, interpolation)
    previous = offset
  }
  const dfEnd = interpolateLogDf(dfs, tenorDays / ZERO_RATE_BASIS, interpolation)
  return (1.0 - dfEnd) / annuity
}

/** Observed nodes repriced off the smooth curve fitted to the benchmark pillars (`_reprice_off_pillars`). */
function repriceOffPillars(nodes: Rec[], pillars: Rec[], basis: number, periodDays: number | null | undefined, interpolation: string): Rec[] {
  const dfs: CurvePoints = pillars
    .filter((n) => n.discount_factor !== null && n.discount_factor !== undefined)
    .map((n) => [n.tenor_years as number, n.discount_factor as number] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return nodes.map((node) => {
    const result: Rec = { ...node }
    delete result.day_count_basis
    delete result.payment_period_days
    const years = node.tenor_days / ZERO_RATE_BASIS
    const df = interpolateLogDf(dfs, years, interpolation)
    Object.assign(result, { par_rate: parRateAt(dfs, node.tenor_days, basis, periodDays, interpolation), discount_factor: df, zero_rate: Math.pow(1.0 / df, 1.0 / years) - 1.0 })
    return result
  })
}

/** The fallback day-count code for a currency's curve nodes (`_curve_day_count_default`). */
export function curveDayCountDefault(currency: string): string {
  const ccy = (currency || '').trim().toUpperCase()
  return oisIndices[ccy]?.day_count || fixedFloatSpecs[ccy]?.day_count || 'A004'
}

/** A 1-day node anchored to the currency's published overnight fixing (`_overnight_node`). */
function overnightNode(rate: number, currency: string): Rec {
  const ccy = currency.toUpperCase()
  const index = oisIndices[ccy]?.index || fixedFloatSpecs[ccy]?.overnight_index || ''
  const basis = FIXING_BASES[index] ?? 360.0
  const dayCount = ({ 360: 'ACT/360', 365: 'ACT/365F', 252: 'BUS/252' } as Record<number, string>)[basis]
  return {
    tenor: '1D',
    tenor_days: 1,
    tenor_years: pyRound(1 / 365.0, 6),
    par_rate: rate,
    num_trades: 0,
    total_notional: null,
    min_rate: rate,
    max_rate: rate,
    is_capped: false,
    day_count: dayCount,
    day_count_basis: basis,
    payment_period_days: 1,
  }
}

/** Most-common reported fixed-leg coupon period among observations, annual by default (`_curve_period`). */
function curvePeriod(observations: Observation[]): number {
  return mostCommon(observations.map((o) => o.payment_period)) ?? OIS_PAYMENT_PERIOD_DAYS
}

export class EmptyDataError extends Error {}

/** A bootstrapped swap curve from one report date's slice records (`build_curve`). */
export function buildCurve(
  records: Iterable<SliceRecord>,
  tradeDate: D,
  fisn: string,
  o: { currency?: string; granularity?: string; aggregation?: string; minTrades?: number; interpolation?: string; clearedOnly?: boolean; overnightRate?: number | null; overnightDate?: D | null } = {},
): Rec[] {
  const currency = o.currency ?? 'USD'
  const granularity = o.granularity ?? 'benchmark'
  const aggregation = o.aggregation ?? 'median'
  const minTrades = o.minTrades ?? 1
  const interpolation = o.interpolation ?? 'log_linear'
  const observations = trimObservations(extractObservations(records, { tradeDate, fisn, currency, spotOnly: true, clearedOnly: o.clearedOnly ?? false }))
  if (observations.length === 0) throw new EmptyDataError(`No priceable ${currency} trades matching '${fisn}' were found for ${tradeDate}.`)
  const dayCount = curveDayCountDefault(currency)
  const nodes = buildNodes(observations, { granularity, aggregation, minTrades, dayCountDefault: dayCount })
  if (nodes.length === 0) throw new EmptyDataError(`No curve nodes survived the filters for ${tradeDate}. Try lowering min_trades (currently ${minTrades}).`)
  const overnightRate = o.overnightRate ?? null
  const anchored = overnightRate !== null && nodes.every((n) => n.tenor_days > 1)
  if (anchored) nodes.unshift(overnightNode(overnightRate, currency))
  const basis = dayCountBasis(dayCount, 'A004')
  const period = curvePeriod(observations)
  let curve: Rec[]
  if (granularity === 'observed') {
    const pillarNodes = buildNodes(observations, { aggregation, minTrades, dayCountDefault: dayCount })
    if (anchored) pillarNodes.unshift(overnightNode(overnightRate, currency))
    curve = repriceOffPillars(nodes, bootstrap(pillarNodes, interpolation), basis, period, interpolation)
  } else curve = bootstrap(nodes, interpolation)
  for (const node of curve) {
    node.date = tradeDate
    node.as_of_date = tradeDate
    node.staleness_days = 0
    node.maturity_date = addDays(tradeDate, node.tenor_days)
    if (anchored && node.tenor === '1D' && o.overnightDate) {
      node.as_of_date = o.overnightDate
      node.staleness_days = Math.max(0, diffDays(tradeDate, o.overnightDate))
    }
  }
  return curve
}

/** Fixed-leg accrual basis a currency's rate curve is bootstrapped on (`curve_day_count_basis`). */
export function curveDayCountBasis(records: SliceRecord[], currency: string, tradeDate: D, minTrades = 1): number {
  const defaultCode = oisIndices[currency.toUpperCase()]?.day_count ?? 'A004'
  for (const fisn of rateCurveFisns(currency)) {
    const observations = extractObservations(records, { tradeDate, fisn, currency })
    if (observations.length < minTrades) continue
    const code = mostCommon(observations.map((o) => o.day_count)) ?? defaultCode
    return dayCountBasis(code, defaultCode)
  }
  return currencyBasis(currency)
}

/** Fixed-leg coupon period a currency's rate curve is bootstrapped on, annual by default (`curve_payment_period`). */
export function curvePaymentPeriod(records: SliceRecord[], currency: string, tradeDate: D, minTrades = 1): number {
  for (const fisn of rateCurveFisns(currency)) {
    const observations = extractObservations(records, { tradeDate, fisn, currency })
    if (observations.length < minTrades) continue
    return curvePeriod(observations)
  }
  return OIS_PAYMENT_PERIOD_DAYS
}

/** A bootstrapped swap curve whose nodes are each dated to their own day (`build_curve_as_of`). */
export function buildCurveAsOf(
  records: Iterable<SliceRecord>,
  fisn: string,
  o: { currency?: string; granularity?: string; aggregation?: string; minTrades?: number; interpolation?: string; clearedOnly?: boolean; maxStalenessDays?: number | null; overnightRate?: number | null; overnightDate?: D | null } = {},
): Rec[] {
  const currency = o.currency ?? 'USD'
  const granularity = o.granularity ?? 'benchmark'
  const aggregation = o.aggregation ?? 'median'
  const minTrades = o.minTrades ?? 1
  const interpolation = o.interpolation ?? 'log_linear'
  const usable = (nodes: Rec[]): Rec[] => {
    const live = nodes.filter((n) => n.tenor_days > n.staleness_days)
    return o.maxStalenessDays === null || o.maxStalenessDays === undefined ? live : live.filter((n) => n.staleness_days <= o.maxStalenessDays!)
  }
  const observations = trimObservations(extractObservationsByDay(records, { fisn, currency, spotOnly: true, clearedOnly: o.clearedOnly ?? false }))
  if (observations.length === 0) throw new EmptyDataError(`No priceable ${currency} trades matching '${fisn}' were disseminated in the search window.`)
  const dayCount = curveDayCountDefault(currency)
  let nodes = buildNodesAsOf(observations, { granularity, aggregation, minTrades, dayCountDefault: dayCount })
  if (nodes.length === 0) throw new EmptyDataError(`No curve node had a single day clearing min_trades (currently ${minTrades}). Lower min_trades, or widen lookback_days.`)
  nodes = usable(nodes)
  const overnightRate = o.overnightRate ?? null
  const anchored = overnightRate !== null && nodes.length > 0 && nodes.every((n) => n.tenor_days > 1)
  let anchor: Rec | null = null
  if (anchored) {
    const reference = nodes.map((n) => n.as_of_date as D).sort().at(-1)!
    anchor = overnightNode(overnightRate, currency)
    anchor.as_of_date = o.overnightDate || reference
    anchor.staleness_days = Math.max(0, diffDays(reference, anchor.as_of_date))
    nodes.unshift(anchor)
  }
  const basis = dayCountBasis(dayCount, 'A004')
  const period = curvePeriod(observations)
  let curve: Rec[]
  if (granularity === 'observed') {
    const pillarNodes = usable(buildNodesAsOf(observations, { aggregation, minTrades, dayCountDefault: dayCount }))
    if (anchor !== null) pillarNodes.unshift({ ...anchor })
    curve = repriceOffPillars(nodes, bootstrap(pillarNodes, interpolation), basis, period, interpolation)
  } else curve = bootstrap(nodes, interpolation)
  const curveDate = curve.map((n) => n.as_of_date as D).sort().at(-1)!
  for (const node of curve) {
    node.date = curveDate
    node.maturity_date = addDays(node.as_of_date, node.tenor_days)
  }
  return curve
}

