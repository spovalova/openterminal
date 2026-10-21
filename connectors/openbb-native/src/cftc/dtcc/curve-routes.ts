// cftc/ois_curve, ois_curve_history, ois_forward_curve, ois_policy_path and historical_fixings, provider cftc. Ported
// from openbb_cftc/models/{ois_curve,ois_curve_history,ois_forward_curve,ois_policy_path,historical_fixings}.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models (model.ts), slices are
// memoised with ctx.cache.
import { pyRound } from '../helpers.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { oisIndices, fixedFloatSpecs, BENCHMARK_TENORS, curveFisn, curveSpec, dayCountBasis, oisFisn, tenorToYears } from './constants.js'
import { cnyCurveRecords } from './cfets.js'
import {
  EmptyDataError,
  buildCurve,
  buildCurveAsOf,
  curvePaymentPeriod,
  extractObservations,
  forwardCurveGrid,
  parRateAt,
  type Rec,
  type SliceRecord,
} from './curve.js'
import { addDays, todayOf, type D } from './dates.js'
import { getAvailableDates, getLatestViableSlice, getSlice } from './dtcc.js'
import { fixingProfile } from './fixings.js'
import { FIXING_SOURCES } from './fixings-data.js'
import { getFixings } from './fixings-fetch.js'
import { pyFixed } from './format.js'
import { validateRow } from './model.js'
import { mapLimit, pBool, pDate, pNum, pStr } from './params.js'
import { buildPolicyPath, observedForwardGrid } from './policy.js'
import { HISTORICAL_FIXINGS_SCHEMA, OIS_CURVE_HISTORY_SCHEMA, OIS_CURVE_SCHEMA, OIS_FORWARD_CURVE_SCHEMA, OIS_POLICY_PATH_SCHEMA } from './schemas.js'
import { searchTrades } from './search.js'

const MAX_CONCURRENT_DOWNLOADS = 4

/** The currency's freshest published overnight fixing on or before a date (`_latest_fixing`). */
async function latestFixing(ctx: NativeCtx, currency: string, onOrBefore: D): Promise<[D, number] | null> {
  const spec = (oisIndices[currency] ?? fixedFloatSpecs[currency]) as { overnight_index?: string; index?: string }
  if (!spec) throw new Error(`KeyError: '${currency}'`)
  const index = spec.overnight_index || spec.index!
  let fixings: Record<string, number>
  try {
    fixings = await getFixings(ctx, index, addDays(onOrBefore, -14), onOrBefore)
  } catch {
    return null
  }
  const days = Object.keys(fixings).filter((d) => d <= onOrBefore)
  if (days.length === 0) return null
  const day = days.sort().at(-1)!
  return [day, fixings[day]!]
}

// ---- cftc/ois_curve -------------------------------------------------------------------------------------------------

