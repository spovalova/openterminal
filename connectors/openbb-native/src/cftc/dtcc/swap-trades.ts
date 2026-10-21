// cftc/swap_trades, provider cftc. Ported from openbb_cftc/models/swap_trades.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models (model.ts), slices and bulletins are memoised with ctx.cache, and the
// persisted "is this curve priceable" flags of the on-disk store are recomputed per call.
import type { NativeCtx, NativeHandler, Row } from '../../types.js'
import { EmptyDataError, parseNotional, type Rec, type SliceRecord } from './curve.js'
import { cnyCurveRecords, mentionsCny } from './cfets.js'
import { addDays, diffDays, todayOf, type D } from './dates.js'
import { MAX_LOOKBACK_DAYS, getLatestViableSlice, getRatesSliceFor, getSlice } from './dtcc.js'
import { fxSpot, rateDiscountFactor } from './fx-vol.js'
import { valueFxTrade } from './fx-valuation.js'
import { INFLATION_INDICES, buildBreakevenCurve, getInflationIndex, indexForInflationUnderlier, indexRatio, type Levels } from './inflation.js'
import { normalizeValues, validateRow } from './model.js'
import { mapLimit, pBool, pDate, pNum, pStr } from './params.js'
import { SWAP_TRADES_SCHEMA } from './schemas.js'
import { searchTrades } from './search.js'
import { classifyRatesSwap, extractInflationTrade, extractSpreadTrade, parseTradeRecord, recordDisseminatedDay, referenceSpread } from './swap.js'

const MAX_CONCURRENT_DOWNLOADS = 4

const NUMERIC_FIELDS = new Set([
  'call_amount', 'exchange_rate', 'fixed_rate_leg_1', 'fixed_rate_leg_2', 'fixed_rate_payment_frequency_period_multiplier_leg_1', 'fixed_rate_payment_frequency_period_multiplier_leg_2',
  'floating_rate_payment_frequency_period_multiplier_leg_1', 'floating_rate_payment_frequency_period_multiplier_leg_2', 'floating_rate_reset_frequency_period_multiplier_leg_1',
  'floating_rate_reset_frequency_period_multiplier_leg_2', 'index_factor', 'notional_amount_leg_1', 'notional_amount_leg_2', 'notional_quantity_leg_1', 'notional_quantity_leg_2',
  'option_premium_amount', 'package_transaction_price', 'package_transaction_spread', 'price', 'put_amount', 'quantity_frequency_multiplier_leg_1', 'quantity_frequency_multiplier_leg_2',
  'spread_leg_1', 'spread_leg_2', 'strike_price', 'total_notional_quantity_leg_1', 'total_notional_quantity_leg_2',
])

const ALIAS_TO_FIELD: Record<string, string> = Object.fromEntries(Object.entries(SWAP_TRADES_SCHEMA.aliases).map(([field, source]) => [source, field]))

/** One print as a `CftcSwapTradesData` row (`_normalize_values` and the field validation). */
export function swapTradeRow(values: Rec): Row {
  const { normalized, capped } = normalizeValues(values, { aliasToField: ALIAS_TO_FIELD, numeric: NUMERIC_FIELDS })
  if (normalized.is_capped === undefined) normalized.is_capped = capped
  const identifier = normalized['Dissemination Identifier']
  delete normalized['Dissemination Identifier']
  delete normalized['Original Dissemination Identifier']
  if (identifier) {
    const asset = normalized['Asset Class'] || 'NA'
    if (normalized.trade_key === undefined) normalized.trade_key = `${asset}:${identifier}`
  }
  return validateRow(SWAP_TRADES_SCHEMA, normalized)
}

type Query = {
  assetClass: string
  startDate?: D
  endDate?: D
  currency?: string
  underlier?: string
  upiFisn?: string
  ticker?: string
  actionType?: string
  cleared?: boolean
  tradeType?: string
  minNotional?: number
  maxNotional?: number
  limit?: number
}

/** Narrow a report date's transactions to those matching the query (`_apply_filters`). */
export function applyFilters(records: Iterable<SliceRecord>, q: Query, today: D): Rec[] {
  const results: Rec[] = []
  for (const record of records) {
    let output: Rec = record
    if (q.assetClass === 'rates') {
      const category = classifyRatesSwap(record, today)
      if (category === null) continue
      if (q.tradeType && category !== q.tradeType) continue
      output = { ...record, trade_type: category }
    }
    if (q.currency && (record['Notional currency-Leg 1'] ?? '').trim().toUpperCase() !== q.currency.trim().toUpperCase()) continue
    if (q.underlier && !(record['UPI Underlier Name'] ?? '').toUpperCase().includes(q.underlier.trim().toUpperCase())) continue
    if (q.upiFisn && !(record['UPI FISN'] ?? '').toUpperCase().includes(q.upiFisn.trim().toUpperCase())) continue
    if (q.ticker && q.ticker.trim().toUpperCase() !== (record['Unique Product Identifier'] ?? '').trim().toUpperCase()) continue
    if (q.actionType && (record['Action type'] ?? '').trim().toUpperCase() !== q.actionType.trim().toUpperCase()) continue
    if (q.cleared !== undefined) {
      const isCleared = ['Y', 'I'].includes((record.Cleared ?? '').trim().toUpperCase())
      if (isCleared !== q.cleared) continue
    }
    if (q.minNotional !== undefined || q.maxNotional !== undefined) {
      const [notional] = parseNotional(record['Notional amount-Leg 1'])
      if (notional === null) continue
      if (q.minNotional !== undefined && notional < q.minNotional) continue
      if (q.maxNotional !== undefined && notional > q.maxNotional) continue
    }
    results.push(output)
    if (q.limit && results.length >= q.limit) break
  }
  return results
}

