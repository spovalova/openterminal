// Ported from openbb_cboe/utils/vix.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// DataFrames, string dates instead of pandas Timestamps, and "today" is the UTC date where Python used the machine's
// local one (ctx.now() is the only clock).
import type { NativeCtx, Row } from '../types.js'
import { equityHistorical } from './equity-historical.js'
import { equityQuote } from './equity-quote.js'
import { addDays, compareText, nyToday } from './helpers.js'

export const VX_AM_SYMBOLS = ['TWLV1', 'TWLV2', 'TWLV3', 'TWLV4', 'TWLV5', 'TWLV6', 'TWLV7', 'TWLV8', 'TWLV9']
const VX_EOD_SYMBOL_TO_MONTH: Record<string, number> = { UZF: 1, UZG: 2, UZH: 3, UZJ: 4, UZK: 5, UZM: 6, UZN: 7, UZQ: 8, UZU: 9, UZV: 10, UZX: 11, UZZ: 12 }
const VX_EOD_SYMBOLS = Object.keys(VX_EOD_SYMBOL_TO_MONTH)

export type VxType = 'am' | 'eod'

/** `collections.deque.rotate`: a positive count moves items from the end to the front. */
function rotate<T>(list: readonly T[], n: number): T[] {
  if (list.length === 0) return []
  const k = ((n % list.length) + list.length) % list.length
  return k === 0 ? [...list] : [...list.slice(list.length - k), ...list.slice(0, list.length - k)]
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const utcToday = (ctx: NativeCtx): string => ctx.now().toISOString().slice(0, 10)
/** Monday is 0, as in Python's `date.weekday()`. */
const weekday = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7

/** The front month, rolling on the third Wednesday of the month (`get_front_month`). */
export function getFrontMonth(ctx: NativeCtx, date?: string): number {
  const iso = date ?? nyToday(ctx)
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number]
  const firstWednesday = 1 + ((2 - weekday(`${year}-${pad2(month)}-01`) + 7) % 7)
  return day > firstWednesday + 14 ? (month % 12) + 1 : month
}

/** The VX1-VX12 relative contracts → Cboe EOD symbols (`get_vx_symbols`). */
export function getVxSymbols(ctx: NativeCtx, date?: string): Record<string, string> {
  return Object.fromEntries(rotate(VX_EOD_SYMBOLS, -(getFrontMonth(ctx, date) - 1)).map((s, i) => [`VX${i + 1}`, s]))
}

/** The VX1-VX12 relative contracts → forward expiration months (`get_months`). */
export function getMonths(frontMonth: number): Record<string, number> {
  return Object.fromEntries(rotate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], -(frontMonth % 12) + 1).map((m, i) => [`VX${i + 1}`, m]))
}

/** Roll a weekend date back to the preceding Friday (`check_date`). */
export function checkDate(date: string): string {
  const wd = weekday(date)
  return wd < 5 ? date : addDays(date, -(wd - 4))
}

/** "2026-03" labels for the first nine contracts from a start year, a year ahead once the months wrap to January. */
function expirationLabels(months: number[], startYear: number, bumpYear: (month: number) => boolean): string[] {
  let year = startYear
  return months.map((month) => {
    if (bumpYear(month)) year += 1
    return `${year}-${pad2(month)}`
  })
}

/** The current quotes for the VX futures: expiration and price (`get_vx_current`). */
export async function getVxCurrent(ctx: NativeCtx, vxType: VxType): Promise<{ expiration: string; price: number }[]> {
  const currentSymbols = Object.values(getVxSymbols(ctx)).slice(0, 9)
  const symbols = vxType === 'am' ? VX_AM_SYMBOLS : currentSymbols
  const currentMonths = currentSymbols.map((s) => VX_EOD_SYMBOL_TO_MONTH[s]!)
  const today = new Date(`${utcToday(ctx)}T00:00:00Z`)
  const quotes = await equityQuote({ symbol: symbols, use_cache: false }, ctx)

  let rows: { symbol: unknown; price: unknown }[]
  if (vxType === 'am') rows = quotes.map((q) => ({ symbol: q.symbol, price: q.last_price }))
  else {
    // Latest first, then the current contracts in their calendar order.
    const bySymbol = new Map<unknown, Row>()
    for (const q of [...quotes].sort((a, b) => (String(b.last_timestamp ?? '') < String(a.last_timestamp ?? '') ? -1 : 1))) if (!bySymbol.has(q.symbol)) bySymbol.set(q.symbol, q)
    rows = currentSymbols.filter((s) => bySymbol.has(s)).map((s) => ({ symbol: s, price: bySymbol.get(s)!.last_price }))
  }
  const expirations = expirationLabels(currentMonths, today.getUTCFullYear(), (month) => month === 1 && today.getUTCMonth() + 1 !== 1)
  if (expirations.length !== rows.length) throw new Error(`Length of values (${expirations.length}) does not match length of index (${rows.length})`)
  return rows.flatMap((r, i) => (typeof r.price === 'number' ? [{ expiration: expirations[i]!, price: r.price }] : []))
}

