// OpenBB Platform connector: all 22 kinds through a local `openbb-api`, any OpenBB provider per kind.
// Keyless by default (yfinance, nasdaq, sec, finra, cboe, federal_reserve, oecd); keyed providers are configured on the OpenBB side. See README.md.
import { defineConnector, toFrame, type MacroSeries } from '@terminal/core'
import {
  ConfigSchema,
  MACRO_ROUTES,
  NASDAQ_MOVER_CATEGORIES,
  YFINANCE_MOVER_PRESETS,
  TREASURY_COLUMNS,
  bySymbols,
  changePct,
  cleanText,
  countryParam,
  eachSymbol,
  errorText,
  exchangeName,
  get,
  inRequestedOrder,
  insiderAction,
  ivRank,
  maturityLabel,
  newestPerSymbol,
  num,
  parseOpenbbTime,
  pct,
  pickExpiration,
  probeProviders,
  providerFor,
  rangeStartDate,
  str,
  strikeWindow,
  toMarketState,
  toProviderInterval,
  toSession,
  type Config,
  type Expiration,
  type MacroRoute,
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

    // ------------------------------------------------------------ v1.2: company

    // GET /equity/profile?symbol=A,B. yfinance: stock_exchange (a Yahoo code such as NMS), industry_category, long_description. Unknown symbols are dropped; all unknown is a 204.
    profile: async ({ symbols }, ctx) => {
      const provider = providerFor(ctx.config, 'profile')
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/profile', { symbol, provider }))
      const out = rows
        .filter((r) => str(r.symbol) && symbols.includes(str(r.symbol)!))
        .map((r): Row => ({
          symbol: str(r.symbol),
          name: str(r.name),
          exchange: str(r.stock_exchange) ?? exchangeName(r),
          sector: str(r.sector),
          industry: str(r.industry_category) ?? str(r.industry),
          market_cap: num(r.market_cap),
          employees: num(r.employees),
          beta: num(r.beta),
          description: str(r.long_description) ?? str(r.description),
        }))
      return toFrame('profile', inRequestedOrder(requireRows(out, provider, 'profile', symbols, ctx), symbols), meta)
    },

    // GET /equity/fundamental/metrics?symbol=A,B (yfinance only). Margins, growth and ROE are fractions; dividend_yield is
    // already percent (AAPL 0.31, MSFT 0.74) passes through; debt_to_equity is percent-form (AAPL 78.4) and becomes a ratio (0.78) to match the yahoo connector. ps is EV/revenue.
    metrics: async ({ symbols }, ctx) => {
      const provider = providerFor(ctx.config, 'metrics')
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/fundamental/metrics', { symbol, provider }))
      const out = rows
        .filter((r) => str(r.symbol) && symbols.includes(str(r.symbol)!))
        .map((r): Row => ({
          symbol: str(r.symbol),
          market_cap: num(r.market_cap),
          pe: num(r.pe_ratio),
          forward_pe: num(r.forward_pe),
          peg: num(r.peg_ratio),
          ev_ebitda: num(r.enterprise_to_ebitda),
          ps: num(r.enterprise_to_revenue),
          pb: num(r.price_to_book),
          gross_margin: pct(r.gross_margin),
          operating_margin: pct(r.operating_margin),
          profit_margin: pct(r.profit_margin),
          revenue_growth: pct(r.revenue_growth),
          earnings_growth: pct(r.earnings_growth),
          roe: pct(r.return_on_equity),
          debt_to_equity: ratioFromPercent(r.debt_to_equity),
          dividend_yield: num(r.dividend_yield),
        }))
      return toFrame('metrics', inRequestedOrder(requireRows(out, provider, 'metrics', symbols, ctx), symbols), meta)
    },

    // GET /equity/fundamental/{income,cash,balance}?symbol=X&period&limit, one symbol per call (a comma list answers []),
    // joined on period_ending. capex is the positive spend (yfinance reports it negative); free cash flow is ocf − capex.
    financials: async ({ symbols, period, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'financials')
      const rows = await eachSymbol(ctx, symbols, async (symbol) => {
        const params = { symbol, period, limit, provider }
        const [income, cash, balance] = await Promise.allSettled([
          get<Row>(ctx, '/equity/fundamental/income', params),
          get<Row>(ctx, '/equity/fundamental/cash', params),
          get<Row>(ctx, '/equity/fundamental/balance', params),
        ])
        const statements = { income, cash, balance }
        const failed = Object.entries(statements).filter(([, r]) => r.status === 'rejected')
        if (failed.length === 3) throw new Error(errorText((income as PromiseRejectedResult).reason))
        failed.forEach(([name, r]) => ctx.log(`skipped ${symbol} ${name}: ${errorText((r as PromiseRejectedResult).reason)}`))
        const byPeriod = new Map<string, Row>()
        const slot = (r: Row): Row | null => {
          const key = str(r.period_ending)?.slice(0, 10)
          if (!key) return null
          if (!byPeriod.has(key)) byPeriod.set(key, { symbol, period_ending: key })
          return byPeriod.get(key)!
        }
        for (const r of income.status === 'fulfilled' ? income.value : []) {
          const t = slot(r)
          if (!t) continue
          Object.assign(t, { revenue: num(r.total_revenue) ?? num(r.revenue), gross_profit: num(r.gross_profit), operating_income: num(r.operating_income), net_income: num(r.net_income), eps: num(r.diluted_earnings_per_share) ?? num(r.eps_diluted), shares_income: num(r.weighted_average_diluted_shares_outstanding) })
        }
        for (const r of cash.status === 'fulfilled' ? cash.value : []) {
          const t = slot(r)
          if (!t) continue
          const ocf = num(r.operating_cash_flow)
          const reported = num(r.capital_expenditure_reported) ?? num(r.capital_expenditure)
          const capex = reported === null ? null : Math.abs(reported)
          Object.assign(t, { operating_cash_flow: ocf, capex, free_cash_flow: ocf !== null && capex !== null ? ocf - capex : num(r.free_cash_flow) })
        }
        for (const r of balance.status === 'fulfilled' ? balance.value : []) {
          const t = slot(r)
          if (!t) continue
          Object.assign(t, { cash: num(r.cash_and_cash_equivalents) ?? num(r.cash_cash_equivalents_and_short_term_investments), debt: num(r.total_debt), shares: num(r.ordinary_shares_number) })
        }
        return [...byPeriod.values()].map((t): Row => ({ ...t, shares: t.shares ?? t.shares_income ?? null }))
      })
      const out = newestPerSymbol(rows, symbols, limit, 'period_ending')
      return toFrame('financials', requireRows(out, provider, 'financials', symbols, ctx), meta)
    },

    // GET /equity/estimates/consensus?symbol=A,B plus, on yfinance, /yfinance/estimates/earnings?symbol=A,B (periods 0q, +1q, 0y, +1y with mean and growth).
    estimates: async ({ symbols }, ctx) => {
      const provider = providerFor(ctx.config, 'estimates')
      const [consensus, eps] = await Promise.allSettled([
        bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/estimates/consensus', { symbol, provider })),
        provider === 'yfinance' ? bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/yfinance/estimates/earnings', { symbol })) : Promise.resolve([] as Row[]),
      ])
      if (consensus.status === 'rejected' && eps.status === 'rejected') throw new Error(errorText(consensus.reason))
      if (consensus.status === 'rejected') ctx.log(`skipped consensus: ${errorText(consensus.reason)}`)
      if (eps.status === 'rejected') ctx.log(`skipped eps estimates: ${errorText(eps.reason)}`)
      const bySymbol = new Map<string, Row>()
      const slot = (symbol: string): Row => {
        if (!bySymbol.has(symbol)) bySymbol.set(symbol, { symbol })
        return bySymbol.get(symbol)!
      }
      for (const r of consensus.status === 'fulfilled' ? consensus.value : []) {
        const symbol = str(r.symbol)
        if (!symbol || !symbols.includes(symbol)) continue
        const target = num(r.target_consensus)
        const price = num(r.current_price)
        Object.assign(slot(symbol), {
          recommendation: str(r.recommendation),
          analysts: num(r.number_of_analysts),
          target_low: num(r.target_low),
          target_consensus: target,
          target_high: num(r.target_high),
          upside_pct: target !== null && price !== null && price > 0 ? Math.round((target / price - 1) * 100 * 1e4) / 1e4 : null,
        })
      }
      for (const r of eps.status === 'fulfilled' ? eps.value : []) {
        const symbol = str(r.symbol)
        const period = str(r.period)
        if (!symbol || !symbols.includes(symbol)) continue
        if (period === '0q') Object.assign(slot(symbol), { eps_estimate_q: num(r.mean) })
        if (period === '0y') Object.assign(slot(symbol), { eps_estimate_y: num(r.mean), eps_growth_y: pct(r.growth) })
      }
      return toFrame('estimates', inRequestedOrder(requireRows([...bySymbol.values()], provider, 'estimates', symbols, ctx), symbols), meta)
    },

    // GET /equity/fundamental/historical_eps?symbol=A,B&limit. yfinance rows are newest first with the next report (estimate only) on top; surprise_percent is already percent.
    eps_history: async ({ symbols, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'eps_history')
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/fundamental/historical_eps', { symbol, limit, provider }))
      const out: Row[] = []
      for (const r of rows) {
        const symbol = str(r.symbol)
        const date = str(r.date)?.slice(0, 10)
        if (!symbol || !date || !symbols.includes(symbol)) continue
        out.push({ symbol, date, eps_actual: num(r.eps_actual), eps_estimate: num(r.eps_estimated) ?? num(r.eps_estimate), surprise_pct: num(r.surprise_percent) })
      }
      return toFrame('eps_history', newestPerSymbol(requireRows(out, provider, 'eps history', symbols, ctx), symbols, limit), meta)
    },

    // GET /equity/fundamental/dividends?symbol=X, one symbol per call (a comma list is a 400), oldest first and no symbol field.
    dividends: async ({ symbols, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'dividends')
      const rows = await eachSymbol(ctx, symbols, async (symbol) => {
        const divs = await get<Row>(ctx, '/equity/fundamental/dividends', { symbol, provider })
        return divs.map((d): Row => ({ symbol, ex_date: str(d.ex_dividend_date)?.slice(0, 10) ?? null, amount: num(d.amount) })).filter((d) => d.ex_date && d.amount !== null)
      })
      return toFrame('dividends', newestPerSymbol(requireRows(rows, provider, 'dividends', symbols, ctx), symbols, limit, 'ex_date'), meta)
    },

    // ------------------------------------------------------------ v1.2: ownership and positioning

    // GET /equity/ownership/insider_trading?symbol=X. sec: Form 4 rows (acquisition_or_disposition, the transaction code's
    // name, price, filing_url; `limit` is ignored, holdings-only rows have no transaction_date). yfinance: description plus transaction_value.
    insiders: async ({ symbols, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'insiders')
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/ownership/insider_trading', { symbol, limit, provider }))
      const out: Row[] = []
      for (const r of rows) {
        const symbol = str(r.symbol) ?? (symbols.length === 1 ? symbols[0]! : null)
        const date = str(r.transaction_date)?.slice(0, 10)
        if (!symbol || !date || !symbols.includes(symbol)) continue
        const shares = num(r.securities_transacted)
        const value = num(r.transaction_value)
        const price = num(r.transaction_price) ?? (shares && value !== null ? Math.round((value / shares) * 100) / 100 : null)
        out.push({
          symbol,
          date,
          name: str(r.owner_name),
          title: str(r.owner_title),
          action: insiderAction(r.acquisition_or_disposition, r.transaction_type, r.description),
          shares,
          price,
          value: shares !== null && price !== null ? Math.round(shares * price * 100) / 100 : value,
          url: str(r.filing_url),
        })
      }
      return toFrame('insiders', newestPerSymbol(requireRows(out, provider, 'insider transactions', symbols, ctx), symbols, limit), meta)
    },

    // GET /equity/ownership/institutional?symbol=X&limit (nasdaq, one symbol; market_value is in thousands of dollars) or
    // /yfinance/ownership/institutional (holder, shares, value in dollars, percent_change). Sorted by value desc.
    institutions: async ({ symbols, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'institutions')
      const path = provider === 'yfinance' ? '/yfinance/ownership/institutional' : '/equity/ownership/institutional'
      const rows = await eachSymbol(ctx, symbols, async (symbol) => {
        const holders = await get<Row>(ctx, path, provider === 'yfinance' ? { symbol } : { symbol, limit, provider })
        return holders
          .map((h): Row => {
            const value = num(h.market_value) ?? num(h.value)
            return {
              symbol,
              date: (str(h.date) ?? str(h.date_reported))?.slice(0, 10) ?? null,
              holder: str(h.owner_name) ?? str(h.holder),
              shares: num(h.shares_held) ?? num(h.shares),
              change_pct: pct(h.shares_change_percent ?? h.percent_change),
              value: value === null ? null : provider === 'nasdaq' ? value * 1000 : value,
            }
          })
          .filter((h) => h.holder)
          .sort((a, b) => ((b.value as number | null) ?? -1) - ((a.value as number | null) ?? -1))
          .slice(0, limit)
      })
      return toFrame('institutions', inRequestedOrder(requireRows(rows, provider, 'institutional holders', symbols, ctx), symbols), meta)
    },

    // GET /equity/shorts/short_interest?symbol=A,B. finra: the full history oldest first with change_pct already percent; nasdaq: 12 months, change_pct a fraction.
    short_interest: async ({ symbols, limit }, ctx) => {
      const provider = providerFor(ctx.config, 'short_interest')
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/shorts/short_interest', { symbol, provider }))
      const out: Row[] = []
      for (const r of rows) {
        const symbol = str(r.symbol) ?? (symbols.length === 1 ? symbols[0]! : null)
        const date = str(r.settlement_date)?.slice(0, 10)
        if (!symbol || !date || !symbols.includes(symbol)) continue
        out.push({
          symbol,
          date,
          short_interest: num(r.current_short_position) ?? num(r.short_interest),
          change_pct: provider === 'nasdaq' ? pct(r.change_pct) : num(r.change_pct),
          avg_volume: num(r.avg_daily_volume),
          days_to_cover: num(r.days_to_cover),
        })
      }
      return toFrame('short_interest', newestPerSymbol(requireRows(out, provider, 'short interest', symbols, ctx), symbols, limit), meta)
    },

    // ------------------------------------------------------------ v1.2: options and volatility

    // GET /derivatives/options/chains?symbol=X is the whole chain (MU: 11,000 rows, 1.7 s on cboe); this keeps one expiration
    // and a strike window. implied_volatility is a fraction. An unknown symbol is a 400 ("not found in the Cboe options directory").
    options: async ({ symbol, expiration, strikes, type }, ctx) => {
      const provider = providerFor(ctx.config, 'options')
      const chain = await get<Row>(ctx, '/derivatives/options/chains', { symbol, provider })
      const listed = new Map<string, Expiration>()
      for (const c of chain) {
        const exp = str(c.expiration)?.slice(0, 10)
        if (exp && !listed.has(exp)) listed.set(exp, { expiration: exp, dte: num(c.dte) ?? dteFrom(exp) })
      }
      if (listed.size === 0) throw new Error(`${provider} returned no option chain for ${symbol}`)
      const chosen = pickExpiration([...listed.values()], expiration)
      if (!chosen) throw new Error(`${symbol} has no expiration on or after ${expiration} (last listed ${[...listed.keys()].sort().at(-1)})`)
      const contracts = chain.filter((c) => str(c.expiration)?.slice(0, 10) === chosen.expiration && num(c.strike) !== null)
      const underlying = contracts.map((c) => num(c.underlying_price)).find((p) => p !== null) ?? chain.map((c) => num(c.underlying_price)).find((p) => p !== null) ?? null
      if (underlying === null) throw new Error(`${provider} returned no underlying price for ${symbol}`)
      const window = new Set(strikeWindow(contracts.map((c) => num(c.strike)!), underlying, strikes))
      const out = contracts
        .filter((c) => window.has(num(c.strike)!))
        .map((c): Row => ({
          symbol,
          expiration: chosen.expiration,
          type: str(c.option_type)?.toLowerCase() ?? null,
          strike: num(c.strike),
          bid: num(c.bid),
          ask: num(c.ask),
          last: num(c.last_trade_price) ?? num(c.last_price),
          volume: num(c.volume),
          open_interest: num(c.open_interest),
          iv: pct(c.implied_volatility),
          delta: num(c.delta),
          gamma: num(c.gamma),
          theta: num(c.theta),
          vega: num(c.vega),
          underlying_price: underlying,
          dte: chosen.dte,
        }))
        .filter((c) => (type === 'both' ? c.type === 'call' || c.type === 'put' : c.type === type))
        .sort((a, b) => (a.strike as number) - (b.strike as number) || (a.type === b.type ? 0 : a.type === 'call' ? -1 : 1))
      return toFrame('options', out, meta)
    },

    // GET /equity/price/quote?symbol=X on cboe carries iv30 with its one-year range and the hv30 range, all fractions. There is no hv30 spot field (null).
    volatility: async ({ symbols }, ctx) => {
      const provider = providerFor(ctx.config, 'volatility')
      const rows = await bySymbols(ctx, provider, symbols, (symbol) => get<Row>(ctx, '/equity/price/quote', { symbol, provider }))
      const out: Row[] = []
      for (const r of rows) {
        const symbol = str(r.symbol)
        if (!symbol || !symbols.includes(symbol)) continue
        const iv30 = pct(r.iv30)
        const iv30_high = pct(r.iv30_annual_high)
        const iv30_low = pct(r.iv30_annual_low)
        if (iv30 === null && num(r.year_high) === null) continue
        out.push({ symbol, iv30, iv30_high, iv30_low, iv_rank: ivRank(iv30, iv30_low, iv30_high), hv30: pct(r.hv30), hv30_high: pct(r.hv30_annual_high), hv30_low: pct(r.hv30_annual_low), year_high: num(r.year_high), year_low: num(r.year_low) })
      }
      return toFrame('volatility', inRequestedOrder(requireRows(out, provider, 'volatility', symbols, ctx), symbols), meta)
    },

    // ------------------------------------------------------------ v1.2: market-wide

    // GET /economy/calendar?start_date&end_date&country. nasdaq stamps are zone-less New York wall time ("2026-10-21T08:30:00"); cells are text with "-" and blank for nothing.
    calendar: async ({ from, to, country }, ctx) => {
      const provider = providerFor(ctx.config, 'calendar')
      const rows = await get<Row>(ctx, '/economy/calendar', { start_date: from, end_date: to, country: countryParam(country), provider })
      const out: Row[] = []
      for (const r of rows) {
        const time = parseOpenbbTime(r.date)
        const event = str(r.event)
        if (time === null || !event) continue
        out.push({ time, country: str(r.country) ?? country, event, actual: cleanText(r.actual), consensus: cleanText(r.consensus), previous: cleanText(r.previous) })
      }
      out.sort((a, b) => (a.time as number) - (b.time as number) || String(a.event).localeCompare(String(b.event)))
      return toFrame('calendar', out, meta)
    },

    // GET /equity/calendar/ipo?start_date&end_date&status: nasdaq serves one status per call, so priced and upcoming are fetched
    // together, and it answers whole months, so rows are cut to the window here. An empty window is a 204.
    ipos: async ({ from, to }, ctx) => {
      const provider = providerFor(ctx.config, 'ipos')
      const statuses = provider === 'nasdaq' ? ['priced', 'upcoming'] : [undefined]
      const results = await Promise.allSettled(statuses.map((status) => get<Row>(ctx, '/equity/calendar/ipo', { start_date: from, end_date: to, status, provider })))
      if (results.every((r) => r.status === 'rejected')) throw new Error(errorText((results[0] as PromiseRejectedResult).reason))
      results.forEach((r, i) => r.status === 'rejected' && ctx.log(`skipped ${statuses[i]} IPOs: ${errorText(r.reason)}`))
      const seen = new Set<string>()
      const out: Row[] = []
      for (const r of results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))) {
        const symbol = str(r.symbol)
        const date = (str(r.ipo_date) ?? str(r.expected_price_date) ?? str(r.date))?.slice(0, 10)
        const key = `${symbol}|${date}`
        if (!date || date < from || date > to || seen.has(key)) continue
        seen.add(key)
        out.push({ symbol, date, name: str(r.name), exchange: str(r.exchange), price: num(r.share_price) ?? num(r.price), offer_amount: num(r.offer_amount), status: str(r.deal_status) ?? str(r.status) })
      }
      out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.symbol).localeCompare(String(b.symbol)))
      return toFrame('ipos', out, meta)
    },

    // GET /nasdaq/markets/movers?category&limit: most_advanced, most_declined, most_active_share_volume (the default; no category means most active, not gainers).
    // change_percent is a fraction; the advanced and declined lists carry no volume and include warrants and sub-dollar names as nasdaq publishes them.
    // min_price (default 5) drops the warrants and sub-dollar trusts that lead nasdaq's raw advanced/declined lists; the
    // provider is asked for more rows than `limit` so the filter still leaves a full table.
    // yfinance (default): GET /equity/screener?preset=day_gainers|day_losers|most_actives&price_min: Yahoo's own lists, real
    // stocks only (500M market-cap floor). nasdaq: /nasdaq/markets/movers, the whole tape, 20 rows, warrants and trusts first.
    movers: async ({ list, limit, min_price }, ctx) => {
      const provider = providerFor(ctx.config, 'movers')
      const rows =
        provider === 'yfinance'
          ? await get<Row>(ctx, '/equity/screener', { preset: YFINANCE_MOVER_PRESETS[list], limit, price_min: min_price, provider })
          : await get<Row>(ctx, `/${provider}/markets/movers`, { category: provider === 'nasdaq' ? NASDAQ_MOVER_CATEGORIES[list] : list, limit: min_price > 0 ? Math.min(limit * 5, 100) : limit, provider })
      const out = rows
        .map((r): Row => ({ symbol: str(r.symbol), name: str(r.name), price: num(r.price) ?? num(r.last_price), change_pct: pct(r.percent_change ?? r.change_percent), volume: num(r.volume) }))
        .filter((r) => r.symbol && (min_price <= 0 || ((r.price as number | null) ?? 0) >= min_price))
        .slice(0, limit)
      if (out.length === 0) throw new Error(`${provider} returned no ${list} list`)
      return toFrame('movers', out, meta)
    },

    // GET /etf/holdings?symbol=X: nasdaq gives the top 10 only (no limit parameter), weight a fraction. An unknown symbol is a 400.
    holdings: async ({ symbol }, ctx) => {
      const provider = providerFor(ctx.config, 'holdings')
      const rows = await get<Row>(ctx, '/etf/holdings', { symbol, provider })
      const out = rows
        .map((r): Row => ({ etf: symbol, symbol: str(r.symbol), name: str(r.name), weight: pct(r.weight) }))
        .filter((r) => r.symbol)
        .sort((a, b) => ((b.weight as number | null) ?? -1) - ((a.weight as number | null) ?? -1))
      if (out.length === 0) throw new Error(`${provider} returned no holdings for ${symbol}`)
      return toFrame('holdings', out, meta)
    },

    // One call per route the requested series need: federal_reserve treasury_rates (month_3 … year_30, one call covers five series),
    // effr, sofr, money_measures (m2 in dollars); oecd cpi (yoy) and unemployment for united_states. Rates are fractions.
    macro: async ({ series, range }, ctx) => {
      const provider = providerFor(ctx.config, 'macro')
      const start_date = rangeStartDate(range, new Date())
      const routes = [...new Set(series.map((s) => MACRO_ROUTES[s]))]
      const fetchers: Record<MacroRoute, () => Promise<Row[]>> = {
        treasury: () => get<Row>(ctx, '/fixedincome/government/treasury_rates', { start_date, provider }),
        effr: () => get<Row>(ctx, '/fixedincome/rate/effr', { start_date, provider }),
        sofr: () => get<Row>(ctx, '/fixedincome/rate/sofr', { start_date, provider }),
        m2: () => get<Row>(ctx, '/economy/money_measures', { start_date, provider }),
        cpi: () => get<Row>(ctx, '/economy/cpi', { country: 'united_states', transform: 'yoy', frequency: 'monthly', start_date, provider: 'oecd' }),
        unemployment: () => get<Row>(ctx, '/economy/unemployment', { country: 'united_states', frequency: 'monthly', start_date, provider: 'oecd' }),
      }
      const results = await Promise.allSettled(routes.map((r) => fetchers[r]()))
      const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${routes[i]}: ${errorText(r.reason)}`] : []))
      if (failures.length === results.length) throw new Error(failures.length === 1 ? failures[0]!.replace(/^[^:]+: /, '') : `openbb: every macro route failed (${failures.join('; ')})`)
      failures.forEach((f) => ctx.log(`skipped ${f}`))
      const data = new Map<MacroRoute, Row[]>(routes.map((r, i) => [r, results[i]!.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<Row[]>).value : []]))
      const out: Row[] = []
      const push = (s: MacroSeries, date: unknown, value: number | null) => {
        const time = parseOpenbbTime(date)
        if (time !== null && value !== null) out.push({ series: s, time, value })
      }
      for (const s of series) {
        const rows = data.get(MACRO_ROUTES[s]) ?? []
        for (const r of rows) {
          if (s === 'spread_10y_2y') {
            const y10 = num(r.year_10)
            const y2 = num(r.year_2)
            push(s, r.date, y10 !== null && y2 !== null ? Math.round((y10 - y2) * 100 * 1e4) / 1e4 : null)
          } else if (TREASURY_COLUMNS[s]) push(s, r.date, pct(r[TREASURY_COLUMNS[s]!]))
          else if (s === 'fed_funds' || s === 'sofr') push(s, r.date, pct(r.rate))
          else if (s === 'm2') push(s, r.month ?? r.date, num(r.m2))
          else push(s, r.date, pct(r.value))
        }
      }
      out.sort((a, b) => String(a.series).localeCompare(String(b.series)) || (a.time as number) - (b.time as number))
      if (out.length === 0) throw new Error(`${provider} returned no data for ${series.join(', ')} since ${start_date}`)
      return toFrame('macro', out, meta)
    },

    // GET /fixedincome/government/yield_curve[?date]: eleven maturities month_1 … year_30 with maturity_years, rates as fractions. A weekend date answers the prior business day.
    yield_curve: async ({ date }, ctx) => {
      const provider = providerFor(ctx.config, 'yield_curve')
      const rows = await get<Row>(ctx, '/fixedincome/government/yield_curve', { date, provider })
      const out = rows
        .map((r): Row => ({ date: str(r.date)?.slice(0, 10) ?? date ?? null, maturity: maturityLabel(r.maturity), years: num(r.maturity_years), rate: pct(r.rate) }))
        .filter((r) => r.maturity && r.rate !== null)
        .sort((a, b) => ((a.years as number | null) ?? 0) - ((b.years as number | null) ?? 0))
      if (out.length === 0) throw new Error(`${provider} returned no yield curve${date ? ` for ${date}` : ''}`)
      return toFrame('yield_curve', out, meta)
    },
  },
})

/** A symbol table with nothing in it is handed to the next connector; a table missing some symbols is logged and returned. */
function requireRows(rows: Row[], provider: string, what: string, symbols: string[], ctx: { log(msg: string): void }): Row[] {
  if (rows.length === 0) throw new Error(`${provider} returned no ${what} for ${symbols.join(', ')}`)
  const have = new Set(rows.map((r) => String(r.symbol)))
  const missing = symbols.filter((s) => !have.has(s))
  if (missing.length > 0) ctx.log(`${provider}: no ${what} for ${missing.join(', ')}`)
  return rows
}

/** Days from today (New York) to an ISO date, for providers whose chain rows carry no dte. */
function dteFrom(expiration: string): number {
  const t = parseOpenbbTime(expiration)
  return t === null ? 0 : Math.max(0, Math.round((t - Date.now()) / 86_400_000))
}

/** yfinance's debt_to_equity is percent-form (78.4); the catalog column is a ratio (0.78). */
function ratioFromPercent(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1_000) / 100_000
}