type Memo = Map<string, unknown>

/** Whether the currency's rate curve bootstraps from the day's own prints (`_curve_ok`). */
function curveOk(dayRecords: SliceRecord[], currency: string, day: D, memo: Memo): boolean {
  const key = `curve:${day}:${currency}`
  const known = memo.get(key)
  if (known !== undefined) return known as boolean
  let ok: boolean
  try {
    rateDiscountFactor(dayRecords, currency, day, 1)
    ok = true
  } catch (err) {
    if (!(err instanceof EmptyDataError)) throw err
    ok = false
  }
  memo.set(key, ok)
  return ok
}

/** Whether the pair's spot can be established from the day's forex prints (`_spot_ok`). */
function spotOk(fxRecords: SliceRecord[] | null, otherCurrency: string, currency: string, day: D, memo: Memo): boolean {
  const key = `spot:${day}:${otherCurrency}:${currency}`
  const known = memo.get(key)
  if (known !== undefined) return known as boolean
  const ok = !fxRecords || fxRecords.length === 0 ? false : fxSpot(fxRecords, otherCurrency, currency, day) !== null
  memo.set(key, ok)
  return ok
}

/** Whether an inflation print has a curve, a breakeven, and its published index (`_inflation_priceable`). */
function inflationPriceable(record: Rec, dayRecords: SliceRecord[], day: D, today: D, memo: Memo, indexLevels: Record<string, Levels>): boolean {
  const trade = extractInflationTrade(record, today)
  if (trade === null || !curveOk(dayRecords, trade.currency as string, day, memo)) return false
  const breakevenKey = `breakeven:${trade.currency}`
  if (!memo.has(breakevenKey)) memo.set(breakevenKey, buildBreakevenCurve(dayRecords, trade.currency as string, day, 1).length > 0)
  if (!memo.get(breakevenKey)) return false
  if ((trade.effective_date as D) >= day) return true
  const spec = INFLATION_INDICES[(trade.index as string | null) || '']
  const levels = indexLevels[(trade.index as string | null) || '']
  if (spec === undefined || !levels || levels.size === 0) return false
  return indexRatio(levels, trade.effective_date as D, day, spec.lag_months, spec.interpolate) !== null
}

/** Dispatch a print to the gate its own trade-type family is valued through (`_priceable_by_family`). */
function priceable(record: Rec, dayRecords: SliceRecord[], day: D, today: D, fxRecords: SliceRecord[] | null, memo: Memo, indexLevels: Record<string, Levels>): boolean {
  const family = record.trade_type as string | undefined
  if (family === 'inflation') return inflationPriceable(record, dayRecords, day, today, memo, indexLevels)
  if (family === 'basis' || family === 'cross_currency') {
    const trade = extractSpreadTrade(record, today)
    if (trade === null || !curveOk(dayRecords, trade.currency as string, day, memo)) return false
    if (family === 'cross_currency') return curveOk(dayRecords, trade.other_currency as string, day, memo) && spotOk(fxRecords, trade.other_currency as string, trade.currency as string, day, memo)
    const spreadKey = `spread:${trade.underlier}:${trade.trade_type}:${trade.spread_leg}`
    if (!memo.has(spreadKey)) memo.set(spreadKey, referenceSpread(dayRecords, trade.underlier as string, trade.trade_type as string, trade.spread_leg as number, day, 1))
    return memo.get(spreadKey) !== null
  }
  if (parseTradeRecord(record, today) === null) return false
  return curveOk(dayRecords, (record['Notional currency-Leg 1'] ?? '').trim(), day, memo)
}

/** The published levels for each index the day's inflation prints use (`_inflation_levels`). */
async function inflationLevels(ctx: NativeCtx, filtered: Rec[]): Promise<Record<string, Levels>> {
  const wanted = new Set<string>()
  for (const record of filtered) {
    if (record.trade_type !== 'inflation') continue
    const index = indexForInflationUnderlier(record['UPI Underlier Name'])
    if (index) wanted.add(index)
  }
  const levels: Record<string, Levels> = {}
  for (const index of [...wanted].sort()) {
    try {
      levels[index] = await getInflationIndex(ctx, index)
    } catch {
      continue
    }
  }
  return levels
}

