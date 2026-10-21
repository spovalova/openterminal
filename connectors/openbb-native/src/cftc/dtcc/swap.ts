// Fixed-rate swap valuation against a bootstrapped DTCC rate curve. Ported from openbb_cftc/utils/swap.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: dates are ISO strings.
import { pyRound } from '../helpers.js'
import { ZERO_RATE_BASIS, dayCountBasis, rateCurveFisns } from './constants.js'
import {
  EmptyDataError,
  curveDayCountBasis,
  curvePaymentPeriod,
  isVanillaPar,
  paymentOffsets,
  parseDate,
  parseFrequency,
  parseNotional,
  parseRate,
  pyFloat,
  type Rec,
  type SliceRecord,
} from './curve.js'
import { qualifiedKeys } from './dtcc.js'
import { addDays, clampedDate, daysInMonth, diffDays, month, year, type D } from './dates.js'
import { compoundFixings, fixingBasis, indexForUnderlier, type Fixings } from './fixings.js'
import { rateDiscountFactor, type DiscountFn } from './fx-vol.js'
import { brlBusinessDaysBetween } from './br-calendar.js'
import { breakevenAt, buildBreakevenCurve, INFLATION_INDICES, indexForInflationUnderlier, indexRatio, type Levels } from './inflation.js'
import { pyMedian, pySum } from './num.js'

const BUS_252_BASIS = 252.0
const ONE_ONE_BASIS = -1.0

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/** One leg's reported day count, honouring BUS/252 and 1/1 first (`_leg_day_count_basis`). */
export function legDayCountBasis(code: string | null | undefined, dflt: string): number | null {
  const reported = (code ?? '').trim()
  if (!reported) return null
  if (reported === 'A018') return BUS_252_BASIS
  if (reported === 'A020') return ONE_ONE_BASIS
  return dayCountBasis(reported, dflt)
}

/** A period's accrued fraction of a year, honouring non-divisor bases (`_year_fraction`). */
export function yearFraction(begin: D, finish: D, basis: number): number {
  if (basis === ONE_ONE_BASIS) return 1.0
  if (basis === BUS_252_BASIS) return brlBusinessDaysBetween(begin, finish) / BUS_252_BASIS
  return diffDays(finish, begin) / basis
}

/** The currency's discount function, fixed-leg accrual basis and coupon period (`_discount_curve`). */
export function discountCurve(records: SliceRecord[], currency: string, tradeDate: D, minTrades: number): [DiscountFn, number, number] {
  const discount = rateDiscountFactor(records, currency, tradeDate, minTrades)
  const basis = curveDayCountBasis(records, currency, tradeDate, minTrades)
  const period = curvePaymentPeriod(records, currency, tradeDate, minTrades)
  return [discount, basis, period]
}

export type Schedule = [D, D, number][]

/** A leg's reported accrual periods, or null (`parse_leg_schedule`). */
export function parseLegSchedule(record: SliceRecord, leg: string): Schedule | null {
  const starts = sf(record, `Effective date of the notional amount-Leg ${leg}`)
  const ends = sf(record, `End date of the notional amount-Leg ${leg}`)
  const amounts = sf(record, `Notional amount in effect on associated effective date-Leg ${leg}`)
  if (!(starts && ends && amounts)) return null
  const opened = starts.split(';').map((v) => parseDate(v))
  const closed = ends.split(';').map((v) => parseDate(v))
  const sizes = amounts.split(';').map((v) => parseNotional(v)[0])
  if (!(opened.length === closed.length && closed.length === sizes.length)) return null
  const periods: Schedule = []
  opened.forEach((begin, i) => {
    const finish = closed[i]!
    const size = sizes[i]!
    if (begin && finish && size && finish > begin) periods.push([begin, finish, size])
  })
  periods.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2]))
  return periods.length > 0 ? periods : null
}

/** Advance a date by a reported calendar frequency (`_advance`). */
function advance(when: D, unit: string, count: number): D {
  if (unit === 'YEAR' || unit === 'MNTH') {
    const months = month(when) - 1 + count * (unit === 'YEAR' ? 12 : 1)
    const y = year(when) + Math.floor(months / 12)
    const m = (((months % 12) + 12) % 12) + 1
    return clampedDate(y, m, Math.min(Number(when.slice(8, 10)), daysInMonth(y, m)))
  }
  if (unit === 'WEEK') return addDays(when, 7 * count)
  return addDays(when, count)
}

export type Frequency = [string, number] | null

export type Period = { start_days: number; end_days: number; year_fraction: number; elapsed_year_fraction: number; notional: number }

