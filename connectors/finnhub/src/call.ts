// Finnhub `descriptors()` and `call(route, params, ctx)` (PLAN.md section 17): the three REST paths the recipes
// name, answered through core's `inferFrame`. Finnhub stamps seconds; the frame convention is epoch ms, so the
// two time fields are scaled here and nothing else is touched. The kind handlers in index.ts are untouched.
import { inferFrame, parseDescriptors, type CallHandler, type Descriptor, type Frame, type ValidatedParams } from '@openterminal/core'
// Imported, not read from disk, so the release bundle carries it inline.
import descriptorsJson from './descriptors.json' with { type: 'json' }
import { get, type Config, type FinnhubEarningsCalendar, type FinnhubNewsItem, type FinnhubQuote } from './finnhub-api.js'

type Row = Record<string, unknown>

let memo: Descriptor[] | undefined
/** The three Finnhub paths as descriptors, from descriptors.json, validated once. */
export function finnhubDescriptors(): Descriptor[] {
  return (memo ??= parseDescriptors(descriptorsJson))
}

export const FINNHUB_ROUTES = ['quote', 'company-news', 'calendar/earnings'] as const
export type FinnhubRoute = (typeof FINNHUB_ROUTES)[number]

const text = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(',') : v === undefined || v === null ? '' : String(v))

/** Finnhub seconds → epoch ms; anything that is not a finite number stays as it is. */
export const secondsToMs = (v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : v)

export const callFinnhub: CallHandler<Config> = async (route: string, params: ValidatedParams, ctx): Promise<Frame> => {
  const descriptor = finnhubDescriptors().find((d) => d.route === route)
  const frame = (rows: Row[]) => inferFrame(rows, { connector: 'finnhub' }, { descriptor, dropEmpty: rows.length > 0 })
  switch (route as FinnhubRoute) {
    case 'quote': {
      const symbol = text(params.symbol).trim().toUpperCase()
      const q = await get<FinnhubQuote>(ctx, '/quote', { symbol })
      if (!q || q.c === 0) throw new Error(`quote: Finnhub has no quote for ${symbol} (unknown symbol)`)
      return frame([{ symbol, ...q, t: secondsToMs(q.t) }])
    }
    case 'company-news': {
      const symbol = text(params.symbol).trim().toUpperCase()
      const items = await get<FinnhubNewsItem[]>(ctx, '/company-news', { symbol, from: text(params.from), to: text(params.to) })
      const rows = (Array.isArray(items) ? items : []).map((n): Row => ({ symbol, ...n, datetime: secondsToMs(n.datetime) }))
      return frame(rows.sort((a, b) => Number(b.datetime ?? 0) - Number(a.datetime ?? 0)))
    }
    case 'calendar/earnings': {
      const query: Record<string, string> = { from: text(params.from), to: text(params.to) }
      const symbol = text(params.symbol).trim().toUpperCase()
      if (symbol) query.symbol = symbol
      const res = await get<FinnhubEarningsCalendar>(ctx, '/calendar/earnings', query)
      return frame((res?.earningsCalendar ?? []).map((e): Row => ({ ...e })))
    }
    default:
      throw new Error(`finnhub does not answer route "${route}" (routes: ${FINNHUB_ROUTES.join(', ')})`)
  }
}
