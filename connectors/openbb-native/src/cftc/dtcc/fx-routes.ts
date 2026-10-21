// cftc/fx_forward_points, fx_forward_curve and fx_implied_vol, provider cftc. Ported from
// openbb_cftc/models/{fx_forward_points,fx_forward_curve,fx_implied_vol}.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models (model.ts), slices are memoised with ctx.cache.
import type { NativeCtx, NativeHandler, NativeParams } from '../../types.js'
import { currencyBasis, fxPairs, oisIndices } from './constants.js'
import { EmptyDataError, type Rec, type SliceRecord } from './curve.js'
import { addDays, todayOf, type D } from './dates.js'
import { getLatestViableSlice, getRatesSliceFor, getSlice } from './dtcc.js'
import { buildForwardPoints, buildForwardPointsAsOf, buildFxForwardCurve, buildFxForwardCurveAsOf } from './fx.js'
import { cipForwardRate } from './fx-theory.js'
import { extractVanillaOptions, fxSpot, hasVanillaOptions, impliedDf, isNdfVolPair, ndfForwardCurve, oisDiscountFactor, priceOptions, rateDiscountFactor, resolveMajorPair, theoreticalSurface, volSurface } from './fx-vol.js'
import { validateRow } from './model.js'
import { pDate, pNum, pStr } from './params.js'
import { FX_FORWARD_CURVE_SCHEMA, FX_FORWARD_POINTS_SCHEMA, FX_IMPLIED_VOL_SCHEMA } from './schemas.js'
import { searchTrades } from './search.js'

/** Fetch the forward and swap prints of a pair: one slice, or a search over a lookback window. */
async function pairPrints(ctx: NativeCtx, p: { pair: string; source: string; date: D | undefined; lookbackDays: number }): Promise<{ records: SliceRecord[]; reportDate: D | null; endDate: D }> {
  const spec = fxPairs[p.pair]!
  const fisns = [spec.forward_fisn, spec.swap_fisn]
  if (p.source === 'slice') {
    let records: SliceRecord[]
    let reportDate: D
    if (p.date) {
      reportDate = p.date
      records = await getSlice(ctx, 'forex', reportDate)
    } else {
      ;[records, reportDate] = await getLatestViableSlice(ctx, 'forex', (recs) => recs.some((r) => fisns.includes((r['UPI FISN'] ?? '').trim())))
    }
    return { records, reportDate, endDate: reportDate }
  }
  const endDate = p.date ?? todayOf(ctx.now())
  const startDate = addDays(endDate, -(p.lookbackDays - 1))
  const records: SliceRecord[] = []
  for (const fisn of fisns) records.push(...(await searchTrades(ctx, 'forex', startDate, endDate, { upiShortName: fisn })))
  return { records, reportDate: null, endDate }
}

export const fxForwardPoints: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const pair = (pStr(params, 'pair') ?? 'EURUSD').toUpperCase()
  const source = pStr(params, 'source') ?? 'search'
  const minNotional = pNum(params, 'min_notional') ?? 1_000_000.0
  const minTrades = pNum(params, 'min_trades') ?? 1
  const base = pair.slice(0, 3)
  const quote = pair.slice(3)
  const spec = fxPairs[pair]
  if (!spec) throw new Error(`KeyError: '${pair}'`)
  const oisLegs = [base, quote].filter((leg) => leg in oisIndices)
  const { records, reportDate, endDate } = await pairPrints(ctx, { pair, source, date: pDate(params, 'date'), lookbackDays: pNum(params, 'lookback_days') ?? 30 })
  const [rates, ratesDate] = await getRatesSliceFor(ctx, reportDate ?? endDate, oisLegs)

  const points: Rec[] = reportDate === null ? buildForwardPointsAsOf(records, pair, { minNotional, minTrades }) : buildForwardPoints(records, pair, reportDate, { minNotional, minTrades })

  const quoteMin = spec.ndf ? 1 : 3
  let dfQuote: ((y: number) => number) | null
  let dfBase: ((y: number) => number) | null
  try {
    dfQuote = rateDiscountFactor(rates, quote, ratesDate, quoteMin, true)
    dfBase = rateDiscountFactor(rates, base, ratesDate, 3, true)
  } catch (err) {
    if (!(err instanceof EmptyDataError)) throw err
    dfQuote = dfBase = null
  }
  if (dfQuote !== null && dfBase !== null) {
    const pip = spec.pip
    const basisQuote = currencyBasis(quote)
    const basisBase = currencyBasis(base)
    for (const point of points) {
      const days = point.tenor_days as number
      if (days <= 0) continue
      const years = days / 365.0
      const rQ = ((1.0 / dfQuote(years) - 1.0) * basisQuote) / days
      const rB = ((1.0 / dfBase(years) - 1.0) * basisBase) / days
      const forward = cipForwardRate(point.spot_rate as number, rQ, rB, days, basisQuote, basisBase)
      const theoretical = (forward - (point.spot_rate as number)) * pip
      point.theoretical_points = theoretical
      point.basis_points = (point.forward_points as number) - theoretical
    }
  }
  for (const point of points) {
    const forwardPoints = point.forward_points as number | null | undefined
    if (!forwardPoints) {
      point.quotation = '--'
      point.carry = '--'
      continue
    }
    point.quotation = forwardPoints > 0 ? 'premium' : 'discount'
    point.carry = forwardPoints > 0 ? 'pay' : 'earn'
  }
  return points.map((p) => validateRow(FX_FORWARD_POINTS_SCHEMA, p))
}