/** One leg's accrual periods, on the terms the trade reported for it (`leg_periods`). */
export function legPeriods(curveDate: D, effective: D, expiration: D, notional: number, basis: number, frequency: Frequency, fallbackPeriodDays: number, schedule: Schedule | null = null): Period[] {
  const periods: Period[] = []

  const add = (begin: D, finish: D, size: number): void => {
    if (finish <= curveDate) return
    let elapsed = 0.0
    if (begin < curveDate) {
      elapsed = yearFraction(begin, curveDate, basis)
      begin = curveDate
    }
    periods.push({ start_days: diffDays(begin, curveDate), end_days: diffDays(finish, curveDate), year_fraction: yearFraction(begin, finish, basis), elapsed_year_fraction: elapsed, notional: size })
  }

  const roll = (start: D, size: number): void => {
    if (frequency !== null && frequency[0] === 'EXPI') {
      add(start, expiration, size)
      return
    }
    if (frequency !== null) {
      let current = start
      while (current < expiration) {
        const next = advance(current, frequency[0], frequency[1])
        const finish = next < expiration ? next : expiration
        add(current, finish, size)
        current = finish
      }
      return
    }
    let previous = 0
    for (const offset of paymentOffsets(diffDays(expiration, start), fallbackPeriodDays)) {
      add(addDays(start, previous), addDays(start, offset), size)
      previous = offset
    }
  }

  if (schedule && schedule.length > 0) {
    for (const [begin, finish, size] of schedule) add(begin, finish, size)
    const last = schedule[schedule.length - 1]!
    if (last[1] < expiration) roll(last[1], last[2])
  } else roll(effective, notional)
  return periods
}

/** 'spot' or 'forward': a single-currency fixed-vs-floating swap in a recognized family (`classify_fixed_vs_float`). */
export function classifyFixedVsFloat(record: SliceRecord, currency: string, today: D): string | null {
  const fisn = sf(record, 'UPI FISN')
  if (!rateCurveFisns(currency).includes(fisn)) return null
  const effective = parseDate(record['Effective Date'])
  if (effective === null) return null
  return effective > today ? 'forward' : 'spot'
}

/** 'basis' or 'cross_currency': a genuine float-vs-float swap (`classify_float_float`). */
export function classifyFloatFloat(record: SliceRecord, currency: string): string | null {
  const currency2 = sf(record, 'Notional currency-Leg 2')
  if (!currency || !currency2) return null
  const fisn = sf(record, 'UPI FISN')
  if (!fisn.startsWith('NA/Swap Flt Flt')) return null
  return currency !== currency2 ? 'cross_currency' : 'basis'
}

/** A rates-asset-class print classified into one of five trade-type families, or null (`classify_rates_swap`). */
export function classifyRatesSwap(record: SliceRecord, today: D): string | null {
  if (sf(record, 'Action type') !== 'NEWT') return null
  if (sf(record, 'Event type') !== 'TRAD') return null
  const expiration = parseDate(record['Expiration Date'])
  if (expiration === null || expiration <= today) return null
  const currency = sf(record, 'Notional currency-Leg 1')
  if (parseRate(record) === null) return classifyFloatFloat(record, currency)
  if (sf(record, 'UPI FISN').startsWith('NA/Swap Infl Idx')) return 'inflation'
  return classifyFixedVsFloat(record, currency, today)
}

/** The leg carrying a real, nonzero spread, or null (`parse_spread`). */
export function parseSpread(record: SliceRecord): [number, number] | null {
  for (const leg of [1, 2]) {
    const text = sf(record, `Spread-Leg ${leg}`)
    if (!text) continue
    const spread = pyFloat(text)
    if (spread === null) continue
    if (spread !== 0) return [leg, spread]
  }
  return null
}

/** The fixing indices of a basis/cross-currency underlier (`indices_for_spread_underlier`). */
export function indicesForSpreadUnderlier(underlier: string | null | undefined): [string | null, string | null] {
  const parts = (underlier ?? '').split(' vs ')
  if (parts.length !== 2) return [null, null]
  return [indexForUnderlier(parts[0]!), indexForUnderlier(parts[1]!)]
}

export type OtherPayment = { type: string; amount: number; currency: string | null }

/** A print's disseminated other payments, one per semicolon-joined entry (`parse_other_payments`). */
export function parseOtherPayments(record: SliceRecord): OtherPayment[] {
  const types = (record['Other payment type'] ?? '').split(';').map((t) => t.trim())
  const amounts = (record['Other payment amount'] ?? '').split(';').map((a) => a.trim())
  const currencies = (record['Other payment currency'] ?? '').split(';').map((c) => c.trim())
  const payments: OtherPayment[] = []
  types.forEach((kind, index) => {
    if (!kind) return
    const raw = index < amounts.length ? amounts[index]! : ''
    const amount = pyFloat(raw.replace(/,/g, ''))
    if (amount === null) return
    payments.push({ type: kind, amount, currency: (index < currencies.length ? currencies[index]! : '') || null })
  })
  return payments
}

/** A package print's monetary package price, or null when not disseminated (`parse_package_price`). */
export function parsePackagePrice(record: SliceRecord): { amount: number; currency: string | null } | null {
  if (sf(record, 'Package transaction price notation') !== '1') return null
  const amount = pyFloat(sf(record, 'Package transaction price').replace(/,/g, ''))
  if (amount === null) return null
  return { amount, currency: sf(record, 'Package transaction price currency') || null }
}

const isPackage = (record: SliceRecord): boolean => sf(record, 'Package indicator').toUpperCase() === 'TRUE'