/** The forex rows the swap valuation endpoints can actually price (`_keep_priceable_forex`). */
async function keepPriceableForex(ctx: NativeCtx, filtered: Rec[], dayRecords: SliceRecord[], day: D, q: Query): Promise<Rec[]> {
  let rates: SliceRecord[]
  try {
    rates = await getSlice(ctx, 'rates', day)
  } catch {
    return []
  }
  if (filtered.some((r) => mentionsCny(r))) {
    const extra = await cnyCurveRecords(ctx, day)
    if (extra.length > 0) rates = [...rates, ...extra]
  }
  const memo = new Map<string, unknown>()
  return filtered.filter((record) => valueFxTrade(record, dayRecords, rates, day, { minNotional: q.minNotional ?? 0.0, memo }) !== null)
}

/** The rates rows the swap valuation endpoints can actually price (`_keep_priceable`). */
async function keepPriceable(ctx: NativeCtx, filtered: Rec[], dayRecords: SliceRecord[], day: D, q: Query): Promise<Rec[]> {
  if (q.assetClass === 'forex') return keepPriceableForex(ctx, filtered, dayRecords, day, q)
  let fxRecords: SliceRecord[] | null = null
  if (filtered.some((r) => r.trade_type === 'cross_currency')) {
    try {
      fxRecords = await getSlice(ctx, 'forex', day)
    } catch {
      fxRecords = []
    }
  }
  const indexLevels = await inflationLevels(ctx, filtered)
  const today = todayOf(ctx.now())
  const memo = new Map<string, unknown>()
  return filtered.filter((record) => priceable(record, dayRecords, day, today, fxRecords, memo, indexLevels))
}

async function fetchSwapTrades(ctx: NativeCtx, q: Query): Promise<Rec[]> {
  const today = todayOf(ctx.now())
  const anchor = q.endDate ?? q.startDate
  if (q.ticker) {
    const searchEnd = anchor ?? today
    const searchStart = q.startDate ?? (anchor ? searchEnd : addDays(searchEnd, -(MAX_LOOKBACK_DAYS - 1)))
    if (searchStart > searchEnd) throw new Error(`The report-date window ends before it starts: ${searchStart} to ${searchEnd}.`)
    let records = await searchTrades(ctx, q.assetClass, searchStart, searchEnd, { currency: q.currency ?? null, upi: q.ticker.trim().toUpperCase() })
    if (anchor === undefined && records.length > 0) {
      const latest = records.map((r) => recordDisseminatedDay(r) ?? '').sort().at(-1)!
      records = records.filter((r) => (recordDisseminatedDay(r) ?? '') === latest)
    }
    const filtered = applyFilters(records, q, today)
    if (filtered.length === 0) throw new EmptyDataError(`No ${q.assetClass} transactions matched the query between ${searchStart} and ${searchEnd}.`)
    if (q.assetClass !== 'rates') return filtered
    const [rates, ratesDate] = await getRatesSliceFor(ctx, today, ['USD'])
    return keepPriceable(ctx, filtered, rates, ratesDate, q)
  }
  if (anchor === undefined) {
    const [records, viableDate] = await getLatestViableSlice(ctx, q.assetClass, (recs) => applyFilters(recs, q, today).length > 0)
    return keepPriceable(ctx, applyFilters(records, q, today), records, viableDate, q)
  }
  const endDate = q.endDate ?? anchor
  const startDate = q.startDate ?? anchor
  if (startDate > endDate) throw new Error(`The report-date window ends before it starts: ${startDate} to ${endDate}.`)
  const days = Array.from({ length: diffDays(endDate, startDate) + 1 }, (_v, i) => addDays(startDate, i))
  const perDay = await mapLimit(days, MAX_CONCURRENT_DOWNLOADS, async (reportDate) => {
    let records: SliceRecord[]
    try {
      records = await getSlice(ctx, q.assetClass, reportDate)
    } catch (err) {
      if (err instanceof EmptyDataError) return []
      throw err
    }
    return keepPriceable(ctx, applyFilters(records, q, today), records, reportDate, q)
  })
  const results = perDay.flat()
  if (results.length === 0) throw new EmptyDataError(`No ${q.assetClass} transactions matched the query between ${startDate} and ${endDate}.`)
  return q.limit ? results.slice(0, q.limit) : results
}

export const swapTrades: NativeHandler = async (params, ctx) => {
  const q: Query = { assetClass: (pStr(params, 'asset_class') ?? 'rates').toLowerCase() }
  const set = <K extends keyof Query>(key: K, value: Query[K] | undefined): void => {
    if (value !== undefined) q[key] = value
  }
  set('startDate', pDate(params, 'start_date'))
  set('endDate', pDate(params, 'end_date'))
  set('currency', pStr(params, 'currency'))
  set('underlier', pStr(params, 'underlier'))
  set('upiFisn', pStr(params, 'upi_fisn'))
  set('ticker', pStr(params, 'ticker'))
  set('actionType', pStr(params, 'action_type'))
  set('cleared', pBool(params, 'cleared'))
  set('tradeType', pStr(params, 'trade_type'))
  set('minNotional', pNum(params, 'min_notional'))
  set('maxNotional', pNum(params, 'max_notional'))
  set('limit', pNum(params, 'limit'))
  const data = await fetchSwapTrades(ctx, q)
  return data.map((d) => swapTradeRow(d))
}
