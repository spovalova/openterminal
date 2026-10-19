// Live smoke test against a running `openbb-api`: `pnpm smoke` (OPENBB_URL overrides the base URL). Prints one frame
// per route the built-in recipes name, with row counts and timings. `pnpm smoke equity/price/quote` runs only that
// route. Not a test: `pnpm test` replays fixtures.
import { ConnectorRegistry, type RouteQuery } from '@openterminal/core'
import { builtinAnnotations } from '@openterminal/core/node'
import openbb from '../src/index.js'

const baseUrl = process.env.OPENBB_URL ?? 'http://127.0.0.1:6900'
const registry = new ConnectorRegistry({ log: (m) => console.error(m), annotations: builtinAnnotations() })
registry.register(openbb, { baseUrl })

const health = await registry.health('openbb')
if (!health.ok) {
  console.error(health.error)
  process.exit(1)
}
console.error(health.detail)

const today = new Date()
const plus = (days: number) => new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10)
const symbols = ['MU', 'SNDK', 'NVDA']
const q = (route: string, params: Record<string, unknown>): RouteQuery => ({ connector: 'openbb', route, params })

const queries: RouteQuery[] = [
  q('equity/search', { query: 'micron', provider: 'nasdaq' }),
  q('equity/price/quote', { symbol: symbols, provider: 'yfinance' }),
  q('equity/price/historical', { symbol: symbols, start_date: plus(-90), interval: '1d', provider: 'yfinance' }),
  q('news/company', { symbol: symbols, limit: 10, provider: 'nasdaq' }),
  q('equity/calendar/earnings', { start_date: plus(-7), end_date: plus(60), provider: 'nasdaq' }),
  q('equity/profile', { symbol: symbols, provider: 'yfinance' }),
  q('equity/fundamental/metrics', { symbol: ['MU', 'AAPL'], provider: 'yfinance' }),
  q('equity/fundamental/income', { symbol: 'MU', period: 'quarter', limit: 4, provider: 'yfinance' }),
  q('equity/estimates/consensus', { symbol: ['MU', 'AAPL'], provider: 'yfinance' }),
  q('yfinance/estimates/earnings', { symbol: ['MU', 'AAPL'] }),
  q('equity/fundamental/historical_eps', { symbol: ['MU', 'AAPL'], limit: 4, provider: 'yfinance' }),
  q('equity/fundamental/dividends', { symbol: 'AAPL', provider: 'yfinance' }),
  q('equity/ownership/insider_trading', { symbol: 'MU', limit: 8, provider: 'sec' }),
  q('equity/ownership/institutional', { symbol: 'MU', limit: 5, provider: 'nasdaq' }),
  q('equity/shorts/short_interest', { symbol: ['MU', 'AAPL'], provider: 'finra' }),
  q('derivatives/options/chains', { symbol: 'MU', provider: 'cboe' }),
  q('equity/price/quote', { symbol: ['MU', 'NVDA', 'SPY'], provider: 'cboe' }),
  q('economy/calendar', { start_date: plus(0), end_date: plus(7), country: 'united_states', provider: 'nasdaq' }),
  q('equity/calendar/ipo', { start_date: plus(-30), end_date: plus(30), provider: 'nasdaq' }),
  q('equity/screener', { preset: 'day_gainers', limit: 5, price_min: 5, provider: 'yfinance' }),
  q('etf/holdings', { symbol: 'SMH', provider: 'nasdaq' }),
  q('fixedincome/government/treasury_rates', { start_date: plus(-180), provider: 'federal_reserve' }),
  q('fixedincome/government/yield_curve', { provider: 'federal_reserve' }),
]

const only = new Set(process.argv.slice(2))
const summary: string[] = []
for (const query of queries) {
  if (only.size > 0 && !only.has(query.route)) continue
  const t0 = performance.now()
  try {
    const frame = await registry.run(query)
    const ms = Math.round(performance.now() - t0)
    summary.push(`${query.route.padEnd(40)} ${String(frame.rows.length).padStart(5)} rows ${String(ms).padStart(6)} ms  ${JSON.stringify(query.params)}`)
    console.log(`\n### ${query.route} ${JSON.stringify(query.params)} (${frame.rows.length} rows, ${ms} ms, ttl ${frame.meta.ttl}ms)`)
    console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('  '))
    for (const row of frame.rows.slice(0, 6)) console.log(JSON.stringify(row))
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    summary.push(`${query.route.padEnd(40)}  FAIL      ${String(ms).padStart(6)} ms  ${err instanceof Error ? err.message : String(err)}`)
    console.log(`\n### ${query.route} ${JSON.stringify(query.params)} FAILED after ${ms} ms: ${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log('\n### summary')
for (const line of summary) console.log(line)