/** One zero-coupon inflation print's own priceable terms, or null (`extract_inflation_trade`). */
export function extractInflationTrade(record: SliceRecord, curveDate: D, minNotional = 0.0): Rec | null {
  if (classifyRatesSwap(record, curveDate) !== 'inflation') return null
  const rate = parseRate(record)
  const effective = parseDate(record['Effective Date'])
  const expiration = parseDate(record['Expiration Date'])
  if (rate === null || effective === null || expiration === null) return null
  const maturityDays = diffDays(expiration, effective)
  if (maturityDays <= 0) return null
  const [notional, capped] = parseNotional(record['Notional amount-Leg 1'])
  if (!notional || notional < minNotional) return null
  const underlier = sf(record, 'UPI Underlier Name') || null
  return {
    dissemination_identifier: sf(record, 'Dissemination Identifier'),
    trade_key: qualifiedKeys(record)['Trade Key'] ?? null,
    upi_fisn: sf(record, 'UPI FISN'),
    underlier,
    index: indexForInflationUnderlier(underlier),
    trade_type: 'inflation',
    currency: sf(record, 'Notional currency-Leg 1'),
    traded_breakeven: rate,
    effective_date: effective,
    expiration_date: expiration,
    start_days: diffDays(effective, curveDate),
    maturity_days: maturityDays,
    notional,
    is_capped: capped,
    cleared: sf(record, 'Cleared').toUpperCase() || null,
    other_payments: parseOtherPayments(record),
    package_indicator: isPackage(record),
    package_price: parsePackagePrice(record),
  }
}

/** One basis/cross-currency print's own priceable terms, or null (`extract_spread_trade`). */
export function extractSpreadTrade(record: SliceRecord, curveDate: D, minNotional = 0.0): Rec | null {
  const tradeType = classifyRatesSwap(record, curveDate)
  if (tradeType !== 'basis' && tradeType !== 'cross_currency') return null
  const spread = parseSpread(record)
  if (spread === null) return null
  const [leg, tradedSpread] = spread
  const otherLeg = leg === 1 ? 2 : 1
  const currency = sf(record, `Notional currency-Leg ${leg}`)
  const otherCurrency = sf(record, `Notional currency-Leg ${otherLeg}`)
  const [notional, capped] = parseNotional(record[`Notional amount-Leg ${leg}`])
  const [otherNotional, otherCapped] = parseNotional(record[`Notional amount-Leg ${otherLeg}`])
  const effective = parseDate(record['Effective Date'])
  const expiration = parseDate(record['Expiration Date'])
  if (effective === null || expiration === null) return null
  const maturityDays = diffDays(expiration, effective)
  if (maturityDays <= 0) return null
  if (!notional || notional < minNotional) return null
  if (tradeType === 'cross_currency' && (capped || otherCapped || otherNotional === null || otherNotional <= 0)) return null
  const underlier = sf(record, 'UPI Underlier Name') || null
  const [leg1Index, leg2Index] = indicesForSpreadUnderlier(underlier)
  const spreadIndex = leg === 1 ? leg1Index : leg2Index
  const otherIndex = leg === 1 ? leg2Index : leg1Index
  const legBasis = (fieldLeg: number): number | null => legDayCountBasis(record[`Floating rate day count convention-leg ${fieldLeg}`], 'A004')
  const legFrequency = (fieldLeg: number): Frequency => parseFrequency(record[`Floating rate payment frequency period-Leg ${fieldLeg}`], record[`Floating rate payment frequency period multiplier-Leg ${fieldLeg}`])
  return {
    dissemination_identifier: sf(record, 'Dissemination Identifier'),
    trade_key: qualifiedKeys(record)['Trade Key'] ?? null,
    upi_fisn: sf(record, 'UPI FISN'),
    underlier,
    trade_type: tradeType,
    currency,
    spread_leg: leg,
    traded_spread: tradedSpread,
    spread_index: spreadIndex,
    effective_date: effective,
    expiration_date: expiration,
    start_days: diffDays(effective, curveDate),
    maturity_days: maturityDays,
    notional,
    is_capped: capped,
    cleared: sf(record, 'Cleared').toUpperCase() || null,
    basis: legBasis(leg),
    frequency: legFrequency(leg),
    other_currency: otherCurrency,
    other_notional: otherNotional,
    other_index: otherIndex,
    other_basis: legBasis(otherLeg),
    other_frequency: legFrequency(otherLeg),
    other_payments: parseOtherPayments(record),
    package_indicator: isPackage(record),
    package_price: parsePackagePrice(record),
  }
}

/** The same-day median traded spread for this exact underlier and leg, and its count (`reference_spread`). */
export function referenceSpread(records: SliceRecord[], underlier: string, tradeType: string, spreadLeg: number, curveDate: D, minTrades = 1): [number, number] | null {
  const spreads: number[] = []
  for (const record of records) {
    if (classifyRatesSwap(record, curveDate) !== tradeType) continue
    if (sf(record, 'UPI Underlier Name') !== underlier) continue
    const parsed = parseSpread(record)
    if (parsed !== null && parsed[0] === spreadLeg) spreads.push(parsed[1])
  }
  if (spreads.length < minTrades) return null
  return [pyMedian(spreads), spreads.length]
}

type Summary = Rec

