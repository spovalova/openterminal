// Time the transform engine: cold start by phase, then warm runs of the P/E worked example over two years of daily
// bars and of a 100k-row window computation. Run from the repo root: pnpm exec tsx packages/server/scripts/bench-transform.ts
import { TRANSFORM_EXAMPLE, isTransformError, nyMidnight, tradingDays, type Frame } from '@openterminal/core'
import { createTransformEngine } from '../src/transform/index.js'

const engine = createTransformEngine({ log: (m) => console.error(`[engine] ${m}`) })

function bars(symbols: string[], start: string, end: string): Frame {
  const days = tradingDays(start, end)
  const rows: unknown[][] = []
  symbols.forEach((s, si) => days.forEach((d, i) => rows.push([s, nyMidnight(d) + 16 * 3_600_000, 100 + si + i * 0.1, 101, 99, 100 + si + i * 0.1, 1000])))
  return {
    columns: ['symbol', 'time', 'open', 'high', 'low', 'close', 'volume'].map((name) => ({ name, type: name === 'symbol' ? 'string' : name === 'time' ? 'time' : 'number' })),
    rows,
    meta: { connector: 'bench', fetchedAt: Date.now(), ttl: 0 },
  }
}

const eps: Frame = {
  columns: [
    { name: 'symbol', type: 'string' },
    { name: 'date', type: 'time' },
    { name: 'eps_actual', type: 'number' },
  ],
  rows: ['2024-02-21', '2024-05-22', '2024-08-28', '2024-11-20', '2025-02-26', '2025-05-28', '2025-08-27', '2025-11-19'].map((d, i) => ['NVDA', nyMidnight(d), 0.5 + i * 0.1]),
  meta: { connector: 'bench', fetchedAt: Date.now(), ttl: 0 },
}

async function timed(label: string, inputs: Record<string, Frame>, code: string) {
  const t0 = performance.now()
  const out = await engine.run(inputs, code)
  const ms = Math.round(performance.now() - t0)
  if (isTransformError(out)) throw new Error(`${label}: ${out.error}\n${out.traceback ?? ''}`)
  const inRows = Object.values(inputs).reduce((n, f) => n + f.rows.length, 0)
  console.log(`${label}: ${ms} ms end to end (python ${engine.stats().lastRun?.python} ms), ${inRows.toLocaleString()} rows in, ${out.rows.length.toLocaleString()} out`)
}

const t0 = performance.now()
await engine.warmup()
const s = engine.stats()
console.log(`cold start: ${Math.round(performance.now() - t0)} ms (pyodide ${s.coldStart?.pyodide}, wheels ${s.coldStart?.packages}, imports ${s.coldStart?.imports}); wasm heap ${s.heapMb} MB; rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`)

const price = bars(['NVDA'], '2024-01-02', '2025-12-31')
await timed('P/E example, first run', { price, eps }, TRANSFORM_EXAMPLE.code)
await timed('P/E example, second run', { price, eps }, TRANSFORM_EXAMPLE.code)
const twenty = bars(Array.from({ length: 20 }, (_, i) => `S${i}`), '2006-01-02', '2025-12-31')
await timed('20 symbols × 20 years, rsi + ema + returns', { df: twenty }, 'r = ot.rsi(df)\nr["ema_20"] = ot.ema(df, 20)["ema_20"]\nr["ret"] = ot.returns(df)["ret"]\nresult = r.tail(50_000)')
await timed('20 symbols, correlation matrix', { df: twenty }, 'result = ot.corr(df)')
console.log(`wasm heap after: ${engine.stats().heapMb} MB; rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`)
await engine.close()
