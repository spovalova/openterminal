// equity/fundamental/dividends and equity/fundamental/historical_splits, provider yfinance. Independent implementation
// of OpenBB's output for these routes (not derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by
// yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fetchChart, type Chart } from './chart.js'
import { addDays, dayStart, symbolsOf, wallParts } from './helpers.js'

/** 1900-01-01: before any listing Yahoo has. */
const EPOCH_1900 = -2_208_988_800

/** A symbol's dividend and split history from `from` (seconds) on. Only daily bars carry every event: coarser ones merge them. */
export async function corporateActions(ctx: NativeCtx, symbol: string, from = EPOCH_1900, to = Math.floor(ctx.now().getTime() / 1000) + 86_400): Promise<Chart | undefined> {
  return fetchChart(ctx, symbol, { interval: '1d', period1: from, period2: to })
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/** Dividends with an ex-date in [start, end): start included, end excluded, either open. */
export async function dividends(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = symbolsOf(params)[0]
  if (!symbol) return []
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : undefined
  const end = typeof params.end_date === 'string' && params.end_date ? params.end_date : undefined
  // A window needs only its own stretch of bars; a day either side keeps the exchange's calendar out of the question.
  const chart = await corporateActions(ctx, symbol, start === undefined ? EPOCH_1900 : dayStart(addDays(start, -1)), end === undefined ? undefined : dayStart(addDays(end, 1)))
  if (!chart) return []
  return chart.dividends
    .map((d) => ({ ex_dividend_date: wallParts(d.time, chart.timezone).date, amount: d.amount }))
    .filter((d) => (start === undefined || d.ex_dividend_date >= start) && (end === undefined || d.ex_dividend_date < end))
    .sort((a, b) => a.ex_dividend_date.localeCompare(b.ex_dividend_date))
}

/** Every split, oldest first, with the ratio written the way Yahoo does ("2:1"). */
export async function historicalSplits(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = symbolsOf(params)[0]
  if (!symbol) return []
  const chart = await corporateActions(ctx, symbol)
  if (!chart) return []
  return chart.splits
    .filter((s) => s.numerator && s.denominator)
    .map((s) => {
      // 1000-for-996 is written 250:249.
      const g = Number.isInteger(s.numerator) && Number.isInteger(s.denominator) ? gcd(s.numerator!, s.denominator!) : 1
      const numerator = s.numerator! / g
      const denominator = s.denominator! / g
      return { date: wallParts(s.time, chart.timezone).date, numerator, denominator, split_ratio: `${numerator}:${denominator}` }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}