/** Price a basis/cross-currency swap's spread-bearing leg against a same-day reference (`_price_spread`). */
function priceSpread(discount: DiscountFn, periods: Period[], tradeDate: D, referenceLevel: number, tradedSpread: number, side: string): [Rec[], Summary] {
  let annuity = 0.0
  const schedule: Rec[] = []
  periods.forEach((period, i) => {
    const factor = discount(period.end_days / ZERO_RATE_BASIS)
    annuity += period.notional * period.year_fraction * factor
    schedule.push({
      period: i + 1,
      start_date: addDays(tradeDate, period.start_days),
      payment_date: addDays(tradeDate, period.end_days),
      year_fraction: period.year_fraction,
      notional: period.notional,
      discount_factor: factor,
      fixed_rate: tradedSpread,
      fixed_cashflow: period.notional * tradedSpread * period.year_fraction,
      forward_rate: referenceLevel,
      floating_rate: referenceLevel,
      floating_notional: period.notional,
      floating_cashflow: period.notional * referenceLevel * period.year_fraction,
    })
  })
  for (const row of schedule) {
    row.fixed_pv = (row.fixed_cashflow as number) * (row.discount_factor as number)
    row.floating_pv = (row.floating_cashflow as number) * (row.discount_factor as number)
  }
  const sign = side === 'pay' ? 1.0 : -1.0
  const fixedLegPv = tradedSpread * annuity
  const floatingLegPv = referenceLevel * annuity
  const npv = sign * (referenceLevel - tradedSpread) * annuity
  return [schedule, { par_rate: referenceLevel, annuity, fixed_leg_pv: fixedLegPv, floating_leg_pv: floatingLegPv, npv, dv01: annuity * 1e-4 }]
}

/** Value a same-currency basis swap's spread-bearing leg against a same-day reference (`value_spread_swap`). */
export function valueSpreadSwap(records: SliceRecord[], trade: Rec, curveDate: D, side = 'pay', minTrades = 1): [Rec[], Summary] {
  const reference = referenceSpread(records, trade.underlier as string, trade.trade_type as string, trade.spread_leg as number, curveDate, minTrades)
  if (reference === null) throw new EmptyDataError(`Not enough same-day '${trade.underlier}' prints to derive a reference spread on ${curveDate} (need at least ${minTrades}).`)
  const [referenceLevel, numTrades] = reference
  const [discount, curveBasis, curvePeriod] = discountCurve(records, trade.currency as string, curveDate, minTrades)
  const periods = legPeriods(curveDate, trade.effective_date as D, trade.expiration_date as D, trade.notional as number, (trade.basis as number | null) || curveBasis, trade.frequency as Frequency, curvePeriod, null)
  const [schedule, summary] = priceSpread(discount, periods, curveDate, referenceLevel, trade.traded_spread as number, side)
  summary.reference_trade_count = numTrades
  return [schedule, summary]
}

/** Price a cross-currency swap by projecting and discounting each leg on its own curve (`_price_cross_currency`). */
function priceCrossCurrency(
  spreadDiscount: DiscountFn,
  otherDiscount: DiscountFn,
  spreadPeriods: Period[],
  otherPeriods: Period[],
  spreadNotional: number,
  otherNotional: number,
  o: { spot: number; tradeDate: D; tradedSpread: number; side: string },
): [Rec[], Summary] {
  let spreadAnnuity = 0.0
  let spreadLegPv = 0.0
  const schedule: Rec[] = []
  spreadPeriods.forEach((period, i) => {
    const opening = spreadDiscount(period.start_days / ZERO_RATE_BASIS)
    const closing = spreadDiscount(period.end_days / ZERO_RATE_BASIS)
    const yf = period.year_fraction
    const forward = (opening / closing - 1.0) / yf
    spreadAnnuity += period.notional * yf * closing
    spreadLegPv += period.notional * forward * yf * closing
    schedule.push({ period: i + 1, start_date: addDays(o.tradeDate, period.start_days), payment_date: addDays(o.tradeDate, period.end_days), year_fraction: yf, notional: period.notional, discount_factor: closing })
  })
  let otherLegPvNative = 0.0
  for (const period of otherPeriods) {
    const opening = otherDiscount(period.start_days / ZERO_RATE_BASIS)
    const closing = otherDiscount(period.end_days / ZERO_RATE_BASIS)
    const yf = period.year_fraction
    const forward = (opening / closing - 1.0) / yf
    otherLegPvNative += period.notional * forward * yf * closing
  }
  const otherLegPv = otherLegPvNative * o.spot
  for (const row of schedule) {
    row.fixed_rate = o.tradedSpread
    row.fixed_cashflow = (row.notional as number) * o.tradedSpread * (row.year_fraction as number)
    row.fixed_pv = (row.fixed_cashflow as number) * (row.discount_factor as number)
  }
  const maturityYears = spreadPeriods[spreadPeriods.length - 1]!.end_days / ZERO_RATE_BASIS
  const exchangePv = otherNotional * o.spot * otherDiscount(maturityYears) - spreadNotional * spreadDiscount(maturityYears)
  const fixedLegPv = o.tradedSpread * spreadAnnuity
  const parRate = (otherLegPv - spreadLegPv + exchangePv) / spreadAnnuity
  const sign = o.side === 'pay' ? 1.0 : -1.0
  const npv = sign * (otherLegPv - spreadLegPv - fixedLegPv + exchangePv)
  return [schedule, { par_rate: parRate, annuity: spreadAnnuity, fixed_leg_pv: fixedLegPv, floating_leg_pv: otherLegPv, exchange_pv: exchangePv, npv, dv01: spreadAnnuity * 1e-4 }]
}

