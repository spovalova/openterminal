// derivatives/options/chains, provider yfinance. Independent implementation of OpenBB's output for this route (not
// derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import { NativeHttpError } from '../http.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, isRecord, Q1, symbolsOf, todayNy, utcDate, wallParts, yahooJson } from './helpers.js'

type OptionResult = { underlyingSymbol?: string; expirationDates?: number[]; quote?: Row; options?: { expirationDate?: number; calls?: Row[]; puts?: Row[] }[] }

async function optionChain(ctx: NativeCtx, symbol: string, date?: number): Promise<OptionResult | undefined> {
  try {
    const body = await yahooJson<{ optionChain?: { result?: OptionResult[] | null } }>(ctx, `${Q1}/v7/finance/options/${encodeURIComponent(symbol)}`, { crumb: true, query: { ...(date !== undefined ? { date } : {}) } })
    return body.optionChain?.result?.[0] ?? undefined
  } catch (err) {
    if (err instanceof NativeHttpError && (err.status === 404 || err.status === 400)) return undefined
    throw err
  }
}

/** "2026-10-20 14:16:02-04:00": a timestamp on a time zone's clock, with its offset. */
function stamp(seconds: number, timeZone: string): string {
  const w = wallParts(seconds, timeZone)
  const asUtc = Date.parse(`${w.date}T${w.time}Z`) / 1000
  const offset = Math.round((asUtc - seconds) / 60)
  const sign = offset < 0 ? '-' : '+'
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm = String(Math.abs(offset) % 60).padStart(2, '0')
  return `${w.date} ${w.time}${sign}${hh}:${mm}`
}

const days = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** Every listed contract of a symbol across all expirations. */
export async function optionsChains(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = symbolsOf(params)[0]
  if (!symbol) return []
  const first = await optionChain(ctx, symbol)
  if (!first) return []
  const today = todayNy(ctx)
  const timeZone = typeof first.quote?.exchangeTimezoneName === 'string' ? first.quote.exchangeTimezoneName : 'America/New_York'
  const chains = [...(first.options ?? [])]
  for (const date of first.expirationDates ?? []) {
    if (chains.some((c) => c.expirationDate === date)) continue
    const more = await optionChain(ctx, symbol, date)
    chains.push(...(more?.options ?? []))
  }
  const underlyingPrice = first.quote?.regularMarketPrice
  const rows: Row[] = []
  for (const chain of chains) {
    const expiration = typeof chain.expirationDate === 'number' ? utcDate(chain.expirationDate) : undefined
    const contracts = [...(chain.calls ?? []).map((c) => ['call', c] as const), ...(chain.puts ?? []).map((c) => ['put', c] as const)]
    for (const [type, c] of contracts) {
      if (!isRecord(c)) continue
      rows.push(
        compact({
          underlying_symbol: first.underlyingSymbol ?? symbol,
          underlying_price: underlyingPrice,
          contract_symbol: c.contractSymbol,
          expiration,
          dte: expiration ? days(today, expiration) : undefined,
          strike: c.strike,
          option_type: type,
          open_interest: c.openInterest,
          volume: c.volume ?? 0,
          last_trade_price: c.lastPrice,
          last_trade_time: typeof c.lastTradeDate === 'number' ? stamp(c.lastTradeDate, timeZone) : undefined,
          bid: c.bid,
          ask: c.ask,
          change: c.change,
          change_percent: typeof c.percentChange === 'number' ? c.percentChange / 100 : undefined,
          implied_volatility: c.impliedVolatility,
          in_the_money: c.inTheMoney,
          currency: c.currency,
        }),
      )
    }
  }
  return rows.sort((a, b) => String(a.expiration).localeCompare(String(b.expiration)) || Number(a.strike) - Number(b.strike) || String(a.option_type).localeCompare(String(b.option_type)))
}

