// cftc/swap_valuation and cftc/swap_summary, provider cftc. Ported from openbb_cftc/models/swap_valuation.py and
// swap_summary.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models (model.ts), slices
// are memoised with ctx.cache, and the on-disk record store is gone: a named trade is found by walking the published
// files, as the Python does when its store has never seen the trade.
import { pyRound } from '../helpers.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { oisIndices } from './constants.js'
import { cnyCurveRecords, mentionsCny } from './cfets.js'
import { EmptyDataError, curveDayCountBasis, curvePaymentPeriod, type Rec, type SliceRecord } from './curve.js'
import { todayOf, type D } from './dates.js'
import { MAX_LOOKBACK_DAYS, getLatestViableSlice, getRatesSliceFor, getSlice } from './dtcc.js'
import { indexForUnderlier, type Fixings } from './fixings.js'
import { getFixings } from './fixings-fetch.js'
import { pyCommaFixed, pyFixed, pyRepr } from './format.js'
import { classifyFxTrade, valueFxTrade } from './fx-valuation.js'
import { fxSpot } from './fx-vol.js'
import { buildBreakevenCurve, getInflationIndex, type Levels } from './inflation.js'
import { validateRow } from './model.js'
import { pDate, pNum, pStr } from './params.js'
import { SWAP_SUMMARY_SCHEMA, SWAP_VALUATION_SCHEMA } from './schemas.js'
import { searchTrades } from './search.js'
import {
  classifyRatesSwap,
  extractInflationTrade,
  extractSpreadTrade,
  parseSpread,
  realizedCarry,
  recordDisseminatedDay,
  selectSwapTrade,
  spreadRealizedCarry,
  valueCrossCurrencySwap,
  valueInflationSwap,
  valueSpreadSwap,
  valueSwap,
  type Frequency,
  type Schedule,
} from './swap.js'

type Query = {
  currency: string
  id: string | null
  /** The asset class a qualified trade key names (`FX:…`); it only decides which files are read first. */
  assetHint: string | null
  tradeDate: D | null
  side: string
  minNotional: number
  date: D | null
  minTrades: number
}

type Valuation = { trade: Rec; rates: SliceRecord[]; ratesDate: D; fixings: Rec; currency: string; tradeDate: D }

/** The query as `CftcSwapValuationQueryParams` reads it: currency upper-cased, a trade key's qualifier dropped. */
function queryOf(params: NativeParams): Query {
  const id = pStr(params, 'dissemination_identifier')
  return {
    currency: (pStr(params, 'currency') ?? 'USD').toUpperCase(),
    id: id === undefined ? null : id.slice(id.lastIndexOf(':') + 1).trim(),
    assetHint: id !== undefined && id.includes(':') ? id.slice(0, id.indexOf(':')).trim().toUpperCase() : null,
    tradeDate: pDate(params, 'trade_date') ?? null,
    side: pStr(params, 'side') ?? 'pay',
    minNotional: pNum(params, 'min_notional') ?? 0.0,
    date: pDate(params, 'date') ?? null,
    minTrades: pNum(params, 'min_trades') ?? 1,
  }
}

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()

/**
 * The named trade's raw record. The Python reads its on-disk store of every file it has seen and falls back to walking
 * the last published rates files, then to today's search; this walks the files. The summary also looks in the forex
 * files, where the Python's store would find an FX print, starting with the files a qualified trade key points at.
 */