export const oisCurve: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const currency = (pStr(params, 'currency') ?? 'USD').toUpperCase()
  const curveType = pStr(params, 'curve_type') ?? 'par'
  const source = pStr(params, 'source') ?? 'search'
  const date = pDate(params, 'date')
  const lookbackDays = pNum(params, 'lookback_days') ?? 7
  const maxStalenessDays = pNum(params, 'max_staleness_days') ?? null
  const granularity = pStr(params, 'granularity') ?? 'benchmark'
  const aggregation = pStr(params, 'aggregation') ?? 'median'
  const minTrades = pNum(params, 'min_trades') ?? 1
  const cleared = pBool(params, 'cleared') ?? false
  const interpolation = pStr(params, 'interpolation') ?? 'log_linear'
  const overnightAnchor = pBool(params, 'overnight_anchor') ?? false

  const fisn = curveFisn(currency)
  let records: SliceRecord[]
  let reportDate: D | null
  let anchor: [D, number] | null = null

  if (source === 'slice') {
    if (currency === 'CNY') {
      let dates = await getAvailableDates(ctx, 'rates')
      if (date) dates = dates.filter((d) => d <= date)
      if (dates.length === 0) throw new Error('No PPD rates files are currently published for the window.')
      reportDate = dates[dates.length - 1]!
      records = await getSlice(ctx, 'rates', reportDate)
      const extra = await cnyCurveRecords(ctx, reportDate)
      if (extra.length > 0) records = [...records, ...extra]
    } else {
      ;[records, reportDate] = await getLatestViableSlice(ctx, 'rates', (recs, day) => extractObservations(recs, { tradeDate: day, fisn, currency, clearedOnly: cleared }).length > 0, { maxLookback: lookbackDays, endDate: date ?? null })
    }
    if (overnightAnchor) anchor = await latestFixing(ctx, currency, reportDate)
  } else {
    const endDate = date ?? todayOf(ctx.now())
    records = await searchTrades(ctx, 'rates', addDays(endDate, -(lookbackDays - 1)), endDate, { currency, upiShortName: fisn })
    if (currency === 'CNY') {
      const extra = await cnyCurveRecords(ctx, endDate)
      if (extra.length > 0) records = [...records, ...extra]
    }
    reportDate = null
    if (overnightAnchor) anchor = await latestFixing(ctx, currency, endDate)
  }

  const spec = curveSpec(currency)
  const [overnightDate, overnightRate] = anchor ?? [null, null]
  const curve =
    reportDate === null
      ? buildCurveAsOf(records, fisn, { currency, granularity, aggregation, minTrades, interpolation, clearedOnly: cleared, maxStalenessDays, overnightRate, overnightDate })
      : buildCurve(records, reportDate, fisn, { currency, granularity, aggregation, minTrades, interpolation, clearedOnly: cleared, overnightRate, overnightDate })
  const rateKey = curveType === 'zero' ? 'zero_rate' : 'par_rate'
  for (const node of curve) {
    node.currency = currency
    node.benchmark = spec.index
    node.curve_type = curveType
    const rate = node[rateKey] as number | null | undefined
    node.rate = rate === null || rate === undefined ? null : rate * 100.0
    for (const field of ['min_rate', 'max_rate']) if (node[field] !== null && node[field] !== undefined) node[field] = (node[field] as number) * 100.0
    node.index = granularity === 'benchmark' ? node.tenor : node.maturity_date
  }
  return curve.map((n) => validateRow(OIS_CURVE_SCHEMA, n))
}

// ---- cftc/ois_curve_history -----------------------------------------------------------------------------------------

export const oisCurveHistory: NativeHandler = async (params, ctx) => {
  const currency = (pStr(params, 'currency') ?? 'USD').toUpperCase()
  const measure = pStr(params, 'measure') ?? 'par_rate'
  const aggregation = pStr(params, 'aggregation') ?? 'median'
  const minTrades = pNum(params, 'min_trades') ?? 1
  const interpolation = pStr(params, 'interpolation') ?? 'log_linear'
  const pivot = pBool(params, 'pivot') ?? true
  const tenorParam = params.tenor
  const tenorText = Array.isArray(tenorParam) ? tenorParam.join(',') : typeof tenorParam === 'string' ? tenorParam : ''

  const available = await getAvailableDates(ctx, 'rates')
  if (available.length === 0) throw new EmptyDataError('No PPD interest-rate files are currently published.')
  const endDate = pDate(params, 'end_date') ?? available[available.length - 1]!
  const startDate = pDate(params, 'start_date') ?? addDays(endDate, -30)
  const targets = available.filter((d) => startDate <= d && d <= endDate)
  if (targets.length === 0) throw new EmptyDataError(`No PPD files were published between ${startDate} and ${endDate}.`)
  const fisn = curveFisn(currency)
  const curves = await mapLimit(targets, MAX_CONCURRENT_DOWNLOADS, async (reportDate): Promise<Rec[]> => {
    let records = await getSlice(ctx, 'rates', reportDate)
    if (currency === 'CNY') {
      const extra = await cnyCurveRecords(ctx, reportDate)
      if (extra.length > 0) records = [...records, ...extra]
    }
    try {
      return buildCurve(records, reportDate, fisn, { currency, granularity: 'benchmark', aggregation, minTrades, interpolation })
    } catch (err) {
      if (err instanceof EmptyDataError) return []
      throw err
    }
  })
  const nodes = curves.flat()
  if (nodes.length === 0) throw new EmptyDataError(`No ${currency} curve nodes could be built between ${startDate} and ${endDate}.`)

  const wanted = tenorText ? new Set(tenorText.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)) : null
  const order = BENCHMARK_TENORS.map(([label]) => label as string)
  let rows: Rec[]
  if (pivot) {
    const byDate = new Map<string, Rec>()
    for (const node of nodes) {
      const label = node.tenor as string
      if (wanted && wanted.size > 0 && !wanted.has(label.toUpperCase())) continue
      if (!byDate.has(node.date)) byDate.set(node.date, { date: node.date })
      byDate.get(node.date)![`tenor_${label.toLowerCase()}`] = node[measure] ?? null
    }
    rows = [...byDate.keys()].sort().map((k) => byDate.get(k)!)
  } else {
    const rank = (label: string): number => {
      const i = order.indexOf(label)
      return i >= 0 ? i : order.length
    }
    rows = []
    const sorted = nodes.map((n, i) => ({ n, i })).sort((a, b) => (a.n.date < b.n.date ? -1 : a.n.date > b.n.date ? 1 : rank(a.n.tenor) - rank(b.n.tenor) || a.i - b.i))
    for (const { n } of sorted) {
      const label = n.tenor as string
      if (wanted && wanted.size > 0 && !wanted.has(label.toUpperCase())) continue
      rows.push({ date: n.date, tenor: label, value: n[measure] ?? null })
    }
  }
  if (rows.length === 0) throw new EmptyDataError(`No curve nodes matched the requested tenors: ${tenorText}.`)
  return rows.map((r) => validateRow(OIS_CURVE_HISTORY_SCHEMA, r))
}

