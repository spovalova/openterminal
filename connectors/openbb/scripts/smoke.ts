// Live smoke test against a running `openbb-api`: `pnpm smoke` (OPENBB_URL overrides the base URL). Prints one frame per kind,
// the v1 five and the seventeen v1.2 kinds, with row counts and timings. `pnpm smoke options macro` runs only those kinds.
import { ConnectorRegistry, type QueryInput } from '@terminal/core'
import openbb from '../src/index.js'

const baseUrl = process.env.OPENBB_URL ?? 'http://127.0.0.1:6900'
const registry = new ConnectorRegistry({ log: (m) => console.error(m) })
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

const queries: QueryInput[] = [
  // v1
  { kind: 'search', params: { q: ['micron', 'sandisk'] } },
  { kind: 'quote', params: { symbols } },
  { kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } },
  { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '5m', range: '1d' } },
  { kind: 'news', params: { symbols, limit: 10 } },
  { kind: 'earnings', params: { symbols, from: plus(-7), to: plus(60) } },
  // v1.2: company
  { kind: 'profile', params: { symbols } },
  { kind: 'metrics', params: { symbols: ['MU', 'AAPL'] } },
  { kind: 'financials', params: { symbols: ['MU'], period: 'quarter', limit: 4 } },
  { kind: 'estimates', params: { symbols: ['MU', 'AAPL'] } },
  { kind: 'eps_history', params: { symbols: ['MU', 'AAPL'], limit: 4 } },
  { kind: 'dividends', params: { symbols: ['AAPL', 'MU'], limit: 4 } },
  // v1.2: ownership and positioning
  { kind: 'insiders', params: { symbols: ['MU'], limit: 8 } },
  { kind: 'institutions', params: { symbols: ['MU'], limit: 5 } },
  { kind: 'short_interest', params: { symbols: ['MU', 'AAPL'], limit: 3 } },
  // v1.2: options and volatility
  { kind: 'options', params: { symbol: 'MU', strikes: 3, type: 'both' } },
  { kind: 'options', params: { symbol: 'AAPL', expiration: plus(40), strikes: 2, type: 'call' } },
  { kind: 'volatility', params: { symbols: ['MU', 'NVDA', 'SPY'] } },
  // v1.2: market-wide
  { kind: 'calendar', params: { from: plus(0), to: plus(7), country: 'United States' } },
  { kind: 'ipos', params: { from: plus(-30), to: plus(30) } },
  { kind: 'movers', params: { list: 'gainers', limit: 5 } },
  { kind: 'movers', params: { list: 'active', limit: 5 } },
  { kind: 'holdings', params: { symbol: 'SMH' } },
  { kind: 'macro', params: { series: ['treasury_10y', 'spread_10y_2y', 'fed_funds', 'cpi_yoy', 'unemployment', 'm2'], range: '6mo' } },
  { kind: 'yield_curve', params: {} },
]

const only = new Set(process.argv.slice(2))
const summary: string[] = []
for (const q of queries) {
  if (only.size > 0 && !only.has(q.kind)) continue
  const t0 = performance.now()
  try {
    const frame = await registry.run(q)
    const ms = Math.round(performance.now() - t0)
    summary.push(`${q.kind.padEnd(15)} ${String(frame.rows.length).padStart(5)} rows ${String(ms).padStart(6)} ms  ${JSON.stringify(q.params)}`)
    console.log(`\n### ${q.kind} ${JSON.stringify(q.params)} (${frame.rows.length} rows, ${ms} ms, ttl ${frame.meta.ttl}ms)`)
    console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('  '))
    for (const row of frame.rows.slice(0, 6)) console.log(JSON.stringify(row))
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    summary.push(`${q.kind.padEnd(15)}  FAIL      ${String(ms).padStart(6)} ms  ${err instanceof Error ? err.message : String(err)}`)
    console.log(`\n### ${q.kind} ${JSON.stringify(q.params)} FAILED after ${ms} ms: ${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(`\n### summary\n${summary.join('\n')}`)