async function findRecord(ctx: NativeCtx, q: Query, reportDate: D, alsoForex = false): Promise<{ record: SliceRecord; forex: boolean }> {
  const target = (q.id ?? '').trim()
  let record: SliceRecord | null = null
  const carriesTrade = (records: SliceRecord[]): boolean => {
    for (const candidate of records) {
      if (sf(candidate, 'Dissemination Identifier') === target) {
        record = candidate
        return true
      }
    }
    return false
  }
  const classes = alsoForex ? (q.assetHint === 'FX' ? ['forex', 'rates'] : ['rates', 'forex']) : ['rates']
  for (const assetClass of classes) {
    try {
      await getLatestViableSlice(ctx, assetClass, (recs) => carriesTrade(recs), { endDate: reportDate })
      return { record: record!, forex: assetClass === 'forex' }
    } catch {
      // Not among the last published files of this class.
    }
  }
  const today = todayOf(ctx.now())
  const searched = await searchTrades(ctx, 'rates', today, today, {})
  if (!carriesTrade(searched)) throw new EmptyDataError(`'${q.id}' was not found in the ${MAX_LOOKBACK_DAYS} days of published files to ${reportDate}.`)
  return { record: record!, forex: false }
}

/** The trade, the curve slice and the fixings its realized carry needs (`CftcSwapValuationFetcher.aextract_data`). */
async function extractValuation(ctx: NativeCtx, q: Query, located: SliceRecord | null = null): Promise<Valuation> {
  const reportDate = q.date ?? todayOf(ctx.now())
  let currency = q.currency
  let otherCurrency: string | null = null
  let rawRecord: SliceRecord | null = null
  let tradeDate: D | null = q.tradeDate

  if (q.id && q.tradeDate === null) {
    rawRecord = located ?? (await findRecord(ctx, q, reportDate)).record
    // The day the record names, as the Python's store gives it: a slice record has no dissemination timestamp, so it is
    // the day the trade was executed.
    tradeDate = recordDisseminatedDay(rawRecord)
    const today = todayOf(ctx.now())
    const tradeType = classifyRatesSwap(rawRecord, today)
    const spread = tradeType === 'basis' || tradeType === 'cross_currency' ? parseSpread(rawRecord) : null
    const leg = spread ? spread[0] : 1
    currency = sf(rawRecord, `Notional currency-Leg ${leg}`) || currency
    if (tradeType === 'cross_currency') otherCurrency = sf(rawRecord, `Notional currency-Leg ${leg === 1 ? 2 : 1}`) || null
  }

  const anchor = currency in oisIndices ? [currency] : ['USD']
  if (otherCurrency && !anchor.includes(otherCurrency)) anchor.push(otherCurrency)
  const [rates, ratesDate] = await getRatesSliceFor(ctx, reportDate, anchor)
  const curveDate = ratesDate

  let trade: Rec
  const family = rawRecord ? classifyRatesSwap(rawRecord, curveDate) : null
  if (rawRecord && family === 'inflation') {
    const priced = extractInflationTrade(rawRecord, curveDate, q.minNotional)
    if (priced === null) throw new EmptyDataError(`'${q.id}' has no priceable`)
    trade = priced
  } else if (rawRecord && (family === 'basis' || family === 'cross_currency')) {
    const priced = extractSpreadTrade(rawRecord, curveDate, q.minNotional)
    if (priced === null) throw new EmptyDataError(`'${q.id}' has no priceable`)
    trade = priced
  } else if (rawRecord) {
    trade = selectSwapTrade([rawRecord], currency, curveDate, q.id, q.minNotional)
  } else {
    const tradeRecords = q.tradeDate !== null && q.tradeDate !== ratesDate ? await getSlice(ctx, 'rates', q.tradeDate) : rates
    trade = selectSwapTrade(tradeRecords, currency, curveDate, q.id, q.minNotional)
  }
  if (tradeDate === null) tradeDate = ratesDate

  let fixings: Rec = {}
  if (trade.trade_type === 'inflation') {
    if (buildBreakevenCurve(rates, currency, curveDate, q.minTrades).length === 0) {
      try {
        const [breakevens, breakevenDate] = await getLatestViableSlice(ctx, 'rates', (recs, day) => buildBreakevenCurve(recs, currency, day, q.minTrades).length > 0, { endDate: ratesDate })
        fixings.breakeven_records = breakevens
        fixings.breakeven_date = breakevenDate
      } catch {
        // No earlier day priced the breakevens either; the valuation reports it.
      }
    }
    if (trade.index && (trade.effective_date as D) < curveDate) {
      try {
        fixings.levels = await getInflationIndex(ctx, trade.index as string)
      } catch {
        fixings.levels = new Map()
      }
    }
  } else if ('traded_spread' in trade) {
    if ((trade.effective_date as D) < curveDate) {
      const legFixings = async (index: string | null): Promise<Fixings> => (index === null ? {} : getFixings(ctx, index, trade.effective_date as D, curveDate))
      fixings = { spread: await legFixings(trade.spread_index as string | null), other: await legFixings(trade.other_index as string | null) }
    }
    if (trade.trade_type === 'cross_currency') {
      const fxRecords = await getSlice(ctx, 'forex', ratesDate)
      const spot = fxSpot(fxRecords, trade.other_currency as string, currency, curveDate)
      if (spot === null) throw new EmptyDataError(`No ${trade.other_currency}/${currency} spot could be established from forex prints on ${ratesDate}.`)
      fixings.spot = spot
    }
  } else {
    const index = indexForUnderlier(trade.underlier as string | null)
    if ((trade.effective_date as D) < curveDate && index !== null) fixings = await getFixings(ctx, index, trade.effective_date as D, curveDate)
  }
  return { trade, rates, ratesDate, fixings, currency, tradeDate }
}

