// OpenBB Platform connector: all five kinds through a local `openbb-api`, any OpenBB provider per kind.
// Keyless by default (yfinance, nasdaq); keyed providers are configured on the OpenBB side. See README.md.
import { defineConnector, toFrame } from '@terminal/core'
import {
  ConfigSchema,
  bySymbols,
  changePct,
  exchangeName,
  get,
  num,
  parseOpenbbTime,
  probeProviders,
  providerFor,
  rangeStartDate,
  str,
  toMarketState,
  toProviderInterval,
  toSession,
  type Config,
} from './openbb-api.js'

const meta = { connector: 'openbb' }
const SEARCH_LIMIT = 10
type Row = Record<string, unknown>

export { ConfigSchema, DEFAULT_PROVIDERS, DEFAULT_BASE_URL, INSTALL_HINT } from './openbb-api.js'

export default defineConnector<Config>({
  name: 'openbb',
  config: ConfigSchema,

  // GET /coverage/providers: small, proves the prefix, and lists what the OpenBB side has installed.
  health: async (ctx) => {
    const providers = await probeProviders(ctx)
    const shown = providers.slice(0, 8).join(', ') + (providers.length > 8 ? ', …' : '')
    return `OpenBB API at ${ctx.config.baseUrl}${providers.length ? ` · ${providers.length} providers (${shown})` : ''}`
  },

  queries: {
    // GET /equity/search?query=Q per query string; nasdaq rows carry a listing-exchange code.
    search: async ({ q }, ctx) => {
      const provider = providerFor(ctx.config, 'search')
      const perQuery = await Promise.allSettled(
        q.map(async (query) => {
          const rows = await get<Row>(ctx, '/equity/search', { query, provider })
          return rows
            .filter((r) => str(r.symbol))
            .slice(0, SEARCH_LIMIT)
            .map((r) => ({ query, symbol: str(r.symbol), name: str(r.name) ?? str(r.symbol), exchange: exchangeName(r) }))
        }),
      )
      const rows: Row[] = []
      const failures: string[] = []
      perQuery.forEach((r, i) => (r.status === 'fulfilled' ? rows.push(...r.value) : failures.push(`${q[i]}: ${errorText(r.reason)}`)))
      if (failures.length === perQuery.length) throw new Error(perQuery.length === 1 ? errorText(perQuery[0]!.status === 'rejected' ? perQuery[0]!.reason : '') : failures.join('; '))
      failures.forEach((f) => ctx.log(`skipped ${f}`))
      return toFrame('search', rows, meta)
    },

    // GET /equity/price/quote?symbol=A,B. yfinance has no change field (computed from prev_close) and no market state.
    // Rows without a symbol or price (unknown symbols, ETFs on yfinance) count as missing.
    quote: async ({ symbols }, ctx) => {
      const provider = providerFor(ctx.config, 'quote')
      const wanted = new Set(symbols)
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/price/quote', { symbol, provider }))
      const out: Row[] = []
      for (const r of rows) {
        const symbol = str(r.symbol)
        const price = num(r.last_price) ?? num(r.close)
        if (!symbol || price === null) continue
        if (!wanted.has(symbol)) continue
        out.push({ symbol, price, change_pct: changePct(r, price), volume: num(r.volume), market_state: toMarketState(r.market_status ?? r.market_state), extended_price: null, extended_change_pct: null })
      }
      // A quote table with a hole is wrong, not partial: yfinance returns ETFs (SPY, QQQ) with no last_price.
      // Throwing lets the registry answer the whole table from the next connector.
      const missing = symbols.filter((s) => !out.some((r) => r.symbol === s))
      if (missing.length > 0) throw new Error(`${provider} returned no price for ${missing.join(', ')}`)
      return toFrame('quote', out, meta)
    },

    // GET /equity/price/historical?symbol=A,B&start_date&interval. Multi-symbol rows carry `symbol`; single ones do not.
    ohlcv: async ({ symbols, interval, range }, ctx) => {
      const provider = providerFor(ctx.config, 'ohlcv')
      const start_date = rangeStartDate(range, new Date())
      const providerInterval = toProviderInterval(provider, interval)
      const rows = await bySymbols(ctx, provider, symbols, async (symbol) => {
        const bars = await get<Row>(ctx, '/equity/price/historical', { symbol, start_date, interval: providerInterval, provider })
        const only = symbol.includes(',') ? null : symbol
        return bars.map((b): Row => ({ ...b, symbol: str(b.symbol) ?? only }))
      })
      const out: Row[] = []
      for (const b of rows) {
        const symbol = str(b.symbol)
        const time = parseOpenbbTime(b.date)
        const close = num(b.close)
        if (!symbol || time === null || close === null) continue
        out.push({ symbol, time, open: num(b.open), high: num(b.high), low: num(b.low), close, volume: num(b.volume) })
      }
      out.sort((a, b) => (a.symbol! < b.symbol! ? -1 : a.symbol! > b.symbol! ? 1 : (a.time as number) - (b.time as number)))
      return toFrame('ohlcv', out, meta)
    },

    // GET /news/company?symbol=A,B&limit. Rows carry a comma-separated `symbols`; the first requested one wins.
    news: async ({ symbols, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'news')
      const items = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/news/company', { symbol, limit, provider }))
      const seen = new Set<string>()
      const out: Row[] = []
      for (const n of items) {
        const url = str(n.url)
        const headline = str(n.title)
        const time = parseOpenbbTime(n.date)
        if (!url || !headline || time === null || seen.has(url)) continue
        seen.add(url)
        const tagged = str(n.symbols)?.split(',').map((s) => s.trim()) ?? []
        const symbol = symbols.find((s) => tagged.includes(s)) ?? symbols[0]!
        out.push({ time, headline, source: str(n.publisher) ?? str(n.source) ?? str(n.author) ?? provider, url, symbol })
      }
      out.sort((a, b) => (b.time as number) - (a.time as number))
      return toFrame('news', out.slice(0, limit), meta)
    },

    // GET /equity/calendar/earnings?start_date&end_date is the whole market; keep our symbols. Session from the provider's word.
    earnings: async ({ symbols, from, to }, ctx) => {
      const provider = providerFor(ctx.config, 'earnings')
      const wanted = new Set(symbols)
      const rows = await get<Row>(ctx, '/equity/calendar/earnings', { start_date: from, end_date: to, provider })
      const out: Row[] = []
      for (const r of rows) {
        const symbol = str(r.symbol)
        const date = str(r.report_date) ?? str(r.date)
        if (!symbol || !date || !wanted.has(symbol)) continue
        out.push({ symbol, date: date.slice(0, 10), session: toSession(r.reporting_time ?? r.timing ?? r.time), eps_estimate: num(r.eps_consensus) ?? num(r.eps_estimate) })
      }
      out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.symbol).localeCompare(String(b.symbol)))
      return toFrame('earnings', out, meta)
    },
  },
})

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
