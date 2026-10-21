// cftc/cds_index_trades, fx_forward_trades and fx_option_trades, provider cftc. Ported from
// openbb_cftc/models/{cds_index_trades,fx_forward_trades,fx_option_trades}.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models (model.ts), slices are memoised with ctx.cache.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { EmptyDataError, type Rec, type SliceRecord } from './curve.js'
import { addDays, todayOf, type D } from './dates.js'
import { MAX_LOOKBACK_DAYS, getLatestViableSlice, getSlice, qualifiedKeys } from './dtcc.js'
import { normalizeValues, validateRow, type Schema } from './model.js'
import { pDate, pNum, pStr } from './params.js'
import { CDS_INDEX_TRADES_SCHEMA, FX_FORWARD_TRADES_SCHEMA, FX_OPTION_TRADES_SCHEMA } from './schemas.js'
import { searchTrades } from './search.js'
import { parseOtherPayments, recordDisseminatedDay } from './swap.js'
import { extractForwardTrades, extractOptionTrades, extractPrints } from './trades.js'

const NOT_PROVIDED = new Set(['9.9999999999'])

const aliasToField = (schema: Schema): Record<string, string> => Object.fromEntries(Object.entries(schema.aliases).map(([field, source]) => [source, field]))

/** Resolve a semicolon-joined other-payment list to the upfront that prices the print (`_upfront_payment`). */
function upfrontPayment(record: Rec): Rec {
  const payments = parseOtherPayments(record)
  if (payments.length < 2) return {}
  const chosen = payments.find((p) => p.type === 'UFRO') ?? payments[0]!
  return { 'Other payment type': chosen.type, 'Other payment amount': String(chosen.amount), 'Other payment currency': chosen.currency ?? '' }
}

const CDS_NUMERIC = new Set(['coupon', 'coupon_payment_frequency_multiplier', 'index_factor', 'notional_amount', 'spread', 'upfront_amount'])
const FX_FORWARD_NUMERIC = new Set(['exchange_rate', 'notional_1', 'notional_2', 'package_price', 'package_spread'])
const FX_OPTION_NUMERIC = new Set(['call_amount', 'put_amount', 'strike', 'exchange_rate', 'premium_amount', 'notional_1', 'notional_2', 'package_price', 'package_spread'])
const FX_BOOL = new Set(['block_trade', 'prime_brokerage', 'package_trade'])

const CDS_ALIASES = aliasToField(CDS_INDEX_TRADES_SCHEMA)
const FWD_ALIASES = aliasToField(FX_FORWARD_TRADES_SCHEMA)
const OPT_ALIASES = aliasToField(FX_OPTION_TRADES_SCHEMA)

/** A print as a `CftcCdsIndexTradesData` row. */
function cdsRow(d: Rec): Row {
  const values = { ...d, ...qualifiedKeys(d), ...upfrontPayment({ ...d, ...qualifiedKeys(d) }) }
  const { normalized, capped } = normalizeValues(values, { aliasToField: CDS_ALIASES, numeric: CDS_NUMERIC })
  if (normalized.is_capped === undefined) normalized.is_capped = capped
  return validateRow(CDS_INDEX_TRADES_SCHEMA, normalized)
}

function fxRow(schema: Schema, aliases: Record<string, string>, numeric: ReadonlySet<string>, d: Rec): Row {
  const { normalized, capped } = normalizeValues({ ...d, ...qualifiedKeys(d) }, { aliasToField: aliases, numeric, bool: FX_BOOL, notProvided: NOT_PROVIDED })
  if (normalized.is_capped === undefined) normalized.is_capped = capped
  return validateRow(schema, normalized)
}

