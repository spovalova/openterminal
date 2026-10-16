// Live smoke test: `FINNHUB_API_KEY=... pnpm smoke`. Hits the real API and prints one frame per kind.
import { ConnectorRegistry } from '@terminal/core'
import finnhub from '../src/index.js'

const apiKey = process.env.FINNHUB_API_KEY
if (!apiKey) {
  console.error('FINNHUB_API_KEY is not set. Get a free key at https://finnhub.io/register and run: FINNHUB_API_KEY=... pnpm smoke')
  process.exit(1)
}

const registry = new ConnectorRegistry({ log: (m) => console.error(m) })
registry.register(finnhub, { apiKey })

const today = new Date()
const plus = (days: number) => new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10)
const symbols = ['AAPL', 'MSFT', 'NVDA']

const queries = [
  { kind: 'quote', params: { symbols } },
  { kind: 'news', params: { symbols, limit: 10 } },
  { kind: 'earnings', params: { symbols, from: plus(-7), to: plus(60) } },
] as const

for (const q of queries) {
  const frame = await registry.run(q)
  console.log(`\n### ${q.kind} (${frame.rows.length} rows, ttl ${frame.meta.ttl}ms)`)
  console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('  '))
  for (const row of frame.rows.slice(0, 10)) console.log(JSON.stringify(row))
}