/** Realized carry from published fixings, signed to the side, or its absence (`_realized_metadata`). */
function realizedMetadata(q: Query, trade: Rec, fixings: Fixings, curveDate: D, rates: SliceRecord[], currency: string): Rec {
  if ((trade.effective_date as D) >= curveDate) return { settled_carry: 0.0, accrued_carry: 0.0 }
  if (Object.keys(fixings).length === 0) {
    return { settled_carry: null, accrued_carry: null, carry_note: "The elapsed floating accrual compounds the index's published fixings, which are not available for this trade." }
  }
  const carry = realizedCarry(trade, fixings, curveDate, curveDayCountBasis(rates, currency, curveDate, q.minTrades), curvePaymentPeriod(rates, currency, curveDate, q.minTrades))
  if (carry === null) return { settled_carry: null, accrued_carry: null, carry_note: "The published fixings do not cover the trade's elapsed accrual span." }
  const sign = q.side === 'pay' ? 1.0 : -1.0
  const settled = carry.floating_settled - carry.fixed_settled
  const accrued = carry.floating_accrued - carry.fixed_accrued
  return {
    floating_settled: pyRound(carry.floating_settled, 2),
    fixed_settled: pyRound(carry.fixed_settled, 2),
    floating_accrued: pyRound(carry.floating_accrued, 2),
    fixed_accrued: pyRound(carry.fixed_accrued, 2),
    settled_carry: pyRound(sign * settled, 2),
    accrued_carry: pyRound(sign * accrued, 2),
  }
}

/** Realized carry for a basis or cross-currency trade, from both legs' own published fixings (`_spread_realized_metadata`). */
function spreadRealizedMetadata(q: Query, trade: Rec, fixings: Rec, curveDate: D, rates: SliceRecord[]): Rec {
  if ((trade.effective_date as D) >= curveDate) return { settled_carry: 0.0, accrued_carry: 0.0 }
  const spreadFixings = (fixings.spread ?? {}) as Fixings
  const otherFixings = (fixings.other ?? {}) as Fixings
  if (Object.keys(spreadFixings).length === 0 || Object.keys(otherFixings).length === 0) {
    return { settled_carry: null, accrued_carry: null, carry_note: "The elapsed accrual compounds both legs' own published fixings; one or both indices are not available for this trade." }
  }
  const carry = spreadRealizedCarry(trade, spreadFixings, otherFixings, curveDate, curveDayCountBasis(rates, trade.currency as string, curveDate, q.minTrades), curvePaymentPeriod(rates, trade.currency as string, curveDate, q.minTrades))
  if (carry === null) return { settled_carry: null, accrued_carry: null, carry_note: "The published fixings do not cover the trade's elapsed accrual span." }
  const sign = q.side === 'pay' ? 1.0 : -1.0
  const settled = carry.spread_leg_settled - carry.other_leg_settled
  const accrued = carry.spread_leg_accrued - carry.other_leg_accrued
  return {
    spread_leg_settled: pyRound(carry.spread_leg_settled, 2),
    other_leg_settled: pyRound(carry.other_leg_settled, 2),
    spread_leg_accrued: pyRound(carry.spread_leg_accrued, 2),
    other_leg_accrued: pyRound(carry.other_leg_accrued, 2),
    settled_carry: pyRound(sign * settled, 2),
    accrued_carry: pyRound(sign * accrued, 2),
  }
}