/** Value a cross-currency swap's spread-bearing leg against the other leg's own curve (`value_cross_currency_swap`). */
export function valueCrossCurrencySwap(records: SliceRecord[], trade: Rec, curveDate: D, spot: number, side = 'pay', minTrades = 1): [Rec[], Summary] {
  const [spreadDiscount, spreadCurveBasis, spreadCurvePeriod] = discountCurve(records, trade.currency as string, curveDate, minTrades)
  const [otherDiscount, otherCurveBasis, otherCurvePeriod] = discountCurve(records, trade.other_currency as string, curveDate, minTrades)
  const spreadPeriods = legPeriods(curveDate, trade.effective_date as D, trade.expiration_date as D, trade.notional as number, (trade.basis as number | null) || spreadCurveBasis, trade.frequency as Frequency, spreadCurvePeriod, null)
  const otherPeriods = legPeriods(curveDate, trade.effective_date as D, trade.expiration_date as D, trade.other_notional as number, (trade.other_basis as number | null) || otherCurveBasis, trade.other_frequency as Frequency, otherCurvePeriod, null)
  return priceCrossCurrency(spreadDiscount, otherDiscount, spreadPeriods, otherPeriods, trade.notional as number, trade.other_notional as number, { spot, tradeDate: curveDate, tradedSpread: trade.traded_spread as number, side })
}

/** Value a zero-coupon inflation swap off traded breakevens and its base index (`value_inflation_swap`). */
export function valueInflationSwap(
  records: SliceRecord[],
  trade: Rec,
  curveDate: D,
  o: { levels?: Levels | null; side?: string; minTrades?: number; breakevenRecords?: SliceRecord[] | null; breakevenDate?: D | null } = {},
): [Rec[], Summary] {
  const side = o.side ?? 'pay'
  const minTrades = o.minTrades ?? 1
  const currency = trade.currency as string
  const [discount] = discountCurve(records, currency, curveDate, minTrades)
  const curve = buildBreakevenCurve(o.breakevenRecords ?? records, currency, o.breakevenDate || curveDate, minTrades)
  if (curve.length === 0) throw new EmptyDataError(`No ${currency} zero-coupon inflation prints were disseminated on ${o.breakevenDate || curveDate} to imply a breakeven.`)
  const effective = trade.effective_date as D
  const expiration = trade.expiration_date as D
  const totalYears = diffDays(expiration, effective) / 365.0
  const remainingYears = Math.max(diffDays(expiration, curveDate), 0) / 365.0
  const forwardBreakeven = breakevenAt(curve, remainingYears || totalYears)
  if (forwardBreakeven === null) throw new EmptyDataError(`The ${currency} inflation curve on ${curveDate} could not price a ${totalYears.toFixed(2)}-year tenor.`)
  const spec = INFLATION_INDICES[(trade.index as string | null) || ''] as (typeof INFLATION_INDICES)[string] | undefined
  let realizedRatio: number | null = null
  let realizedNote: string | null = null
  if (effective < curveDate) {
    if (!o.levels || !spec) realizedNote = 'The elapsed index ratio needs the published index this trade references, which is not available.'
    else {
      realizedRatio = indexRatio(o.levels, effective, curveDate, spec.lag_months, spec.interpolate)
      if (realizedRatio === null) realizedNote = "The published index does not yet cover this trade's base reference month."
    }
  }
  const elapsedYears = Math.max(diffDays(curveDate, effective), 0) / 365.0
  const projectedRatio = Math.pow(1.0 + forwardBreakeven, remainingYears)
  let indexRatioTotal: number | null
  let parBreakeven: number | null
  if (effective >= curveDate) {
    indexRatioTotal = Math.pow(1.0 + forwardBreakeven, totalYears)
    parBreakeven = forwardBreakeven
  } else if (realizedRatio !== null) {
    indexRatioTotal = realizedRatio * projectedRatio
    parBreakeven = Math.pow(indexRatioTotal, 1.0 / totalYears) - 1.0
  } else {
    indexRatioTotal = null
    parBreakeven = null
  }
  const notional = trade.notional as number
  const traded = trade.traded_breakeven as number
  const fixedTerminal = notional * (Math.pow(1.0 + traded, totalYears) - 1.0)
  const discountFactor = discount(remainingYears)
  if (indexRatioTotal === null) throw new EmptyDataError(realizedNote || `'${trade.dissemination_identifier}' has no priceable index ratio.`)
  const inflationTerminal = notional * (indexRatioTotal - 1.0)
  const net = (inflationTerminal - fixedTerminal) * discountFactor
  const npv = side === 'pay' ? net : -net
  const bumped = notional * (Math.pow(1.0 + traded + 1e-4, totalYears) - 1.0) - notional * (Math.pow(1.0 + traded, totalYears) - 1.0)
  const schedule: Rec[] = [
    {
      period: 1,
      start_date: effective,
      payment_date: expiration,
      year_fraction: pyRound(totalYears, 6),
      discount_factor: discountFactor,
      index_ratio: pyRound(indexRatioTotal, 8),
      realized_ratio: realizedRatio !== null ? pyRound(realizedRatio, 8) : null,
      projected_ratio: pyRound(projectedRatio, 8),
      notional,
      fixed_rate: traded,
      fixed_cashflow: pyRound(fixedTerminal, 2),
      fixed_pv: pyRound(fixedTerminal * discountFactor, 2),
      floating_cashflow: pyRound(inflationTerminal, 2),
      floating_pv: pyRound(inflationTerminal * discountFactor, 2),
    },
  ]
  const summary: Summary = {
    par_rate: parBreakeven,
    forward_breakeven: forwardBreakeven,
    index_ratio: indexRatioTotal,
    realized_ratio: realizedRatio,
    projected_ratio: projectedRatio,
    elapsed_years: elapsedYears,
    remaining_years: remainingYears,
    annuity: notional * totalYears * discountFactor,
    fixed_leg_pv: fixedTerminal * discountFactor,
    floating_leg_pv: inflationTerminal * discountFactor,
    npv,
    dv01: Math.abs(bumped * discountFactor),
    realized_note: realizedNote,
    reference_count: curve.length,
    breakeven_date: o.breakevenDate || curveDate,
  }
  return [schedule, summary]
}

