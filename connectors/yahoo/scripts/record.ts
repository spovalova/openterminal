// Records raw yahoo-finance2 responses as JSON fixtures for the Vitest suite. Live network; run once.
// From connectors/yahoo: pnpm exec tsx scripts/record.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createYahooClient } from '../src/client.js'
import { rangeToPeriod } from '../src/time.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
mkdirSync(dir, { recursive: true })
const yf = createYahooClient()
const now = new Date()

function save(name: string, data: unknown) {
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log(`wrote ${file}`)
}

// Keep intraday fixtures small: first 10 and last 10 bars (the tail carries the live partial bar).
function slice<T extends { quotes: unknown[] }>(r: T, keep = 20): T {
  const q = r.quotes
  if (q.length <= keep) return r
  const half = Math.floor(keep / 2)
  return { ...r, quotes: [...q.slice(0, half), ...q.slice(-half)] }
}

const search: Record<string, unknown> = {}
for (const term of ['micron', 'sandisk', 'SPY', 'zqxv-no-such-company']) {
  search[term] = await yf.search(term, { quotesCount: 10, newsCount: 0 })
}
save('search', { recordedAt: now.toISOString(), byTerm: search })

save('quote', { recordedAt: now.toISOString(), symbols: ['MU', 'NVDA', 'SPY'], result: await yf.quote(['MU', 'NVDA', 'SPY']) })

const charts: Record<string, unknown> = {}
const specs = [
  { key: 'MU-5m-1d', symbol: 'MU', interval: '5m', range: '1d' },
  { key: 'NVDA-5m-1d', symbol: 'NVDA', interval: '5m', range: '1d' },
  { key: 'MU-1d-3mo', symbol: 'MU', interval: '1d', range: '3mo' },
  { key: 'MU-1wk-6mo', symbol: 'MU', interval: '1wk', range: '6mo' },
] as const
for (const s of specs) {
  const { period1, period2 } = rangeToPeriod(s.range, now)
  const r = await yf.chart(s.symbol, { period1, period2, interval: s.interval, includePrePost: false })
  const meta: Record<string, unknown> = { ...r.meta }
  delete meta.currentTradingPeriod // bulky and irrelevant to the mapping
  delete meta.tradingPeriods
  charts[s.key] = { request: { symbol: s.symbol, interval: s.interval, period1, period2 }, count: r.quotes.length, ...slice({ meta, quotes: r.quotes }) }
}
save('chart', { recordedAt: now.toISOString(), byKey: charts })

const summaries: Record<string, unknown> = {}
for (const symbol of ['MU', 'NVDA', 'SPY']) {
  try {
    summaries[symbol] = await yf.quoteSummary(symbol, { modules: ['calendarEvents'] })
  } catch (err) {
    summaries[symbol] = { error: String(err) }
  }
}
save('quoteSummary', { recordedAt: now.toISOString(), bySymbol: summaries })