type Payment = { type: string; amount: number; currency: string | null }

/** Fold the print's disseminated other payments into its net economics (`_economics_metadata`). */
function economicsMetadata(trade: Rec, q: Query, metadata: Rec): void {
  const payments = (trade.other_payments ?? []) as Payment[]
  const currency = metadata.currency as string
  if (payments.length > 0) metadata.other_payments = payments.map((p) => ({ type: p.type, amount: pyRound(p.amount, 2), currency: p.currency }))
  if (trade.package_indicator) metadata.package_indicator = true
  if (trade.package_price) {
    metadata.package_price = pyRound((trade.package_price as { amount: number }).amount, 2)
    metadata.package_price_currency = (trade.package_price as { currency: string | null }).currency
  }
  // sum() of the matching amounts, from the integer 0 (so no matching amount is a falsy 0).
  let upfront = 0
  for (const p of payments) if (p.type === 'UFRO' && (p.currency || currency) === currency) upfront += p.amount
  if (payments.some((p) => p.type === 'UFRO' && p.currency && p.currency !== currency)) {
    metadata.other_payment_note = 'Upfront amounts in currencies other than the trade currency are reported in other_payments, not netted into entry_cost.'
  }
  const npv = metadata.npv as number
  let entryCost = 0.0
  if (upfront) {
    metadata.upfront_amount = pyRound(upfront, 2)
    entryCost = npv >= 0 ? upfront : -upfront
    metadata.entry_cost = pyRound(entryCost, 2)
  }
  const carry = ((metadata.settled_carry as number | null | undefined) || 0.0) + ((metadata.accrued_carry as number | null | undefined) || 0.0)
  const net = npv + carry - entryCost
  metadata.net_pnl = pyRound(net, 2)
  const netPay = q.side === 'pay' ? net : -net
  metadata.winning_side = netPay > 0 ? 'pay' : netPay < 0 ? 'receive' : 'flat'
}

