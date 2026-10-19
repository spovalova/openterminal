// Live smoke test: `FINNHUB_API_KEY=... pnpm smoke`. Hits the real API and prints one frame per route.
import { ConnectorRegistry, type RouteQuery } from '@terminal/core'
import { builtinAnnotations } from '@terminal/core/node'
import finnhub from '../src/index.js'

const apiKey = process.env.FINNHUB_API_KEY
if (!apiKey) {
  console.error('FINNHUB_API_KEY is not set. Get a free key at https://finnhub.io/register and run: FINNHUB_API_KEY=... pnpm smoke')
  process.exit(1)
}

const registry = new ConnectorRegistry({ log: (m) => console.error(m), annotations: builtinAnnotations() })
registry.register(finnhub, { apiKey })

const today = new Date()
const plus = (days: number) => new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10)

const queries: RouteQuery[] = [
  { connector: 'finnhub', route: 'quote', params: { symbol: 'AAPL' } },
  { connector: 'finnhub', route: 'company-news', params: { symbol: 'NVDA', from: plus(-7), to: plus(0) } },
  { connector: 'finnhub', route: 'calendar/earnings', params: { from: plus(-7), to: plus(60), symbol: 'MSFT' } },
]

for (const q of queries) {
  const frame = await registry.run(q)
  console.log(`\n### ${q.route} ${JSON.stringify(q.params)} (${frame.rows.length} rows, ttl ${frame.meta.ttl}ms)`)
  console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('  '))
  for (const row of frame.rows.slice(0, 10)) console.log(JSON.stringify(row))
}
