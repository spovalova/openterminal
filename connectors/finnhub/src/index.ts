// Finnhub connector: quote, news, earnings. Free key, 60 calls/min. See README.md.
import { z } from 'zod'
import { defineConnector, toFrame, MS } from '@terminal/core'
import { get, perSymbol, isoDay, toSession, type Config, type FinnhubQuote, type FinnhubNewsItem, type FinnhubEarningsCalendar } from './finnhub-api.js'

const NEWS_WINDOW_DAYS = 7
const meta = { connector: 'finnhub' }

export default defineConnector<Config>({
  name: 'finnhub',
  config: z.object({ apiKey: z.string().min(1) }),
  queries: {
    // GET /quote?symbol=X per symbol. Finnhub has no volume or extended hours here; c === 0 means unknown symbol.
    quote: async ({ symbols }, ctx) => {
      const rows = await perSymbol(ctx, symbols, async (symbol) => {
        const q = await get<FinnhubQuote>(ctx, '/quote', { symbol })
        if (q.c === 0) {
          ctx.log(`no quote for ${symbol}, skipping`)
          return []
        }
        return [{ symbol, price: q.c, change_pct: q.dp ?? null, volume: null, market_state: null, extended_price: null, extended_change_pct: null }]
      })
      return toFrame('quote', rows, meta)
    },

    // GET /company-news?symbol=X&from=&to= per symbol over the last 7 days, merged newest first, deduped by url.
    news: async ({ symbols, limit }, ctx) => {
      const to = isoDay(Date.now())
      const from = isoDay(Date.now() - NEWS_WINDOW_DAYS * MS.day)
      const rows = await perSymbol(ctx, symbols, async (symbol) => {
        const items = await get<FinnhubNewsItem[]>(ctx, '/company-news', { symbol, from, to })
        return items.map((n) => ({ time: n.datetime * 1000, headline: n.headline, source: n.source, url: n.url, symbol }))
      })
      const seen = new Set<string>()
      const unique = rows.sort((a, b) => b.time - a.time).filter((r) => !seen.has(r.url) && seen.add(r.url))
      return toFrame('news', unique.slice(0, limit), meta)
    },

    // GET /calendar/earnings?from=&to=&symbol=X per symbol. `hour` bmo/amc maps to session, anything else is null.
    earnings: async ({ symbols, from, to }, ctx) => {
      const rows = await perSymbol(ctx, symbols, async (symbol) => {
        const res = await get<FinnhubEarningsCalendar>(ctx, '/calendar/earnings', { from, to, symbol })
        return (res.earningsCalendar ?? []).map((e) => ({ symbol, date: e.date, session: toSession(e.hour), eps_estimate: e.epsEstimate ?? null }))
      })
      return toFrame('earnings', rows, meta)
    },
  },
})
