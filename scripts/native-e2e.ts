// Every built-in recipe with only the native OpenBB providers (PLAN.md section 19): no OpenBB API, no yahoo, no
// finnhub, so a recipe answers only if a native port can. Live network.
//   pnpm native:e2e [recipe …]
import { ConnectorRegistry, MemoryCache, type Frame } from '@openterminal/core'
import { builtinAnnotations, builtinRecipes } from '@openterminal/core/node'
import openbb from '@openterminal/connector-openbb'
import { createTransformEngine } from '../packages/server/src/transform/index.js'

/** Params per recipe: the shapes the agent sends most. */
const CASES: Record<string, Record<string, unknown>> = {
  search: { q: 'micron' },
  quote: { symbols: ['TSLA', 'AAPL'] },
  ohlcv: { symbols: ['NVDA'], range: '3mo' },
  news: { symbols: ['TSLA'], limit: 5 },
  earnings: { symbols: ['TSLA'], from: '2026-07-01', to: '2026-10-31' },
  profile: { symbols: ['MU'] },
  metrics: { symbols: ['MU'] },
  financials: { symbols: ['RDDT'], period: 'quarter', limit: 4 },
  estimates: { symbols: ['MU'] },
  eps_history: { symbols: ['NVDA'], limit: 8 },
  dividends: { symbols: ['AAPL'] },
  insiders: { symbols: ['MU'] },
  institutions: { symbols: ['MU'] },
  short_interest: { symbols: ['MU'] },
  options: { symbol: 'TSLA' },
  volatility: { symbols: ['TSLA'] },
  calendar: { from: '2026-10-19', to: '2026-10-23' },
  ipos: { from: '2026-10-01', to: '2026-10-31' },
  movers: { list: 'gainers' },
  holdings: { symbol: 'SPY' },
  macro: { series: 'treasury_10y' },
  yield_curve: {},
  index: {},
  screener: { sector: 'technology', mktcap_min: 10_000_000_000 },
}

const log = (m: string) => {
  if (process.env.VERBOSE) console.error(m)
}
const engine = createTransformEngine({ log })
const registry = new ConnectorRegistry({ cache: new MemoryCache(), log, recipes: builtinRecipes(), annotations: builtinAnnotations(), transform: engine })
// 6999: nothing listens there, so even a fallback to the API cannot answer.
registry.register(openbb, { native: 'only', baseUrl: 'http://127.0.0.1:6999' })

const only = process.argv.slice(2)
const names = builtinRecipes().map((r) => r.name).filter((n) => only.length === 0 || only.includes(n))
let failed = 0
for (const name of names) {
  const params = CASES[name]
  if (!params) {
    console.log(`?  ${name.padEnd(15)} no params in CASES`)
    failed++
    continue
  }
  const t = Date.now()
  try {
    const frame: Frame = await registry.run({ recipe: name, params })
    const lineage = frame.meta.lineage as { route?: string; provider?: string; inputs?: Record<string, { route?: string; provider?: string }> } | undefined
    const sources = new Set<string>()
    const collect = (l: typeof lineage) => {
      if (!l) return
      if (l.route) sources.add(`${l.route}${l.provider ? ` (${l.provider})` : ''}`)
      for (const i of Object.values(l.inputs ?? {})) collect(i)
    }
    collect(lineage)
    const ok = frame.rows.length > 0
    if (!ok) failed++
    console.log(`${ok ? '✓' : '✗'}  ${name.padEnd(15)} ${String(frame.rows.length).padStart(5)} rows  ${((Date.now() - t) / 1000).toFixed(1).padStart(5)}s  ${[...sources].join(', ')}`)
  } catch (err) {
    failed++
    console.log(`✗  ${name.padEnd(15)} ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 160)}`)
  }
}
console.log(`\n${names.length - failed} of ${names.length} recipes answered natively`)
await engine.close?.()
process.exit(failed ? 1 : 0)