/** The schedule rows and the summary metadata (`CftcSwapValuationFetcher.transform_data`). */
function transformValuation(q: Query, data: Valuation): { schedule: Rec[]; metadata: Rec } {
  const { trade, rates, ratesDate, fixings, currency, tradeDate } = data
  const curveDate = ratesDate
  const isSpreadTrade = 'traded_spread' in trade
  const isCrossCurrency = trade.trade_type === 'cross_currency'
  const isInflation = trade.trade_type === 'inflation'
  let schedule: Rec[]
  let summary: Rec
  let contractRate: number
  if (isInflation) {
    const breakevenDate = fixings.breakeven_date as D | undefined
    ;[schedule, summary] = valueInflationSwap(rates, trade, curveDate, {
      levels: fixings.levels as Levels | undefined,
      side: q.side,
      minTrades: q.minTrades,
      breakevenRecords: fixings.breakeven_records as SliceRecord[] | undefined,
      breakevenDate: breakevenDate || null,
    })
    contractRate = trade.traded_breakeven as number
  } else if (isCrossCurrency) {
    ;[schedule, summary] = valueCrossCurrencySwap(rates, trade, curveDate, fixings.spot as number, q.side, q.minTrades)
    contractRate = trade.traded_spread as number
  } else if (isSpreadTrade) {
    ;[schedule, summary] = valueSpreadSwap(rates, trade, curveDate, q.side, q.minTrades)
    contractRate = trade.traded_spread as number
  } else {
    ;[schedule, summary] = valueSwap(rates, currency, curveDate, trade.maturity_days as number, {
      fixedRate: trade.fixed_rate as number,
      notional: trade.notional as number,
      side: q.side,
      minTrades: q.minTrades,
      startDays: trade.start_days as number,
      fixedSchedule: trade.fixed_schedule as Schedule | null,
      floatingSchedule: trade.floating_schedule as Schedule | null,
      fixedBasis: trade.fixed_basis as number | null,
      floatingBasis: trade.floating_basis as number | null,
      fixedFrequency: trade.fixed_frequency as Frequency,
      floatingFrequency: trade.floating_frequency as Frequency,
    })
    contractRate = trade.fixed_rate as number
  }
  for (const row of schedule) {
    row.fixed_rate *= 100.0
    if (row.forward_rate !== null && row.forward_rate !== undefined) {
      row.forward_rate *= 100.0
      row.floating_rate *= 100.0
    }
  }

  const metadata: Rec = {
    dissemination_identifier: trade.dissemination_identifier,
    trade_key: trade.trade_key ?? null,
    upi_fisn: trade.upi_fisn,
    trade_date: tradeDate,
    winning_side: summary.par_rate > contractRate ? 'pay' : 'receive',
    currency,
    curve_date: ratesDate,
    effective_date: trade.effective_date,
    expiration_date: trade.expiration_date,
    notional: trade.notional,
    notional_capped: trade.is_capped,
    cleared: trade.cleared,
    side: q.side,
    fixed_rate: pyRound(contractRate * 100.0, 6),
    par_rate: pyRound(summary.par_rate * 100.0, 6),
    annuity: pyRound(summary.annuity, 6),
    fixed_leg_pv: pyRound(summary.fixed_leg_pv, 2),
    floating_leg_pv: pyRound(summary.floating_leg_pv, 2),
    npv: pyRound(summary.npv, 2),
    dv01: pyRound(summary.dv01, 2),
  }
  if (isInflation) {
    Object.assign(metadata, {
      trade_type: trade.trade_type,
      underlier: trade.underlier,
      inflation_index: trade.index,
      index_ratio: pyRound(summary.index_ratio, 8),
      realized_ratio: summary.realized_ratio !== null ? pyRound(summary.realized_ratio, 8) : null,
      projected_ratio: pyRound(summary.projected_ratio, 8),
      forward_breakeven: pyRound(summary.forward_breakeven * 100.0, 6),
      elapsed_years: pyRound(summary.elapsed_years, 4),
      remaining_years: pyRound(summary.remaining_years, 4),
      reference_trade_count: summary.reference_count,
      breakeven_date: summary.breakeven_date,
      settled_carry: null,
      accrued_carry: null,
    })
  } else if (isCrossCurrency) {
    Object.assign(metadata, { trade_type: trade.trade_type, underlier: trade.underlier, other_currency: trade.other_currency, spot: fixings.spot, exchange_pv: pyRound(summary.exchange_pv, 2) }, spreadRealizedMetadata(q, trade, fixings, curveDate, rates))
  } else if (isSpreadTrade) {
    Object.assign(metadata, { trade_type: trade.trade_type, underlier: trade.underlier, reference_trade_count: summary.reference_trade_count }, spreadRealizedMetadata(q, trade, fixings, curveDate, rates))
  } else {
    Object.assign(metadata, { is_vanilla_par: trade.is_vanilla_par }, realizedMetadata(q, trade, fixings as Fixings, curveDate, rates, currency))
  }
  economicsMetadata(trade, q, metadata)
  return { schedule, metadata }
}

