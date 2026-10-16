// The yahoo-finance2 seam. Everything the connector needs from the library goes through
// `YahooClient`, so tests inject a fake that replays recorded fixtures and never touch the network.
import YahooFinance from 'yahoo-finance2'
import type { ChartOptionsWithReturnArray as ChartOptions, ChartResultArray } from 'yahoo-finance2/modules/chart'
import type { Quote } from 'yahoo-finance2/modules/quote'
import type { QuoteSummaryResult } from 'yahoo-finance2/modules/quoteSummary'
import type { SearchOptions, SearchResult } from 'yahoo-finance2/modules/search'

export type { ChartOptions, ChartResultArray, Quote, QuoteSummaryResult, SearchOptions, SearchResult }

/** The subset of yahoo-finance2 the connector uses. */
export interface YahooClient {
  search(term: string, opts: SearchOptions): Promise<SearchResult>
  quote(symbols: string[]): Promise<Quote[]>
  chart(symbol: string, opts: ChartOptions): Promise<ChartResultArray>
  quoteSummary(symbol: string, opts: { modules: ['calendarEvents'] }): Promise<QuoteSummaryResult>
}

export const RETRY_DELAY_MS = 500

/** yahoo-finance2 throws HTTPError with `code` set to the status; Yahoo also phrases it in the message. */
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (code === 429 || code === '429') return true
  return /\b429\b|too many requests/i.test(err.message)
}

export type RetryOptions = { sleep?: (ms: number) => Promise<void>; delayMs?: number }

/** Run `fn`; on a 429 wait once and run it again. Any other error, or a second 429, propagates. */
export async function retryOn429<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  try {
    return await fn()
  } catch (err) {
    if (!isRateLimited(err)) throw err
    await sleep(opts.delayMs ?? RETRY_DELAY_MS)
    return fn()
  }
}

/** Wrap any object with the four library methods (a real `YahooFinance` or a fake) with the 429 retry. */
export function wrapClient(raw: YahooClient, opts: RetryOptions = {}): YahooClient {
  return {
    search: (term, o) => retryOn429(() => raw.search(term, o), opts),
    quote: (symbols) => retryOn429(() => raw.quote(symbols), opts),
    chart: (symbol, o) => retryOn429(() => raw.chart(symbol, o), opts),
    quoteSummary: (symbol, o) => retryOn429(() => raw.quoteSummary(symbol, o), opts),
  }
}

/** A fresh live client. Prefer `defaultClient()` so the process shares one cookie jar and crumb. */
export function createYahooClient(opts: RetryOptions = {}): YahooClient {
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
  return wrapClient(
    {
      search: (term, o) => yf.search(term, o),
      quote: (symbols) => yf.quote(symbols),
      chart: (symbol, o) => yf.chart(symbol, { ...o, return: 'array' }),
      quoteSummary: (symbol, o) => yf.quoteSummary(symbol, o),
    },
    opts,
  )
}

let shared: YahooClient | undefined
/** The process-wide client, instantiated on first use. */
export function defaultClient(): YahooClient {
  shared ??= createYahooClient()
  return shared
}
