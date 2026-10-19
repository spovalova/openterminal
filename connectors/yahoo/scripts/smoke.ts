// Live smoke: one frame per yahoo-finance2 route through a core ConnectorRegistry (MU, NVDA, SPY, SMH). Not a test.
// From connectors/yahoo: pnpm smoke
import { ConnectorRegistry, MemoryCache, type Frame, type RouteQuery } from '@openterminal/core'
import { builtinAnnotations } from '@openterminal/core/node'
import yahoo from '../src/index.js'

const registry = new ConnectorRegistry({ cache: new MemoryCache(), log: (m) => console.error(m), annotations: builtinAnnotations() })
registry.register(yahoo, {})

const monthsAgo = (n: number) => new Date(Date.now() - n * 30 * 86_400_000).toISOString().slice(0, 10)
const q = (route: string, params: Record<string, unknown>): RouteQuery => ({ connector: 'yahoo', route, params })
const queries: RouteQuery[] = [
  q('search', { q: 'micron' }),
  q('quote', { symbols: ['MU', 'NVDA', 'SPY'] }),
  q('chart', { symbol: ['MU', 'NVDA', 'SPY'], period1: monthsAgo(3), interval: '1d', includePrePost: false }),
  q('chart', { symbol: 'AAPL', period1: monthsAgo(60), interval: '1mo', events: 'div', includePrePost: false }),
  q('quoteSummary', { symbol: ['MU', 'NVDA'], modules: ['calendarEvents'] }),
  q('quoteSummary', { symbol: ['MU', 'NVDA', 'SMH'], modules: ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics'] }),
  q('quoteSummary', { symbol: ['MU', 'NVDA'], modules: ['financialData', 'earningsTrend'] }),
  q('quoteSummary', { symbol: 'MU', modules: ['earningsHistory', 'insiderTransactions', 'institutionOwnership'] }),
  q('quoteSummary', { symbol: 'SMH', modules: ['topHoldings'] }),
  q('options', { symbol: 'MU' }),
]

function print(query: RouteQuery, frame: Frame, ms: number) {
  console.log(`\n## ${query.route} ${JSON.stringify(query.params)} -> ${frame.rows.length} rows from ${frame.meta.connector} in ${ms}ms (ttl ${frame.meta.ttl}ms)`)
  console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('\t'))
  const shown = frame.rows.length > 8 ? [...frame.rows.slice(0, 4), null, ...frame.rows.slice(-4)] : frame.rows
  for (const row of shown) console.log(row ? row.map((v) => (v instanceof Date ? v.toISOString() : String(v))).join('\t') : '…')
}

let failed = false
for (const query of queries) {
  const t0 = Date.now()
  try {
    print(query, await registry.run(query), Date.now() - t0)
  } catch (err) {
    failed = true
    console.error(`\n## ${query.route} FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}
process.exit(failed ? 1 : 0)