export const swapValuation: NativeHandler = async (params, ctx) => {
  const q = queryOf(params)
  const { schedule } = transformValuation(q, await extractValuation(ctx, q))
  return schedule.map((r) => validateRow(SWAP_VALUATION_SCHEMA, r))
}

// ---- cftc/swap_summary ----------------------------------------------------------------------------------------------

/** `f"{amount:,.2f} {currency}"` (`_money`). */
const money = (amount: number, currency: string | null | undefined): string => {
  const text = pyCommaFixed(amount, 2)
  return currency ? `${text} ${currency}` : text
}

/** A rate in percent (`_rate`). */
const rate = (value: number): string => `${pyFixed(value, 4)} %`

/** Python's `x or default` for the metadata reads. */
const or = <T>(value: T | null | undefined, fallback: T): T => (value ? value : fallback)

/** `str(x)` of a metadata value: None is the text `None`, a float its repr. */
const text = (value: unknown): string => (value === null || value === undefined ? 'None' : typeof value === 'number' ? pyRepr(value) : String(value))

/** `str(n)` of an integer metadata value. */
const intText = (value: unknown): string => (value === null || value === undefined ? 'None' : String(value))

/** Total a payment type per currency, joined for display (`_payment_totals`). */
function paymentTotals(payments: Payment[], kind: string): string | null {
  const totals = new Map<string, number>()
  for (const payment of payments) if (payment.type === kind) totals.set(payment.currency || '', (totals.get(payment.currency || '') ?? 0.0) + payment.amount)
  if (totals.size === 0) return null
  return [...totals].map(([ccy, amount]) => money(amount, ccy || null)).join('; ')
}

type Detail = string | null | undefined
const row = (metric: string, value: string, detail?: Detail): Rec => ({ metric, value, detail: detail ?? null })

/** Split elapsed carry into what has settled and what is still accruing (`carry_rows`). */
function carryRows(metadata: Rec, currency: string | null): Rec[] {
  const note = metadata.carry_note as string | undefined
  const settled = metadata.settled_carry as number | null | undefined
  const accrued = metadata.accrued_carry as number | null | undefined
  return [
    row('Settled Carry', settled !== null && settled !== undefined ? money(settled, currency) : 'unavailable', note || 'coupons whose payment date has passed'),
    row('Accrued Carry', accrued !== null && accrued !== undefined ? money(accrued, currency) : 'unavailable', note || 'earned since the last payment, not yet settled'),
  ]
}