/** The search-answered ticker path shared by the FX routes: newest day with matching prints (`aextract_data`). */
async function fxTickerPrints(ctx: NativeCtx, date: D | undefined, ticker: string, select: (records: SliceRecord[], day: D) => Rec[], what: string): Promise<Rec[]> {
  const endDate = date ?? todayOf(ctx.now())
  const startDate = date ?? addDays(endDate, -(MAX_LOOKBACK_DAYS - 1))
  const records = await searchTrades(ctx, 'forex', startDate, endDate, { upi: ticker.trim().toUpperCase() })
  const byDay = new Map<string, SliceRecord[]>()
  for (const record of records) {
    const day = recordDisseminatedDay(record) ?? ''
    if (day) {
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(record)
    }
  }
  for (const day of [...byDay.keys()].sort().reverse()) {
    const prints = select(byDay.get(day)!, day)
    if (prints.length > 0) return prints
  }
  throw new EmptyDataError(`No ${what} prints matched the query between ${startDate} and ${endDate}.`)
}

export const cdsIndexTrades: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const date = pDate(params, 'date')
  const select = (records: SliceRecord[], reportDate: D): Rec[] =>
    extractPrints(records, reportDate, { index: pStr(params, 'index') ?? null, tenor: pStr(params, 'tenor') ?? null, minNotional: pNum(params, 'min_notional') ?? null, limit: pNum(params, 'limit') ?? null })
  let prints: Rec[]
  if (date) {
    const records = await getSlice(ctx, 'credits', date)
    prints = select(records, date)
    if (prints.length === 0) throw new EmptyDataError(`No CDS index prints matched the query for ${date}.`)
  } else {
    const [records, reportDate] = await getLatestViableSlice(ctx, 'credits', (recs, day) => select(recs, day).length > 0)
    prints = select(records, reportDate)
  }
  return prints.map(cdsRow)
}

export const fxForwardTrades: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const date = pDate(params, 'date')
  const ticker = pStr(params, 'ticker')
  const select = (records: SliceRecord[], reportDate: D): Rec[] =>
    extractForwardTrades(records, reportDate, {
      pair: pStr(params, 'pair') ?? null,
      actionType: pStr(params, 'action_type') ?? null,
      product: pStr(params, 'product_type') ?? null,
      settled: pStr(params, 'settlement_currency') ?? null,
      minNotional: pNum(params, 'min_notional') ?? null,
      ticker: ticker ?? null,
      limit: pNum(params, 'limit') ?? null,
    })
  let prints: Rec[]
  if (ticker) prints = await fxTickerPrints(ctx, date, ticker, select, 'FX forward')
  else if (date) {
    const records = await getSlice(ctx, 'forex', date)
    prints = select(records, date)
    if (prints.length === 0) throw new EmptyDataError(`No FX forward prints matched the query for ${date}.`)
  } else {
    const [records, reportDate] = await getLatestViableSlice(ctx, 'forex', (recs, day) => select(recs, day).length > 0)
    prints = select(records, reportDate)
  }
  return prints.map((d) => fxRow(FX_FORWARD_TRADES_SCHEMA, FWD_ALIASES, FX_FORWARD_NUMERIC, d))
}

export const fxOptionTrades: NativeHandler = async (params: NativeParams, ctx: NativeCtx) => {
  const date = pDate(params, 'date')
  const ticker = pStr(params, 'ticker')
  const select = (records: SliceRecord[], reportDate: D): Rec[] =>
    extractOptionTrades(records, reportDate, {
      pair: pStr(params, 'pair') ?? null,
      actionType: pStr(params, 'action_type') ?? null,
      optionKind: pStr(params, 'option_type') ?? null,
      settled: pStr(params, 'settlement_currency') ?? null,
      minNotional: pNum(params, 'min_notional') ?? null,
      ticker: ticker ?? null,
      limit: pNum(params, 'limit') ?? null,
    })
  let prints: Rec[]
  if (ticker) prints = await fxTickerPrints(ctx, date, ticker, select, 'FX option')
  else if (date) {
    const records = await getSlice(ctx, 'forex', date)
    prints = select(records, date)
    if (prints.length === 0) throw new EmptyDataError(`No FX option prints matched the query for ${date}.`)
  } else {
    const [records, reportDate] = await getLatestViableSlice(ctx, 'forex', (recs, day) => select(recs, day).length > 0)
    prints = select(records, reportDate)
  }
  return prints.map((d) => fxRow(FX_OPTION_TRADES_SCHEMA, OPT_ALIASES, FX_OPTION_NUMERIC, d))
}
