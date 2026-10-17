// Live smoke test against a running `openbb-api`: `pnpm smoke` (OPENBB_URL overrides the base URL). Prints one frame per kind.
import { ConnectorRegistry } from '@terminal/core'
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

const queries = [
  { kind: 'search', params: { q: ['micron', 'sandisk'] } },
  { kind: 'quote', params: { symbols } },
  { kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } },
  { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '5m', range: '1d' } },
  { kind: 'news', params: { symbols, limit: 10 } },
  { kind: 'earnings', params: { symbols, from: plus(-7), to: plus(60) } },
] as const

for (const q of queries) {
  const t0 = performance.now()
  const frame = await registry.run(q)
  console.log(`\n### ${q.kind} ${JSON.stringify(q.params)} (${frame.rows.length} rows, ${Math.round(performance.now() - t0)} ms, ttl ${frame.meta.ttl}ms)`)
  console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('  '))
  for (const row of frame.rows.slice(0, 6)) console.log(JSON.stringify(row))
}