/** The summary's metric rows from the valuation's own metadata (`_summary_rows`). */
function summaryRows(metadata: Rec, side: string): Rec[] {
  const currency = (metadata.currency ?? null) as string | null
  const isInflation = metadata.trade_type === 'inflation'
  const isSpread = metadata.trade_type === 'basis' || metadata.trade_type === 'cross_currency'
  const rows: Rec[] = [
    row('Trade', String(or(metadata.trade_key, or(metadata.dissemination_identifier, ''))), `disseminated ${text(metadata.trade_date)}`),
    row('Product', String(or(metadata.upi_fisn, '')), metadata.underlier as Detail),
    row('Term', `${text(metadata.effective_date)} to ${text(metadata.expiration_date)}`, null),
    row('Notional', money(or(metadata.notional as number | undefined, 0.0), currency), metadata.notional_capped ? 'reported at the Part 43 cap' : null),
  ]
  const cleared = metadata.cleared
  if (cleared) rows.push(row('Cleared', String(cleared), { Y: 'cleared', I: 'intent to clear', N: 'bilateral' }[String(cleared)] ?? null))
  rows.push(row(isInflation ? 'Traded Breakeven' : isSpread ? 'Traded Spread' : 'Fixed Rate', rate(or(metadata.fixed_rate as number | undefined, 0.0)), null))
  rows.push(row(isInflation ? 'Breakeven (Now)' : 'Par Rate (Now)', rate(or(metadata.par_rate as number | undefined, 0.0)), isInflation ? `breakevens ${text(metadata.breakeven_date)}` : `curve ${text(metadata.curve_date)}`))
  if (isInflation) {
    rows.push(row('Index', String(or(metadata.underlier, '')), metadata.inflation_index as Detail))
    rows.push(row('Index Ratio', pyCommaFixed(or(metadata.index_ratio as number | undefined, 0.0), 6), 'reference index at maturity over the base index'))
    const realized = metadata.realized_ratio as number | null | undefined
    rows.push(row('Realized Ratio', realized !== null && realized !== undefined ? pyCommaFixed(realized, 6) : 'not started', `${text(metadata.elapsed_years)} years elapsed`))
    rows.push(row('Projected Ratio', pyCommaFixed(or(metadata.projected_ratio as number | undefined, 0.0), 6), `${text(metadata.remaining_years)} years at ${rate(or(metadata.forward_breakeven as number | undefined, 0.0))}`))
  }
  if (metadata.spot !== null && metadata.spot !== undefined) rows.push(row('Spot', pyCommaFixed(metadata.spot as number, 6), `${text(metadata.other_currency)}/${text(currency)}`))
  rows.push(row('Swap NPV (Now)', money(or(metadata.npv as number | undefined, 0.0), currency), `signed to ${side}`))
  if (metadata.exchange_pv !== null && metadata.exchange_pv !== undefined) rows.push(row('Exchange PV', money(metadata.exchange_pv as number, currency), 'terminal notional exchange'))
  rows.push(...carryRows(metadata, currency))
  const payments = (metadata.other_payments ?? []) as Payment[]
  if (metadata.upfront_amount !== null && metadata.upfront_amount !== undefined) {
    rows.push(row('Upfront Payment (UFRO)', money(metadata.upfront_amount as number, currency), `entry cost ${money(metadata.entry_cost as number, currency)}, signed to ${side}`))
  }
  const exchanges = paymentTotals(payments, 'PEXH')
  if (exchanges) rows.push(row('Principal Exchanges (PEXH)', exchanges, null))
  const unwinds = paymentTotals(payments, 'UWIN')
  if (unwinds) rows.push(row('Unwind Payments (UWIN)', unwinds, null))
  if (metadata.package_price !== null && metadata.package_price !== undefined) {
    rows.push(row('Package Price', money(metadata.package_price as number, metadata.package_price_currency as string | null | undefined), 'as disseminated for the package'))
  } else if (metadata.package_indicator) {
    rows.push(row('Package', 'yes', 'part of a package transaction'))
  }
  if (metadata.other_payment_note) rows.push(row('Other Payments', 'see note', metadata.other_payment_note as string))
  rows.push(row('Net P&L (Now)', money(or(metadata.net_pnl as number | undefined, 0.0), currency), 'NPV + settled and accrued carry - entry cost'))
  rows.push(row('Winning Side (Now)', String(or(metadata.winning_side, '')), null))
  return rows
}

/** Value an FX print against the forex and rates slices of its own session (`_fx_metadata`). */
async function fxMetadata(ctx: NativeCtx, q: Query, record: SliceRecord): Promise<Rec> {
  const day = recordDisseminatedDay(record)
  if (day === null) throw new EmptyDataError(`'${q.id}' carries no dissemination date.`)
  const forex = await getSlice(ctx, 'forex', day)
  let rates = await getSlice(ctx, 'rates', day)
  if (mentionsCny(record)) {
    const extra = await cnyCurveRecords(ctx, day)
    if (extra.length > 0) rates = [...rates, ...extra]
  }
  const valued = valueFxTrade(record, forex, rates, day, { minNotional: q.minNotional, minTrades: q.minTrades })
  if (valued === null) throw new EmptyDataError(`'${q.id}' has no priceable FX terms against the ${day} tape.`)
  return { ...valued, trade_date: day, curve_date: day }
}