/** The carry a seasoned basis/cross-currency swap has already realized (`spread_realized_carry`). */
export function spreadRealizedCarry(trade: Rec, spreadFixings: Fixings, otherFixings: Fixings, valuationDate: D, curveBasis: number, curvePeriod: number): Rec | null {
  const base = trade.effective_date as D
  if (base >= valuationDate) return { spread_leg_settled: 0.0, other_leg_settled: 0.0, spread_leg_accrued: 0.0, other_leg_accrued: 0.0 }

  const accrued = (notional: number, basis: number | null, frequency: Frequency, fixings: Fixings, indexBasis: number, spread = 0.0): [number, number] | null => {
    const periods = legPeriods(base, base, trade.expiration_date as D, notional, basis || curveBasis, frequency, curvePeriod, null)
    let settled = 0.0
    let unsettled = 0.0
    for (const period of periods) {
      const starts = addDays(base, period.start_days)
      const pays = addDays(base, period.end_days)
      const ends = pays < valuationDate ? pays : valuationDate
      if (ends <= starts) continue
      const accrual = compoundFixings(fixings, starts, ends, indexBasis)
      if (accrual === null) return null
      const amount = period.notional * (accrual + spread * yearFraction(starts, ends, indexBasis))
      if (pays <= valuationDate) settled += amount
      else unsettled += amount
    }
    return [settled, unsettled]
  }

  const spreadAccrued = accrued(trade.notional as number, trade.basis as number | null, trade.frequency as Frequency, spreadFixings, fixingBasis(trade.spread_index as string | null), trade.traded_spread as number)
  if (spreadAccrued === null) return null
  const otherAccrued = accrued(trade.other_notional as number, trade.other_basis as number | null, trade.other_frequency as Frequency, otherFixings, fixingBasis(trade.other_index as string | null))
  if (otherAccrued === null) return null
  const scale = trade.other_notional ? (trade.notional as number) / (trade.other_notional as number) : 1.0
  return { spread_leg_settled: spreadAccrued[0], other_leg_settled: otherAccrued[0] * scale, spread_leg_accrued: spreadAccrued[1], other_leg_accrued: otherAccrued[1] * scale }
}

/** One record's own priceable trade terms, or null if it fails a pricing gate (`parse_trade_record`). */
export function parseTradeRecord(record: SliceRecord, curveDate: D, minNotional = 0.0, currency: string | null = null): Rec | null {
  const recordCurrency = sf(record, 'Notional currency-Leg 1')
  if (currency !== null && recordCurrency !== currency) return null
  const fisn = sf(record, 'UPI FISN')
  if (!rateCurveFisns(recordCurrency).includes(fisn)) return null
  if (sf(record, 'Action type') !== 'NEWT') return null
  if (sf(record, 'Event type') !== 'TRAD') return null
  const rate = parseRate(record)
  const effective = parseDate(record['Effective Date'])
  const expiration = parseDate(record['Expiration Date'])
  const [notional, capped] = parseNotional(record['Notional amount-Leg 1'])
  if (rate === null || effective === null || expiration === null) return null
  const startDays = diffDays(effective, curveDate)
  const maturityDays = diffDays(expiration, effective)
  if (maturityDays <= 0 || expiration <= curveDate) return null
  if (!notional || notional < minNotional) return null
  const legBasis = (field: string): number | null => legDayCountBasis(record[field], 'A004')
  return {
    dissemination_identifier: sf(record, 'Dissemination Identifier'),
    trade_key: qualifiedKeys(record)['Trade Key'] ?? null,
    upi_fisn: fisn,
    underlier: sf(record, 'UPI Underlier Name') || null,
    currency: recordCurrency,
    fixed_rate: rate,
    effective_date: effective,
    expiration_date: expiration,
    start_days: startDays,
    maturity_days: maturityDays,
    notional,
    is_capped: capped,
    is_vanilla_par: isVanillaPar(record),
    cleared: sf(record, 'Cleared').toUpperCase() || null,
    fixed_schedule: parseLegSchedule(record, '1'),
    floating_schedule: parseLegSchedule(record, '2'),
    fixed_frequency: parseFrequency(record['Fixed rate payment frequency period-Leg 1'], record['Fixed rate payment frequency period multiplier-Leg 1']),
    floating_frequency: parseFrequency(record['Floating rate payment frequency period-Leg 2'], record['Floating rate payment frequency period multiplier-Leg 2']),
    reset_frequency: parseFrequency(record['Floating rate reset frequency period-leg 2'], record['Floating rate reset frequency period multiplier-leg 2']),
    fixed_basis: legBasis('Fixed rate day count convention-leg 1'),
    floating_basis: legBasis('Floating rate day count convention-leg 2'),
    other_payments: parseOtherPayments(record),
    package_indicator: isPackage(record),
    package_price: parsePackagePrice(record),
  }
}