// ---- cftc/ois_forward_curve -----------------------------------------------------------------------------------------

export const oisForwardCurve: NativeHandler = async (params, ctx) => {
  const currency = (pStr(params, 'currency') ?? 'USD').toUpperCase()
  const forwardTenor = (pStr(params, 'forward_tenor') ?? '1Y').toUpperCase()
  const forwardStep = (pStr(params, 'forward_step') ?? '3M').toUpperCase()
  const forwardCount = pNum(params, 'forward_count') ?? null
  const method = pStr(params, 'method') ?? 'implied'
  const source = pStr(params, 'source') ?? 'search'
  const date = pDate(params, 'date')
  const lookbackDays = pNum(params, 'lookback_days') ?? 7
  const maxStalenessDays = pNum(params, 'max_staleness_days') ?? null
  const aggregation = pStr(params, 'aggregation') ?? 'median'
  const minTrades = pNum(params, 'min_trades') ?? 1
  const interpolation = pStr(params, 'interpolation') ?? 'log_linear'
  const fisn = oisFisn(currency)

  let records: SliceRecord[]
  let reportDate: D | null
  if (source === 'slice') {
    ;[records, reportDate] = await getLatestViableSlice(ctx, 'rates', (recs, day) => extractObservations(recs, { tradeDate: day, fisn, currency }).length > 0, { maxLookback: lookbackDays, endDate: date ?? null })
  } else {
    const endDate = date ?? todayOf(ctx.now())
    records = await searchTrades(ctx, 'rates', addDays(endDate, -(lookbackDays - 1)), endDate, { currency, upiShortName: fisn })
    reportDate = null
  }

  const spec = (oisIndices as Record<string, { index: string; day_count: string }>)[currency]
  if (!spec) throw new Error(`KeyError: '${currency}'`)
  const forwardYears = tenorToYears(forwardTenor)
  const stepYears = tenorToYears(forwardStep)
  let curve: Rec[]
  let curveDate: D
  if (reportDate === null) {
    curve = buildCurveAsOf(records, fisn, { currency, aggregation, minTrades, interpolation, maxStalenessDays })
    curveDate = curve[0]!.date as D
  } else {
    curve = buildCurve(records, reportDate, fisn, { currency, aggregation, minTrades, interpolation })
    curveDate = reportDate
  }
  const basis = dayCountBasis(spec.day_count, 'A004')
  const period = curvePaymentPeriod(records, currency, curveDate, minTrades)

  let grid: { tenor_years: number; tenor_days: number; forward_rate: number; forward_extrapolated: boolean; num_trades: number }[]
  if (method === 'observed') {
    const spotDfs: [number, number][] = curve
      .filter((n) => n.discount_factor !== null && n.discount_factor !== undefined)
      .map((n) => [n.tenor_years as number, n.discount_factor as number] as [number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const forwardTenorDays = pyRound(forwardYears * 365.0, 0)
    grid = observedForwardGrid(records, fisn, currency, curveDate, { forwardTenorDays, stepYears, count: forwardCount, minTrades, spotRate: parRateAt(spotDfs, forwardTenorDays, basis, period, interpolation) })
  } else {
    grid = forwardCurveGrid(curve, forwardYears, stepYears, basis, forwardCount, period) as typeof grid
  }
  const rows: Rec[] = grid.map((point) => ({
    date: curveDate,
    currency,
    index: addDays(curveDate, point.tenor_days),
    tenor: `${forwardTenor} @ ${pyFixed(point.tenor_years, 2)}Y`,
    start_years: point.tenor_years,
    forward_rate: point.forward_rate * 100.0,
    extrapolated: point.forward_extrapolated,
    num_trades: point.num_trades,
  }))
  if (rows.length === 0) throw new Error(`No ${currency} forward curve could be built for the requested date.`)
  return rows.map((r) => validateRow(OIS_FORWARD_CURVE_SCHEMA, r))
}

// ---- cftc/ois_policy_path -------------------------------------------------------------------------------------------

export const oisPolicyPath: NativeHandler = async (params, ctx) => {
  const currency = (pStr(params, 'currency') ?? 'USD').toUpperCase()
  const lookbackDays = pNum(params, 'lookback_days') ?? 10
  const minTrades = pNum(params, 'min_trades') ?? 3
  const fisn = oisFisn(currency)
  const end = pDate(params, 'date') ?? todayOf(ctx.now())
  const dates = await getAvailableDates(ctx, 'rates')
  const window = dates.filter((d) => d <= end).slice(-lookbackDays)
  if (window.length === 0) throw new Error(`No rates files are published on or before ${end}. History is retained for 366 days.`)
  const combined: SliceRecord[] = []
  for (const day of window) {
    const records = await getSlice(ctx, 'rates', day)
    const stamp = `${day}T00:00:00Z`
    for (const record of records) if ((record['UPI FISN'] ?? '').trim() === fisn) combined.push({ ...record, 'Dissemination Timestamp': stamp })
  }
  const referenceDate = window[window.length - 1]!
  const path = buildPolicyPath(combined, fisn, currency, referenceDate, minTrades)
  return path.map((node) =>
    validateRow(OIS_POLICY_PATH_SCHEMA, {
      ...node,
      date: referenceDate,
      currency,
      index: node.start_date,
      rate: node.rate * 100.0,
      min_rate: node.min_rate * 100.0,
      max_rate: node.max_rate * 100.0,
    }),
  )
}

// ---- cftc/historical_fixings ----------------------------------------------------------------------------------------

const DEFAULT_LOOKBACK_DAYS = 365

export const historicalFixings: NativeHandler = async (params, ctx) => {
  const index = (pStr(params, 'index') ?? 'SOFR').toUpperCase()
  const endDate = pDate(params, 'end_date') ?? todayOf(ctx.now())
  const startDate = pDate(params, 'start_date') ?? addDays(endDate, -DEFAULT_LOOKBACK_DAYS)
  if (!(index in FIXING_SOURCES)) {
    const choices = Object.keys(FIXING_SOURCES).sort((a, b) => {
      const ca = fixingProfile(a)[1]
      const cb = fixingProfile(b)[1]
      return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : a > b ? 1 : 0
    })
    throw new EmptyDataError(`'${index}' is not a published benchmark. Choose one of: ${choices.join(', ')}.`)
  }
  const fixings = await getFixings(ctx, index, startDate, endDate)
  const days = Object.keys(fixings).sort()
  if (days.length === 0) throw new EmptyDataError(`No ${index} fixings were published between ${startDate} and ${endDate}.`)
  const rows: Rec[] = []
  let previous: number | null = null
  for (const day of days) {
    const rate = 100.0 * fixings[day]!
    rows.push({ date: day, rate, change_bps: previous === null ? null : pyRound(100.0 * (rate - previous), 2) })
    previous = rate
  }
  return rows.map((r) => validateRow(HISTORICAL_FIXINGS_SCHEMA, r)) as Row[]
}