/** An FX print's metric rows from its own valuation (`_fx_summary_rows`). */
function fxSummaryRows(metadata: Rec, side: string): Rec[] {
  const quote = (metadata.quote ?? null) as string | null
  const sign = side === 'pay' ? 1.0 : -1.0
  const base = metadata.base
  const rows: Rec[] = [
    row('Trade', String(or(metadata.trade_key, or(metadata.dissemination_identifier, ''))), `disseminated ${text(metadata.trade_date)}`),
    row('Product', String(or(metadata.upi_fisn, '')), metadata.product as Detail),
    row('Term', `${text(metadata.effective_date)} to ${text(metadata.expiration_date)}`, `${intText(metadata.days)} days remaining`),
    row('Notional', money(or(metadata.notional as number | undefined, 0.0), metadata.base as string | null), metadata.pair as Detail),
    row('Traded Rate', pyCommaFixed(or(metadata.traded_rate as number | undefined, or(metadata.strike as number | undefined, 0.0)), 6), `${text(quote)} per ${text(base)}`),
    row('Spot (Now)', pyCommaFixed(or(metadata.spot as number | undefined, 0.0), 6), `curve ${text(metadata.curve_date)}`),
    row('Forward (Now)', pyCommaFixed(or(metadata.market_rate as number | undefined, 0.0), 6), "at the trade's remaining tenor"),
  ]
  if (metadata.implied_vol !== null && metadata.implied_vol !== undefined) {
    rows.push(row('Implied Volatility', `${pyFixed(100.0 * (metadata.implied_vol as number), 2)} %`, "from the day's prints of the same option family"))
    rows.push(row('Premium Paid', money(or(metadata.premium as number | undefined, 0.0), quote), 'entry cost'))
  }
  const npv = sign * or(metadata.npv as number | undefined, 0.0)
  rows.push(row('NPV (Now)', money(npv, quote), `signed to the ${side === 'pay' ? 'long' : 'short'} ${text(base)} side`))
  const raw = or(metadata.npv as number | undefined, 0.0)
  rows.push(row('Winning Side', raw > 0 ? `long ${text(base)}` : raw < 0 ? `short ${text(base)}` : 'flat', "against the session's forward curve"))
  return rows
}

/**
 * The FX print a trade named by identifier and date refers to. The Python finds it in its store of every file it has
 * read; here it is looked up in the forex file of the day the caller names, which is where the tape listed it.
 */
async function findFxRecord(ctx: NativeCtx, q: Query): Promise<SliceRecord | null> {
  if (!q.id || q.tradeDate === null) return null
  let forex: SliceRecord[]
  try {
    forex = await getSlice(ctx, 'forex', q.tradeDate)
  } catch {
    return null
  }
  const target = q.id
  const record = forex.find((r) => sf(r, 'Dissemination Identifier') === target)
  return record !== undefined && classifyFxTrade(record) !== null ? record : null
}

export const swapSummary: NativeHandler = async (params, ctx) => {
  const q = queryOf(params)
  let fxRecord = await findFxRecord(ctx, q)
  let located: SliceRecord | null = null
  if (fxRecord === null && q.id && q.tradeDate === null) {
    const found = await findRecord(ctx, q, q.date ?? todayOf(ctx.now()), true)
    if (found.forex && classifyFxTrade(found.record) !== null) fxRecord = found.record
    else located = found.record
  }
  if (fxRecord !== null) return fxSummaryRows(await fxMetadata(ctx, q, fxRecord), q.side).map((r) => validateRow(SWAP_SUMMARY_SCHEMA, r))
  const { metadata } = transformValuation(q, await extractValuation(ctx, q, located))
  return summaryRows(metadata, q.side).map((r) => validateRow(SWAP_SUMMARY_SCHEMA, r)) as Row[]
}
