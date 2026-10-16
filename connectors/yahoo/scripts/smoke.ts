// Live smoke: one frame per kind for MU, NVDA, SPY through a core ConnectorRegistry. Not a test.
// From connectors/yahoo: pnpm smoke
import { ConnectorRegistry, MemoryCache, type Frame, type QueryInput } from '@terminal/core'
import yahoo from '../src/index.js'

const registry = new ConnectorRegistry({ cache: new MemoryCache(), log: (m) => console.error(m) })
registry.register(yahoo, {})

const today = new Date().toISOString().slice(0, 10)
const inSixMonths = new Date(Date.now() + 183 * 86_400_000).toISOString().slice(0, 10)
const queries: QueryInput[] = [
  { kind: 'search', params: { q: ['micron', 'nvidia', 'spdr s&p 500'] } },
  { kind: 'quote', params: { symbols: ['MU', 'NVDA', 'SPY'] } },
  { kind: 'ohlcv', params: { symbols: ['MU', 'NVDA', 'SPY'], interval: '5m', range: '1d' } },
  { kind: 'earnings', params: { symbols: ['MU', 'NVDA', 'SPY'], from: today, to: inSixMonths } },
]

function print(q: QueryInput, frame: Frame, ms: number) {
  console.log(`\n## ${q.kind} ${JSON.stringify(q.params)} -> ${frame.rows.length} rows from ${frame.meta.connector} in ${ms}ms (ttl ${frame.meta.ttl}ms)`)
  console.log(frame.columns.map((c) => `${c.name}:${c.type}`).join('\t'))
  const shown = frame.rows.length > 8 ? [...frame.rows.slice(0, 4), null, ...frame.rows.slice(-4)] : frame.rows
  for (const row of shown) console.log(row ? row.map((v) => (v instanceof Date ? v.toISOString() : String(v))).join('\t') : '…')
}

let failed = false
for (const q of queries) {
  const t0 = Date.now()
  try {
    print(q, await registry.run(q), Date.now() - t0)
  } catch (err) {
    failed = true
    console.error(`\n## ${q.kind} FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}
process.exit(failed ? 1 : 0)