/** The disseminated swaps of a currency that can be priced off its curve (`extract_swap_trades`). */
export function extractSwapTrades(records: Iterable<SliceRecord>, currency: string, curveDate: D, minNotional = 0.0): Rec[] {
  const trades: Rec[] = []
  for (const record of records) {
    const trade = parseTradeRecord(record, curveDate, minNotional, currency)
    if (trade !== null) trades.push(trade)
  }
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const na = -(a.t.notional as number)
      const nb = -(b.t.notional as number)
      if (na !== nb) return na < nb ? -1 : 1
      const ia = a.t.dissemination_identifier as string
      const ib = b.t.dissemination_identifier as string
      if (ia !== ib) return ia < ib ? -1 : 1
      return a.i - b.i
    })
    .map((x) => x.t)
}

/** The ISO day a cached raw record was disseminated (`record_disseminated_day`). */
export function recordDisseminatedDay(record: SliceRecord): string | null {
  const stamp = record['Dissemination Timestamp'] || record['Execution Timestamp'] || record['Event timestamp'] || ''
  return stamp.slice(0, 10) || null
}

/** One named trade, parsed once straight off its own record (`find_trade`). */
export function findTrade(records: Iterable<SliceRecord>, disseminationIdentifier: string, curveDate: D, minNotional = 0.0): Rec | null {
  const target = (disseminationIdentifier || '').trim()
  for (const record of records) {
    if (sf(record, 'Dissemination Identifier') === target) return parseTradeRecord(record, curveDate, minNotional)
  }
  return null
}

/** The carry a seasoned trade has already realized, from published fixings (`realized_carry`). */
export function realizedCarry(trade: Rec, fixings: Fixings, valuationDate: D, curveBasis: number, curvePeriod: number): Rec | null {
  const base = trade.effective_date as D
  const indexBasis = fixingBasis(indexForUnderlier(trade.underlier as string | null))
  if (base >= valuationDate) return { floating_settled: 0.0, fixed_settled: 0.0, floating_accrued: 0.0, fixed_accrued: 0.0 }
  let floatingSettled = 0.0
  let floatingAccrued = 0.0
  const floatingPeriods = legPeriods(
    base,
    base,
    trade.expiration_date as D,
    trade.notional as number,
    (trade.floating_basis as number | null) || (trade.fixed_basis as number | null) || curveBasis,
    (trade.floating_frequency as Frequency) || (trade.fixed_frequency as Frequency),
    curvePeriod,
    (trade.floating_schedule as Schedule | null) || (trade.fixed_schedule as Schedule | null),
  )
  for (const period of floatingPeriods) {
    const starts = addDays(base, period.start_days)
    const pays = addDays(base, period.end_days)
    const ends = pays < valuationDate ? pays : valuationDate
    if (ends <= starts) continue
    const accrual = compoundFixings(fixings, starts, ends, indexBasis)
    if (accrual === null) return null
    if (pays <= valuationDate) floatingSettled += period.notional * accrual
    else floatingAccrued += period.notional * accrual
  }
  let fixedSettled = 0.0
  let fixedAccrued = 0.0
  const fixedBasis = (trade.fixed_basis as number | null) || curveBasis
  const fixedPeriods = legPeriods(base, base, trade.expiration_date as D, trade.notional as number, fixedBasis, trade.fixed_frequency as Frequency, curvePeriod, trade.fixed_schedule as Schedule | null)
  for (const period of fixedPeriods) {
    const starts = addDays(base, period.start_days)
    const pays = addDays(base, period.end_days)
    const ends = pays < valuationDate ? pays : valuationDate
    if (ends > starts) {
      const amount = period.notional * (trade.fixed_rate as number) * yearFraction(starts, ends, fixedBasis)
      if (pays <= valuationDate) fixedSettled += amount
      else fixedAccrued += amount
    }
  }
  return { floating_settled: floatingSettled, fixed_settled: fixedSettled, floating_accrued: floatingAccrued, fixed_accrued: fixedAccrued }
}

/** One disseminated swap: the named print, or the day's largest par one (`select_swap_trade`). */
export function selectSwapTrade(records: SliceRecord[], currency: string, curveDate: D, disseminationIdentifier: string | null = null, minNotional = 0.0): Rec {
  if (disseminationIdentifier !== null) {
    const trade = findTrade(records, disseminationIdentifier, curveDate, minNotional)
    if (trade === null) throw new EmptyDataError(`No ${currency} swap on ${curveDate} carries dissemination identifier '${disseminationIdentifier}'.`)
    return trade
  }
  const trades = extractSwapTrades(records, currency, curveDate, minNotional)
  if (trades.length === 0) throw new EmptyDataError(`No priceable ${currency} swap was disseminated on ${curveDate}.`)
  const vanilla = trades.filter((t) => t.is_vanilla_par)
  if (vanilla.length === 0) throw new EmptyDataError(`No standalone-par ${currency} swap was disseminated on ${curveDate}.`)
  return vanilla[0]!
}