/** The VX futures curve as of one or more dates (`get_vx_by_date`): date, expiration, symbol and price per contract. */
export async function getVxByDate(ctx: NativeCtx, dateParam: string, vxType: VxType): Promise<Row[]> {
  const symbols = vxType === 'eod' ? Object.values(getVxSymbols(ctx)) : VX_AM_SYMBOLS
  const dates = dateParam.split(',').map((d) => checkDate(d.trim())).sort()
  const today = checkDate(utcToday(ctx))

  let startDate: string
  let endDate: string
  if (dates.length === 1) {
    const newDate = checkDate(dates[0]!)
    if (newDate === today) return (await getVxCurrent(ctx, vxType)).map((r) => ({ ...r, date: newDate }))
    endDate = newDate
    startDate = checkDate(addDays(newDate, -1))
  } else {
    startDate = checkDate(dates[0]!)
    endDate = checkDate(dates[dates.length - 1]!)
  }

  let currentData: Row[] = []
  if (endDate === today) {
    const current = await getVxCurrent(ctx, vxType)
    if (current.length !== 9) throw new Error(`Length of values (9) does not match length of index (${current.length})`)
    currentData = current.map((r, i) => ({ ...r, date: endDate, symbol: `VX${i + 1}` }))
  }

  const history = await equityHistorical({ symbol: symbols.join(','), start_date: startDate, end_date: endDate, use_cache: false }, ctx)

  // pivot(index=date, columns=symbol, values=close); the mid-morning curve keeps only sessions that priced every contract.
  const pivot = new Map<string, Map<string, number | undefined>>()
  const pivotColumns = new Set<string>()
  for (const r of history) {
    const date = String(r.date).slice(0, 10)
    if (!pivot.has(date)) pivot.set(date, new Map())
    pivot.get(date)!.set(String(r.symbol), typeof r.close === 'number' ? r.close : undefined)
    pivotColumns.add(String(r.symbol))
  }
  let index = [...pivot.keys()].sort()
  if (vxType === 'am') index = index.filter((d) => [...pivotColumns].every((s) => pivot.get(d)!.get(s) !== undefined))

  // The session nearest each requested date: the last one on or before it, else the closest after.
  const dayMs = 24 * 3600 * 1000
  const nearest = dates.map((d) => {
    const before = index.filter((i) => i <= d).pop()
    if (before !== undefined) return before
    let best = index[0]!
    for (const i of index) if (Math.abs(Date.parse(i) - Date.parse(d)) / dayMs < Math.abs(Date.parse(best) - Date.parse(d)) / dayMs) best = i
    return best
  })
  const sessions = index.filter((d) => nearest.includes(d))

  const output: Row[] = []
  for (const session of sessions) {
    const current = vxType === 'am' ? VX_AM_SYMBOLS : Object.values(getVxSymbols(ctx, session)).slice(0, 9)
    const columns = current.filter((s) => pivotColumns.has(s))
    const frontMonth = getFrontMonth(ctx, session)
    const months = Object.values(getMonths(frontMonth)).slice(0, 9)
    const expirations = expirationLabels(months, Number(session.slice(0, 4)), (month) => month === 1 && frontMonth !== 1)
    if (columns.length !== expirations.length) throw new Error(`Length of values (${expirations.length}) does not match length of index (${columns.length})`)
    const relative = vxType === 'am' ? Object.fromEntries(VX_AM_SYMBOLS.map((s) => [s, s.replace('TWLV', 'VX')])) : Object.fromEntries(Object.entries(getVxSymbols(ctx, session)).map(([k, v]) => [v, k]))
    columns.forEach((column, i) => {
      const price = pivot.get(session)!.get(column)
      if (price !== undefined) output.push({ date: session, expiration: expirations[i], price, symbol: relative[column] })
    })
  }
  if (currentData.length > 0 && !output.some((r) => r.date === currentData[0]!.date)) output.push(...currentData)
  if (output.length === 0) throw new Error('The response was returned empty.')

  const lastNearest = nearest[nearest.length - 1]!
  const kept = dates[dates.length - 1] !== lastNearest && currentData.length > 0 ? output.filter((r) => r.date !== lastNearest) : output
  return kept.sort((a, b) => compareText(a.date, b.date) || compareText(a.symbol, b.symbol))
}