export const fxForwardCurve: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const pair = (pStr(params, 'pair') ?? 'USDJPY').toUpperCase()
  const source = pStr(params, 'source') ?? 'search'
  const minNotional = pNum(params, 'min_notional') ?? 1_000_000.0
  const minTrades = pNum(params, 'min_trades') ?? 1
  if (!fxPairs[pair]) throw new Error(`KeyError: '${pair}'`)
  const { records, reportDate } = await pairPrints(ctx, { pair, source, date: pDate(params, 'date'), lookbackDays: pNum(params, 'lookback_days') ?? 30 })
  const nodes = reportDate === null ? buildFxForwardCurveAsOf(records, pair, { minNotional, minTrades }) : buildFxForwardCurve(records, pair, reportDate, { minNotional, minTrades })
  for (const node of nodes) {
    node.pair = pair
    node.index = node.tenor
  }
  return nodes.map((n) => validateRow(FX_FORWARD_CURVE_SCHEMA, n))
}

const VOL_FIELDS = ['vol_1w', 'vol_2w', 'vol_1m', 'vol_2m', 'vol_3m', 'vol_6m', 'vol_9m', 'vol_1y', 'vol_2y']

export const fxImpliedVol: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const pair = (pStr(params, 'pair') ?? 'EURUSD').toUpperCase()
  const basisMode = pStr(params, 'basis') ?? 'empirical'
  const date = pDate(params, 'date')
  const minTrades = pNum(params, 'min_trades') ?? 3
  const [base, quote, pip] = resolveMajorPair(pair)
  const ndf = isNdfVolPair(pair)

  const viable = (recs: SliceRecord[], day: D): boolean => {
    if (ndf) return hasVanillaOptions(recs, base, quote, 'NA/O NDO ') && ndfForwardCurve(recs, pair, day)[0] !== null
    return hasVanillaOptions(recs, base, quote) && fxSpot(recs, base, quote, day) !== null
  }
  const [forex, reportDate] = await getLatestViableSlice(ctx, 'forex', viable, { endDate: date ?? null })
  const [rates, ratesDate] = await getRatesSliceFor(ctx, reportDate, ndf ? [base] : [base, quote])

  let spot: number | null
  let dfBase: (y: number) => number
  let dfQuote: (y: number) => number
  let options
  if (ndf) {
    const [s, forward] = ndfForwardCurve(forex, pair, reportDate)
    if (s === null || forward === null) throw new Error(`No spot could be established for ${pair} on ${reportDate}.`)
    spot = s
    dfBase = oisDiscountFactor(rates, base, ratesDate, minTrades, true)
    dfQuote = impliedDf(dfBase, s, forward)
    options = extractVanillaOptions(forex, base, quote, reportDate, s, 'NA/O NDO ')
  } else {
    spot = fxSpot(forex, base, quote, reportDate)
    if (spot === null) throw new Error(`No spot could be established for ${pair} on ${reportDate}.`)
    dfQuote = oisDiscountFactor(rates, quote, ratesDate, minTrades, true)
    dfBase = oisDiscountFactor(rates, base, ratesDate, minTrades, true)
    options = extractVanillaOptions(forex, base, quote, reportDate, spot)
  }
  const priced = priceOptions(options, spot, dfQuote, dfBase)
  const rows: Rec[] = basisMode === 'theoretical' ? theoreticalSurface(priced, spot, dfQuote, dfBase, pip, ndf)[0] : volSurface(priced, spot, pip, ndf)
  if (rows.length === 0 || rows.every((row) => row.num_options === 0)) throw new Error(`No ${pair} ${basisMode} volatility surface could be built on ${reportDate}. Try the 'empirical' basis, or another date.`)
  for (const row of rows) {
    row.date = reportDate
    row.pair = pair
    for (const field of VOL_FIELDS) if (row[field] !== null && row[field] !== undefined) row[field] = (row[field] as number) * 100.0
  }
  const keys = new Set(rows.flatMap((row) => Object.keys(row)))
  for (const field of keys) if (rows.every((row) => row[field] === null || row[field] === undefined)) for (const row of rows) delete row[field]
  return rows.map((r) => validateRow(FX_IMPLIED_VOL_SCHEMA, r))
}