/** Price a fixed-vs-floating swap, each leg over its own accrual periods (`_price`). */
function price(discount: DiscountFn, fixedPeriods: Period[], floatingPeriods: Period[], tradeDate: D, fixedRate: number | null, side: string, spread = 0.0): [Rec[], Summary] {
  let floatingLegPv = 0.0
  const floatingRows: Rec[] = []
  for (const period of floatingPeriods) {
    const opening = discount(period.start_days / ZERO_RATE_BASIS)
    const factor = discount(period.end_days / ZERO_RATE_BASIS)
    const yf = period.year_fraction
    const forward = (opening / factor - 1.0) / yf
    const floating = forward + spread
    const cashflow = period.notional * floating * yf
    floatingLegPv += cashflow * factor
    floatingRows.push({ start_days: period.start_days, end_days: period.end_days, year_fraction: yf, notional: period.notional, forward_rate: forward, floating_rate: floating, floating_cashflow: cashflow, floating_pv: cashflow * factor })
  }
  let annuity = 0.0
  let accruedWeight = 0.0
  const schedule: Rec[] = []
  fixedPeriods.forEach((period, i) => {
    const factor = discount(period.end_days / ZERO_RATE_BASIS)
    annuity += period.notional * period.year_fraction * factor
    accruedWeight += period.notional * (period.elapsed_year_fraction ?? 0.0)
    schedule.push({ period: i + 1, start_date: addDays(tradeDate, period.start_days), payment_date: addDays(tradeDate, period.end_days), year_fraction: period.year_fraction, notional: period.notional, discount_factor: factor })
  })
  const parRate = floatingLegPv / annuity
  const rate = fixedRate === null ? parRate : fixedRate
  schedule.forEach((row, i) => {
    const period = fixedPeriods[i]!
    const covering = floatingRows.filter((fr) => (fr.start_days as number) >= period.start_days && (fr.end_days as number) <= period.end_days)
    if (covering.length === 0) return
    const coveringYearFraction = pySum(covering.map((fr) => fr.year_fraction as number))
    row.forward_rate = pySum(covering.map((fr) => (fr.forward_rate as number) * (fr.year_fraction as number))) / coveringYearFraction
    row.floating_rate = pySum(covering.map((fr) => (fr.floating_rate as number) * (fr.year_fraction as number))) / coveringYearFraction
    row.floating_notional = covering[0]!.notional
    row.floating_cashflow = pySum(covering.map((fr) => fr.floating_cashflow as number))
    row.floating_pv = pySum(covering.map((fr) => fr.floating_pv as number))
  })
  for (const row of schedule) {
    row.fixed_rate = rate
    row.fixed_cashflow = (row.notional as number) * rate * (row.year_fraction as number)
    row.fixed_pv = (row.fixed_cashflow as number) * (row.discount_factor as number)
  }
  const fixedLegPv = rate * annuity
  const npv = side === 'pay' ? floatingLegPv - fixedLegPv : fixedLegPv - floatingLegPv
  return [schedule, { par_rate: parRate, annuity, fixed_leg_pv: fixedLegPv, floating_leg_pv: floatingLegPv, npv, dv01: annuity * 1e-4, fixed_accrued: rate * accruedWeight }]
}

/** Value a single-currency fixed-vs-floating swap against the currency's rate curve (`value_swap`). */
export function valueSwap(
  records: SliceRecord[],
  currency: string,
  tradeDate: D,
  maturityDays: number,
  o: {
    fixedRate?: number | null
    notional?: number
    side?: string
    minTrades?: number
    startDays?: number
    spread?: number
    fixedSchedule?: Schedule | null
    floatingSchedule?: Schedule | null
    fixedBasis?: number | null
    floatingBasis?: number | null
    fixedFrequency?: Frequency
    floatingFrequency?: Frequency
  } = {},
): [Rec[], Summary] {
  const [discount, curveBasis, curvePeriod] = discountCurve(records, currency, tradeDate, o.minTrades ?? 1)
  const effective = addDays(tradeDate, o.startDays ?? 0)
  const expiration = addDays(effective, maturityDays)
  const notional = o.notional ?? 10_000_000.0
  const fixedPeriods = legPeriods(tradeDate, effective, expiration, notional, o.fixedBasis || curveBasis, o.fixedFrequency ?? null, curvePeriod, o.fixedSchedule ?? null)
  const floatingPeriods = legPeriods(tradeDate, effective, expiration, notional, o.floatingBasis || o.fixedBasis || curveBasis, o.floatingFrequency || o.fixedFrequency || null, curvePeriod, o.floatingSchedule || o.fixedSchedule || null)
  return price(discount, fixedPeriods, floatingPeriods, tradeDate, o.fixedRate ?? null, o.side ?? 'pay', o.spread ?? 0.0)
}
