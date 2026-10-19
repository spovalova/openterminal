// The transform engine end to end on one warm Pyodide worker: frame conversion, the P/E worked example, every
// `ot` helper against a hand-computed value, the guards (imports, timeout, kill, output cap) and the calendar
// parity with clock.ts. One worker is booted for the file; its cold start and a warm run are printed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConnectorRegistry,
  MemoryCache,
  defineConnector,
  toFrame,
  NYSE_EARLY_CLOSES,
  NYSE_HOLIDAYS,
  OT_HELPERS,
  TRANSFORM_EXAMPLE,
  TRANSFORM_LIMITS,
  TransformFailed,
  frameToObjects,
  isTransformError,
  lastTradingDay,
  lastWeek,
  nyMidnight,
  prevClose,
  tradingDays,
  type AnyQueryInput,
  type Frame,
  type TransformOutput,
} from '@terminal/core'
import { z } from 'zod'
import { createTransformEngine, fromColumnar, toColumnar, vendoredWheels, type ServerTransformEngine } from '../src/transform/index.js'

const BOOT_MS = 180_000
const RUN_MS = 60_000

// A fixed "now": Wednesday 2026-10-14 14:00 ET (18:00 UTC), regular session.
const NOW = Date.UTC(2026, 9, 14, 18, 0, 0)

let engine: ServerTransformEngine
const logs: string[] = []
/** A run issued while the worker was still booting (the server's first `transform` call on a cold start). */
let early: Promise<TransformOutput>
let bootsAfterEarly = 0

beforeAll(async () => {
  engine = createTransformEngine({ log: (m) => logs.push(m), now: () => NOW, interruptGraceMs: 800 })
  const t0 = Date.now()
  // The server starts warmup in the background after listen and does not await it; a prompt that reaches `transform`
  // before the worker is ready must wait for the same worker, not fail and not boot a second one.
  const warm = engine.warmup()
  const x: Frame = { columns: [{ name: 'a', type: 'number' }], rows: [[1], [2], [3]], meta: { connector: 'fixture', fetchedAt: NOW, ttl: 0 } }
  early = engine.run({ x }, 'result = x[["a"]]')
  await warm
  const s = engine.stats()
  console.log(`[transform] cold start ${Date.now() - t0} ms (pyodide ${s.coldStart?.pyodide}, packages ${s.coldStart?.packages}, imports ${s.coldStart?.imports}); heap ${s.heapMb} MB`)
  await early
  bootsAfterEarly = engine.stats().boots
}, BOOT_MS)

afterAll(async () => {
  await engine?.close()
})

// ---------- fixtures ----------

function frame(columns: { name: string; type: 'string' | 'number' | 'time' | 'boolean' }[], rows: unknown[][], meta: Partial<Frame['meta']> = {}): Frame {
  return { columns, rows, meta: { connector: 'fixture', fetchedAt: NOW, ttl: 60_000, ...meta } }
}

/** Daily closes for one or more symbols over the trading days of a range, deterministic. */
function priceFrame(symbols: string[], start: string, end: string, close: (i: number, s: number) => number): Frame {
  const days = tradingDays(start, end)
  const rows: unknown[][] = []
  symbols.forEach((sym, si) => {
    days.forEach((d, i) => {
      const c = close(i, si)
      rows.push([sym, nyMidnight(d) + 16 * 3_600_000, c - 0.5, c + 1, c - 1, c, 1000 + i])
    })
  })
  return frame(
    [
      { name: 'symbol', type: 'string' },
      { name: 'time', type: 'time' },
      { name: 'open', type: 'number' },
      { name: 'high', type: 'number' },
      { name: 'low', type: 'number' },
      { name: 'close', type: 'number' },
      { name: 'volume', type: 'number' },
    ],
    rows,
    { fields: { close: { unit: 'usd' } } },
  )
}

/** Quarterly EPS rows as a v2 route frame carries them (`date` typed time), newest first like the provider. */
const EPS_ROWS: [string, number, number][] = [
  ['2025-11-19', 1.3, 1.25],
  ['2025-08-27', 1.05, 1.01],
  ['2025-05-28', 0.81, 0.75],
  ['2025-02-26', 0.89, 0.85],
  ['2024-11-20', 0.81, 0.75],
  ['2024-08-28', 0.68, 0.64],
  ['2024-05-22', 0.61, 0.56],
  ['2024-02-21', 0.52, 0.46],
]
const epsFrame = frame(
  [
    { name: 'symbol', type: 'string' },
    { name: 'date', type: 'time' },
    { name: 'eps_actual', type: 'number' },
    { name: 'eps_estimated', type: 'number' },
  ],
  EPS_ROWS.map(([d, a, e]) => ['NVDA', nyMidnight(d), a, e]),
)

/** A v1 connector answering ohlcv (three daily bars from 2025-10-01) and eps_history (four quarters) from memory. */
function kindConnector() {
  return defineConnector({
    name: 'fake',
    config: z.object({}),
    queries: {
      ohlcv: async (p) =>
        toFrame(
          'ohlcv',
          p.symbols.flatMap((symbol) => tradingDays('2025-10-01', '2025-10-03').map((d, i) => ({ symbol, time: nyMidnight(d) + 16 * 3_600_000, open: 10, high: 11, low: 9, close: 100 + i, volume: 100 }))),
        ),
      eps_history: async (p) => toFrame('eps_history', p.symbols.flatMap((symbol) => EPS_ROWS.slice(0, p.limit).map(([date, eps_actual, eps_estimate]) => ({ symbol, date, eps_actual, eps_estimate, surprise_pct: 5 })))),
    },
  })
}

function objects(out: Awaited<ReturnType<ServerTransformEngine['run']>>): Record<string, unknown>[] {
  if (isTransformError(out)) throw new Error(`${out.error}\n${out.traceback ?? ''}`)
  return frameToObjects(out)
}

async function py(code: string, inputs: Record<string, Frame> = { df: priceFrame(['A'], '2026-01-02', '2026-01-09', (i) => 100 + i) }) {
  return engine.run(inputs, code)
}

// ---------- vendoring ----------

describe('cold start', () => {
  it('a run issued during warm-up waits for the worker instead of failing, on the one worker (the server does not await warmup)', async () => {
    const out = await early
    expect(isTransformError(out)).toBe(false)
    if (isTransformError(out)) throw new Error(out.error)
    expect(out.rows).toEqual([[1], [2], [3]])
    expect(bootsAfterEarly).toBe(1)
    expect(logs.some((l) => /transform worker ready in \d+ ms/.test(l))).toBe(true)
  })
})

describe('vendored wheels', () => {
  it('every wheel the lock file needs for pandas, scipy and tzdata is on disk', () => {
    const wheels = vendoredWheels()
    expect(wheels.map((w) => w.file.split('-')[0]).sort()).toEqual(['numpy', 'pandas', 'python_dateutil', 'pytz', 'scipy', 'six', 'tzdata'])
    expect(wheels.filter((w) => !w.present)).toEqual([])
  })
})

// ---------- the worked example ----------

describe('P/E worked example', () => {
  it(
    'runs TRANSFORM_EXAMPLE.code verbatim over fixture frames and one value matches a hand recomputation',
    async () => {
      const price = priceFrame(['NVDA'], '2025-10-01', '2025-12-31', (i) => 180 + i * 0.25)
      const t0 = Date.now()
      const out = await engine.run({ price, eps: epsFrame }, TRANSFORM_EXAMPLE.code, { ...TRANSFORM_EXAMPLE.columns })
      console.log(`[transform] warm run (P/E example, ${price.rows.length} + ${epsFrame.rows.length} rows) ${Date.now() - t0} ms; python ${engine.stats().lastRun?.python} ms`)
      const rows = objects(out)
      const f = out as Frame
      expect(f.columns).toEqual([
        { name: 'symbol', type: 'string' },
        { name: 'time', type: 'time' },
        { name: 'close', type: 'number' },
        { name: 'eps_ttm', type: 'number' },
        { name: 'pe', type: 'number' },
      ])
      expect(f.meta.fields).toEqual(TRANSFORM_EXAMPLE.columns)
      // By hand: on 2025-12-01 the last four reports are 2025-11-19, 08-27, 05-28, 02-26 → TTM = 1.3 + 1.05 + 0.81 + 0.89 = 4.05.
      // October 2025 has 23 sessions and November 19 (Thanksgiving closed), so 2025-12-01 is i = 42:
      // close = 180 + 42 × 0.25 = 190.5; P/E = 190.5 / 4.05 = 47.037…
      const days = tradingDays('2025-10-01', '2025-12-31')
      const i = days.indexOf('2025-12-01')
      expect(i).toBe(42)
      const row = rows.find((r) => r.time === nyMidnight('2025-12-01') + 16 * 3_600_000)!
      expect(row.close).toBe(190.5)
      expect(row.eps_ttm).toBeCloseTo(4.05, 10)
      expect(row.pe).toBeCloseTo(190.5 / 4.05, 10)
      expect(row.pe).toBeCloseTo(47.037, 3)
      // Before 2025-11-19 the TTM is the previous four: 1.05 + 0.81 + 0.89 + 0.81 = 3.56.
      const before = rows.find((r) => r.time === nyMidnight('2025-11-18') + 16 * 3_600_000)!
      expect(before.eps_ttm).toBeCloseTo(3.56, 10)
      // Every trading day in the price frame has a row (the first report is 2024-02-21, well before the range).
      expect(rows.length).toBe(days.length)
      expect(rows.every((r) => typeof r.time === 'number' && (r.pe as number) > 0)).toBe(true)
    },
    RUN_MS,
  )

  it(
    'runs through the registry over v1 kind queries and stamps lineage, fields and ttl',
    async () => {
      const registry = new ConnectorRegistry({ cache: new MemoryCache(), transform: engine, now: () => NOW })
      registry.register(kindConnector(), {})
      // The v1 eps_history has `date` as a string; ot.to_et turns it into the tz-aware time merge_asof needs.
      const code = [
        'e = eps.assign(time=ot.to_et(eps.date)).sort_values("time")',
        'e["eps_ttm"] = e.groupby("symbol")["eps_actual"].transform(lambda s: s.rolling(4).sum())',
        'e = e.dropna(subset=["eps_ttm"])',
        'p = price.sort_values("time")',
        'm = pd.merge_asof(p, e[["symbol", "time", "eps_ttm"]], on="time", by="symbol")',
        'm["pe"] = m.close / m.eps_ttm',
        'result = m[["symbol", "time", "close", "eps_ttm", "pe"]]',
      ].join('\n')
      const frame = await registry.run({
        inputs: { price: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '1mo' } }, eps: { kind: 'eps_history', params: { symbols: ['NVDA'], limit: 4 } } },
        code,
        columns: { pe: { unit: 'ratio', label: 'P/E (TTM)' } },
      })
      expect(frame.meta.connector).toBe('transform')
      expect(frame.meta.lineage?.code).toBe(code)
      expect(Object.keys(frame.meta.lineage?.inputs ?? {})).toEqual(['price', 'eps'])
      expect(frame.meta.fields?.pe).toEqual({ unit: 'ratio', label: 'P/E (TTM)' })
      expect(frame.meta.ttl).toBeGreaterThan(0)
      const rows = frameToObjects(frame)
      expect(rows.length).toBe(3)
      // limit 4 → the four newest reports, whose first complete TTM window is 2025-11-19, after the bars → no match → null.
      expect(rows.map((r) => r.pe)).toEqual([null, null, null])
      // With eight reports the TTM as of 2025-10-01 is the four reported by then: 1.05 + 0.81 + 0.89 + 0.81 = 3.56; close 100.
      const eight = await registry.run({
        inputs: { price: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '1mo' } }, eps: { kind: 'eps_history', params: { symbols: ['NVDA'], limit: 8 } } },
        code,
      })
      expect(frameToObjects(eight)[0]!.pe).toBeCloseTo(100 / 3.56, 10)
    },
    RUN_MS,
  )

  it(
    'a traceback comes back through the registry as TransformFailed with the traceback attached',
    async () => {
      const registry = new ConnectorRegistry({ cache: new MemoryCache(), transform: engine, now: () => NOW })
      registry.register(kindConnector(), {})
      const q: AnyQueryInput = { inputs: { price: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '1mo' } } }, code: 'result = price[["nope"]]' }
      const err = await registry.run(q).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TransformFailed)
      expect((err as TransformFailed).message).toMatch(/KeyError/)
      expect((err as TransformFailed).traceback).toMatch(/<transform>", line 1/)
    },
    RUN_MS,
  )
})

// ---------- frame ↔ DataFrame ----------

describe('frame ↔ DataFrame', () => {
  it('toColumnar and fromColumnar round-trip a frame and turn NaN into null', () => {
    const f = frame([{ name: 'a', type: 'number' }, { name: 's', type: 'string' }], [[1, 'x'], [Number.NaN, null], [3, 'z']])
    const c = toColumnar({ f })
    expect(c.f!.data).toEqual({ a: [1, null, 3], s: ['x', null, 'z'] })
    const back = fromColumnar(c.f!, NOW)
    expect(back.rows).toEqual([[1, 'x'], [null, null], [3, 'z']])
    expect(back.columns).toEqual(f.columns)
  })

  it(
    'time columns arrive as tz-aware America/New_York datetimes and go back to epoch ms; types map per the contract',
    async () => {
      const f = frame(
        [
          { name: 'time', type: 'time' },
          { name: 'n', type: 'number' },
          { name: 'b', type: 'boolean' },
          { name: 's', type: 'string' },
        ],
        [
          [nyMidnight('2026-03-09') + 9.5 * 3_600_000, 1.5, true, 'a'],
          [nyMidnight('2026-11-02'), null, null, null],
          [null, 3, false, 'c'],
        ],
      )
      const out = await py(
        [
          'info = {',
          '  "dtype": str(df.time.dtype), "tz": str(df.time.dt.tz), "first": df.time.iloc[0].isoformat(),',
          '  "n": str(df.n.dtype), "b": str(df.b.dtype), "s": str(df.s.dtype),',
          '  "n_null": bool(df.n.isna().iloc[1]), "b_null": bool(df.b.isna().iloc[1]), "s_null": bool(df.s.isna().iloc[1]), "t_null": bool(df.time.isna().iloc[2]),',
          '}',
          'result = pd.DataFrame([info])',
        ].join('\n'),
        { df: f },
      )
      const [row] = objects(out)
      expect(row).toMatchObject({ dtype: 'datetime64[ns, America/New_York]', tz: 'America/New_York', first: '2026-03-09T09:30:00-04:00', n: 'float64', b: 'boolean', s: 'str' })
      expect(row).toMatchObject({ n_null: true, b_null: true, s_null: true, t_null: true })
      // The same frame back out, untouched, is the same frame.
      const back = await py('result = df', { df: f })
      expect((back as Frame).columns).toEqual(f.columns)
      expect((back as Frame).rows).toEqual(f.rows)
    },
    RUN_MS,
  )

  it(
    'result columns map: naive datetimes are New York wall time, dates too, ints stay ints, inf and NaN become null, bools and strings keep their type',
    async () => {
      const out = await py(
        [
          'import datetime',
          'result = pd.DataFrame({',
          '  "naive": pd.to_datetime(["2026-01-05 09:30", None]),',
          '  "dates": [datetime.date(2026, 1, 5), None],',
          '  "ints": [1, 2],',
          '  "floats": [1.5, float("inf")],',
          '  "nans": [float("nan"), 2.0],',
          '  "flags": [True, False],',
          '  "words": ["x", None],',
          '  "mixed": ["x", 1],',
          '  "span": pd.to_timedelta(["1 day 12:00:00", "2 days"]),',
          '})',
        ].join('\n'),
      )
      const f = out as Frame
      expect(f.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['naive:time', 'dates:time', 'ints:number', 'floats:number', 'nans:number', 'flags:boolean', 'words:string', 'mixed:string', 'span:number'])
      expect(f.rows[0]).toEqual([nyMidnight('2026-01-05') + 9.5 * 3_600_000, nyMidnight('2026-01-05'), 1, 1.5, null, true, 'x', 'x', 1.5])
      expect(f.rows[1]).toEqual([null, null, 2, null, 2, false, null, '1', 2])
    },
    RUN_MS,
  )

  it(
    'a DatetimeIndex or a named index becomes a leading column; the integer index filtering leaves is dropped; a Series is a one-column frame',
    async () => {
      const resampled = await py('result = df.set_index("time").resample("W-FRI").last()[["close"]]')
      expect((resampled as Frame).columns).toEqual([
        { name: 'time', type: 'time' },
        { name: 'close', type: 'number' },
      ])
      const filtered = await py('result = df[df.close > 102]')
      expect((filtered as Frame).columns[0]!.name).toBe('symbol')
      const grouped = await py('result = df.groupby("symbol").close.mean()')
      expect((grouped as Frame).columns).toEqual([
        { name: 'symbol', type: 'string' },
        { name: 'close', type: 'number' },
      ])
      const multi = await py('result = df.groupby("symbol").agg({"close": ["min", "max"]})')
      expect((multi as Frame).columns.map((c) => c.name)).toEqual(['symbol', 'close_min', 'close_max'])
    },
    RUN_MS,
  )
})

// ---------- guards ----------

describe('guards', () => {
  it(
    'a forbidden import is a traceback before the script runs',
    async () => {
      const out = await py('import os\nresult = df')
      expect(out).toMatchObject({ error: expect.stringMatching(/ImportError: import of 'os' is not allowed in a transform; allowed: collections, datetime, functools, itertools, json, math, numpy, ot, pandas, re, scipy, statistics, time/) })
      expect((out as { traceback: string }).traceback).toMatch(/ImportError/)
      const from = await py('from subprocess import run\nresult = df')
      expect(isTransformError(from) && from.error).toMatch(/subprocess/)
      const dunder = await py('os = __import__("os")\nresult = df')
      expect(isTransformError(dunder) && dunder.error).toMatch(/__import__/)
      const ok = await py('import math, statistics\nfrom scipy import stats\nimport numpy as np2\nimport datetime\nresult = pd.DataFrame({"x": [math.sqrt(4), statistics.mean([1, 3]), float(stats.norm.cdf(0)), datetime.datetime.strptime("2026-01-02", "%Y-%m-%d").day]})')
      expect(objects(ok).map((r) => r.x)).toEqual([2, 2, 0.5, 2])
    },
    RUN_MS,
  )

  it(
    'open, exec and eval are not in the script namespace',
    async () => {
      const out = await py('result = pd.DataFrame({"x": [open]})')
      expect(isTransformError(out) && out.error).toMatch(/NameError: name 'open' is not defined/)
    },
    RUN_MS,
  )

  it(
    'a Python error is returned as { error, traceback } pointing at the script line',
    async () => {
      const out = await py('x = 1\ny = df["missing"]\nresult = df')
      expect(isTransformError(out)).toBe(true)
      if (!isTransformError(out)) return
      expect(out.error).toBe("KeyError: 'missing'")
      expect(out.traceback).toContain('File "<transform>", line 2')
      expect(out.traceback).toContain('y = df["missing"]')
      const syntax = await py('result = df[')
      expect(isTransformError(syntax) && syntax.error).toMatch(/^SyntaxError/)
      const missing = await py('x = 1')
      expect(isTransformError(missing) && missing.error).toBe('NameError: the script must assign `result`, a DataFrame')
      const wrong = await py('result = 42')
      expect(isTransformError(wrong) && wrong.error).toBe('TypeError: the script must assign `result`, a DataFrame (got int)')
    },
    RUN_MS,
  )

  it(
    'a run past the CPU budget is interrupted and the worker stays warm',
    async () => {
      const boots = engine.stats().boots
      const out = await engine.run({ df: priceFrame(['A'], '2026-01-02', '2026-01-09', (i) => i) }, 'while True:\n    pass', undefined, { timeoutMs: 300 })
      expect(isTransformError(out) && out.error).toMatch(/exceeded the 0.3 s CPU budget/)
      expect(engine.stats().boots).toBe(boots)
      const after = await py('result = df.head(1)')
      expect((after as Frame).rows.length).toBe(1)
    },
    RUN_MS,
  )

  it(
    'a script that swallows the interrupt is killed and the next run boots a fresh worker',
    async () => {
      const boots = engine.stats().boots
      const code = 'try:\n    while True:\n        pass\nexcept KeyboardInterrupt:\n    while True:\n        pass'
      const out = await engine.run({ df: priceFrame(['A'], '2026-01-02', '2026-01-09', (i) => i) }, code, undefined, { timeoutMs: 300 })
      expect(isTransformError(out) && out.error).toMatch(/did not stop when interrupted; the worker was killed/)
      expect(engine.stats().lastRestart).toMatch(/killed/)
      const t0 = Date.now()
      const after = await py('result = df.head(2)')
      console.log(`[transform] restart after kill ${Date.now() - t0} ms`)
      expect((after as Frame).rows.length).toBe(2)
      expect(engine.stats().boots).toBe(boots + 1)
    },
    BOOT_MS,
  )

  it(
    'input and output caps and the code cap are enforced before and inside the worker',
    async () => {
      const big = frame([{ name: 'x', type: 'number' }], Array.from({ length: TRANSFORM_LIMITS.inputRows + 1 }, (_, i) => [i]))
      const tooMany = await engine.run({ big }, 'result = big')
      expect(isTransformError(tooMany) && tooMany.error).toMatch(/the cap is 250,000/)
      const none = await engine.run({}, 'result = 1')
      expect(isTransformError(none) && none.error).toBe('a transform needs at least one input')
      const reserved = await engine.run({ pd: frame([{ name: 'x', type: 'number' }], [[1]]) }, 'result = 1')
      expect(isTransformError(reserved) && reserved.error).toMatch(/"pd" is not a usable Python identifier/)
      const long = await py('#' + 'x'.repeat(TRANSFORM_LIMITS.codeChars))
      expect(isTransformError(long) && long.error).toMatch(/the cap is 20,000/)
      const wide = await py(`result = pd.DataFrame({"x": range(${TRANSFORM_LIMITS.outputRows + 1})})`)
      expect(isTransformError(wide) && wide.error).toMatch(/ValueError: transform result has 50,001 rows; the cap is 50,000/)
    },
    RUN_MS,
  )

  it(
    'runs are serialised and an aborted signal ends the run',
    async () => {
      const a = py('result = pd.DataFrame({"x": [1]})')
      const b = py('result = pd.DataFrame({"x": [2]})')
      const [ra, rb] = await Promise.all([a, b])
      expect(objects(ra)[0]!.x).toBe(1)
      expect(objects(rb)[0]!.x).toBe(2)
      const ac = new AbortController()
      const p = engine.run({ df: priceFrame(['A'], '2026-01-02', '2026-01-09', (i) => i) }, 'while True:\n    pass', undefined, { signal: ac.signal })
      setTimeout(() => ac.abort(), 100)
      const out = await p
      expect(isTransformError(out) && out.error).toMatch(/aborted/)
    },
    RUN_MS,
  )
})

describe('memory cap', () => {
  it(
    'a run that grows the process past the cap is killed and the next run boots a fresh worker',
    async () => {
      const small = createTransformEngine({ log: (m) => logs.push(m), now: () => NOW, memoryMb: 64 })
      try {
        await small.warmup()
        const boots = small.stats().boots
        // 400 MB of ones, then a long loop so the 250 ms sampler sees the growth while the run is still going.
        const code = 'a = np.ones(50_000_000)\ns = 0.0\nfor i in range(10**9):\n    s += a[i % 1000]\nresult = pd.DataFrame({"s": [s]})'
        const out = await small.run({ df: TEN }, code)
        expect(isTransformError(out) && out.error).toMatch(/exceeded the 64 MB memory cap/)
        expect(small.stats().lastRestart).toMatch(/memory cap/)
        const after = await small.run({ df: TEN }, 'result = df.head(1)')
        expect((after as Frame).rows.length).toBe(1)
        expect(small.stats().boots).toBe(boots + 1)
      } finally {
        await small.close()
      }
    },
    BOOT_MS * 2,
  )
})

// ---------- ot helpers ----------

/** Ten sessions, 2026-01-02 to 2026-01-15, closes chosen so every helper has a hand-checkable value. */
const CLOSES = [100, 102, 101, 105, 107, 106, 110, 108, 112, 115]
const TEN = priceFrame(['A'], '2026-01-02', '2026-01-15', (i) => CLOSES[i]!)

async function helper(code: string, inputs: Record<string, Frame> = { df: TEN }) {
  return objects(await engine.run(inputs, code))
}

/** Reference EMA: alpha = 2 / (n + 1), seeded with the first value. */
function emaRef(xs: number[], n: number): number[] {
  const a = 2 / (n + 1)
  const out: number[] = []
  xs.forEach((x, i) => out.push(i === 0 ? x : a * x + (1 - a) * out[i - 1]!))
  return out
}

/** Reference Wilder RSI: simple averages over the first n changes, then (prev × (n − 1) + x) / n. */
function rsiRef(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = xs.map(() => null)
  let ag = 0
  let al = 0
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!
    const g = Math.max(d, 0)
    const l = Math.max(-d, 0)
    if (i < n) {
      ag += g
      al += l
      continue
    }
    if (i === n) {
      ag = (ag + g) / n
      al = (al + l) / n
    } else {
      ag = (ag * (n - 1) + g) / n
      al = (al * (n - 1) + l) / n
    }
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
  }
  return out
}

/** A deterministic wandering series (LCG), 60 points around 100. */
function wander(count: number): number[] {
  let seed = 12345
  const out: number[] = []
  let x = 100
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    x += (seed / 2147483648 - 0.48) * 4
    out.push(Math.round(x * 100) / 100)
  }
  return out
}

describe('ot helpers', () => {
  it(
    'calendar: trading_days, last_week, last_trading_day',
    async () => {
      const [r] = await helper(
        [
          'days = ot.trading_days("2026-01-01", "2026-01-20")',
          'lw = ot.last_week()',
          'ltd = ot.last_trading_day()',
          'ot._set_now(%d)  # 09:00 ET the same day: before the open',
          'early = ot.last_trading_day()',
          'ot._set_now(%d)  # Saturday 2026-01-17 noon',
          'sat = ot.last_trading_day()',
          'result = pd.DataFrame([{"days": ",".join(days), "n": len(days), "lw0": lw[0], "lw1": lw[1], "ltd": ltd, "early": early, "sat": sat,',
          '  "jan1": ot.is_trading_day("2026-01-01"), "jan19": ot.is_trading_day("2026-01-19"), "ec": ot.is_early_close("2026-11-27"),',
          '  "prev": ot.previous_trading_day("2026-01-20"), "next": ot.next_trading_day("2026-01-16")}])',
        ]
          .join('\n')
          .replace('%d', String(Date.UTC(2026, 9, 14, 13, 0)))
          .replace('%d', String(Date.UTC(2026, 0, 17, 17, 0))),
      )
      // January 2026: New Year's Day (Thu) and MLK day (Mon 19th) closed → 12 sessions from the 1st to the 20th.
      expect(r!.days).toBe('2026-01-02,2026-01-05,2026-01-06,2026-01-07,2026-01-08,2026-01-09,2026-01-12,2026-01-13,2026-01-14,2026-01-15,2026-01-16,2026-01-20')
      expect(r!.n).toBe(12)
      // NOW is Wednesday 2026-10-14: last week is Mon 10-05 to Fri 10-09, as clock.lastWeek says.
      expect([r!.lw0, r!.lw1]).toEqual([lastWeek(NOW).start, lastWeek(NOW).end])
      expect([r!.lw0, r!.lw1]).toEqual(['2026-10-05', '2026-10-09'])
      expect(r!.ltd).toBe(lastTradingDay(NOW))
      expect(r!.ltd).toBe('2026-10-14')
      expect(r!.early).toBe('2026-10-13')
      expect(r!.sat).toBe('2026-01-16')
      expect(r).toMatchObject({ jan1: false, jan19: false, ec: true, prev: '2026-01-16', next: '2026-01-20' })
    },
    RUN_MS,
  )

  it(
    'parity: ot.trading_days equals clock.tradingDays over 2025–2026 and the holiday tables match',
    async () => {
      const [r] = await helper('days = ot.trading_days("2025-01-01", "2026-12-31")\nresult = pd.DataFrame([{"days": ",".join(days), "h": ",".join(sorted(ot.NYSE_HOLIDAYS)), "e": ",".join(sorted(ot.NYSE_EARLY_CLOSES))}])')
      const expected = tradingDays('2025-01-01', '2026-12-31')
      expect((r!.days as string).split(',')).toEqual(expected)
      // 2025: 261 weekdays − 11 closures (the day of mourning included) = 250; 2026: 261 − 10 = 251.
      expect(expected.length).toBe(250 + 251)
      expect((r!.h as string).split(',')).toEqual([...NYSE_HOLIDAYS].sort())
      expect((r!.e as string).split(',')).toEqual([...NYSE_EARLY_CLOSES].sort())
    },
    RUN_MS,
  )

  it(
    'prev_close and baseline agree with clock.prevClose and the close before the period',
    async () => {
      const two = priceFrame(['A', 'B'], '2026-01-02', '2026-01-15', (i, s) => CLOSES[i]! + s * 50)
      const [r] = await helper(
        [
          'pc = ot.prev_close(df)',
          'bl = ot.baseline(df, "2026-01-08")',
          'one = ot.prev_close(df[df.symbol == "A"].drop(columns="symbol"))',
          'result = pd.DataFrame([{"pcA": pc["A"], "pcB": pc["B"], "idx": pc.index.name, "blA": bl["A"], "blB": bl["B"], "one": one["*"]}])',
        ].join('\n'),
        { df: two },
      )
      // Daily bars: the bar before the last. A: 112 (2026-01-14), B: 162. Baseline for a period starting 01-08 is the 01-07 close: 105 / 155.
      expect(r).toEqual({ pcA: 112, pcB: 162, idx: 'symbol', blA: 105, blB: 155, one: 112 })
      expect(prevClose(two)).toEqual({ A: 112, B: 162 })
    },
    RUN_MS,
  )

  it(
    'rebase, returns, drawdown',
    async () => {
      const rows = await helper('r = ot.rebase(df)\nr["ret"] = ot.returns(df)["ret"]\nr["dd"] = ot.drawdown(df)["drawdown"]\nr["r1"] = ot.rebase(df, base=1.0)["rebased"]\nresult = r[["time", "close", "rebased", "ret", "dd", "r1"]]')
      expect(rows.length).toBe(10)
      // 105 / 100 × 100 = 105; (102 / 100 − 1) × 100 = 2; (101 / 102 − 1) × 100 = −0.98…; peak 110 then 108 → −1.81…
      expect(rows[3]!.rebased).toBeCloseTo(105, 10)
      expect(rows[3]!.r1).toBeCloseTo(1.05, 10)
      expect(rows[0]!.ret).toBeNull()
      expect(rows[1]!.ret).toBeCloseTo(2, 10)
      expect(rows[2]!.ret).toBeCloseTo((101 / 102 - 1) * 100, 10)
      expect(rows[2]!.dd).toBeCloseTo((101 / 102 - 1) * 100, 10)
      expect(rows[7]!.dd).toBeCloseTo((108 / 110 - 1) * 100, 10)
      expect(rows[9]!.dd).toBe(0)
    },
    RUN_MS,
  )

  it(
    'sma, ema, rsi, macd, bollinger, realized_vol against hand values',
    async () => {
      const rows = await helper(
        [
          'r = ot.sma(df, 3)',
          'r["ema_3"] = ot.ema(df, 3)["ema_3"]',
          'r["rsi"] = ot.rsi(df, 3)["rsi"]',
          'm = ot.macd(df, fast=2, slow=3, signal=2)',
          'r["macd"] = m["macd"]; r["sig"] = m["macd_signal"]; r["hist"] = m["macd_hist"]',
          'b = ot.bollinger(df, n=3, k=2.0)',
          'r["mid"] = b["bb_mid"]; r["up"] = b["bb_upper"]; r["lo"] = b["bb_lower"]',
          'r["rv"] = ot.realized_vol(df, n=2)["rv_2"]',
          'result = r.drop(columns=["symbol", "open", "high", "low", "volume"])',
        ].join('\n'),
      )
      // SMA(3) at i = 2: (100 + 102 + 101) / 3 = 101.
      expect(rows[1]!.sma_3).toBeNull()
      expect(rows[2]!.sma_3).toBeCloseTo(101, 10)
      // EMA(3), alpha 0.5, seeded at 100: 100, 101, 101, 103, 105, 105.5.
      expect(rows.slice(0, 6).map((r) => r.ema_3)).toEqual([100, 101, 101, 103, 105, 105.5])
      // RSI(3): changes +2 −1 +4 | +2: first averages gain 2, loss 1/3 → RS 6 → 85.714…; then gain (2×2+2)/3 = 2, loss (2/3)/3 = 2/9 → RS 9 → 90.
      expect(rows[2]!.rsi).toBeNull()
      expect(rows[3]!.rsi).toBeCloseTo(100 - 100 / 7, 10)
      expect(rows[4]!.rsi).toBeCloseTo(90, 10)
      // MACD(2, 3, 2) at i = 1: EMA2 = 100 + 2/3 × 2 = 101.333…, EMA3 = 101 → macd 0.333…; signal = 2/3 × 0.333… = 0.222…; hist 0.111….
      expect(rows[0]!.macd).toBe(0)
      expect(rows[1]!.macd).toBeCloseTo(1 / 3, 10)
      expect(rows[1]!.sig).toBeCloseTo(2 / 9, 10)
      expect(rows[1]!.hist).toBeCloseTo(1 / 9, 10)
      // Bollinger(3, 2) at i = 2: mid 101, population std of [100, 102, 101] = √(2/3).
      const sd = Math.sqrt(2 / 3)
      expect(rows[2]!.mid).toBeCloseTo(101, 10)
      expect(rows[2]!.up).toBeCloseTo(101 + 2 * sd, 10)
      expect(rows[2]!.lo).toBeCloseTo(101 - 2 * sd, 10)
      // Realized vol(2) at i = 2: sample std of the two log returns × √252 × 100.
      const r1 = Math.log(102 / 100)
      const r2 = Math.log(101 / 102)
      const mean = (r1 + r2) / 2
      const s = Math.sqrt(((r1 - mean) ** 2 + (r2 - mean) ** 2) / 1)
      expect(rows[1]!.rv).toBeNull()
      expect(rows[2]!.rv).toBeCloseTo(s * Math.sqrt(252) * 100, 8)
    },
    RUN_MS,
  )

  it(
    'EMA and RSI parity with a reference implementation over a 60-point series, per group',
    async () => {
      const xs = wander(60)
      const days = tradingDays('2026-01-02', '2026-06-30').slice(0, 60)
      const rows: unknown[][] = []
      for (const sym of ['A', 'B']) days.forEach((d, i) => rows.push([sym, nyMidnight(d) + 16 * 3_600_000, sym === 'A' ? xs[i] : xs[59 - i]]))
      const f = frame(
        [
          { name: 'symbol', type: 'string' },
          { name: 'time', type: 'time' },
          { name: 'close', type: 'number' },
        ],
        rows,
      )
      const out = await helper('r = ot.ema(df, 5)\nr["rsi"] = ot.rsi(df, 14)["rsi"]\nresult = r', { df: f })
      const a = out.filter((r) => r.symbol === 'A')
      const b = out.filter((r) => r.symbol === 'B')
      const emaA = emaRef(xs, 5)
      const rsiA = rsiRef(xs, 14)
      const rev = [...xs].reverse()
      const emaB = emaRef(rev, 5)
      const rsiB = rsiRef(rev, 14)
      a.forEach((r, i) => {
        expect(r.ema_5).toBeCloseTo(emaA[i]!, 9)
        if (rsiA[i] === null) expect(r.rsi).toBeNull()
        else expect(r.rsi).toBeCloseTo(rsiA[i]!, 9)
      })
      b.forEach((r, i) => {
        expect(r.ema_5).toBeCloseTo(emaB[i]!, 9)
        if (rsiB[i] === null) expect(r.rsi).toBeNull()
        else expect(r.rsi).toBeCloseTo(rsiB[i]!, 9)
      })
      expect(a.filter((r) => r.rsi !== null).length).toBe(60 - 14)
    },
    RUN_MS,
  )

  it(
    'corr is wide, one row and one column per symbol',
    async () => {
      // B = 2A has A's returns exactly (corr 1); C = 400 − A moves against A (corr near −1, not exactly: the returns differ in scale).
      const three = priceFrame(['A', 'B', 'C'], '2026-01-02', '2026-01-15', (i, s) => (s === 0 ? CLOSES[i]! : s === 1 ? 2 * CLOSES[i]! : 400 - CLOSES[i]!))
      const out = await engine.run({ df: three }, 'result = ot.corr(df)')
      const f = out as Frame
      expect(f.columns.map((c) => c.name)).toEqual(['symbol', 'A', 'B', 'C'])
      const rows = objects(out)
      expect(rows.map((r) => r.symbol)).toEqual(['A', 'B', 'C'])
      expect(rows[0]!.A).toBeCloseTo(1, 10)
      expect(rows[0]!.B).toBeCloseTo(1, 10)
      expect(rows[1]!.A).toBeCloseTo(1, 10)
      expect(rows[0]!.C).toBeLessThan(-0.99)
      expect(rows[2]!.A).toBe(rows[0]!.C)
      expect(rows[2]!.C).toBeCloseTo(1, 10)
    },
    RUN_MS,
  )

  it(
    'merge_asof: a quarterly table joined to daily closes as of each day',
    async () => {
      const code = [
        'e = eps.sort_values("date").rename(columns={"date": "time"})',
        'm = pd.merge_asof(df.sort_values("time"), e[["symbol", "time", "eps_actual"]], on="time", by="symbol")',
        'result = m[["time", "close", "eps_actual"]]',
      ].join('\n')
      const eps = frame(
        [
          { name: 'symbol', type: 'string' },
          { name: 'date', type: 'time' },
          { name: 'eps_actual', type: 'number' },
        ],
        [
          ['A', nyMidnight('2026-01-07'), 2],
          ['A', nyMidnight('2025-12-01'), 1],
        ],
      )
      const rows = await helper(code, { df: TEN, eps })
      // Bars before the 01-07 report carry the December figure; from the 7th (report at midnight, bar at 16:00) the new one.
      expect(rows.slice(0, 3).map((r) => r.eps_actual)).toEqual([1, 1, 1])
      expect(rows.slice(3).map((r) => r.eps_actual)).toEqual([2, 2, 2, 2, 2, 2, 2])
    },
    RUN_MS,
  )

  it(
    'Black-Scholes price and implied volatility, and to_et',
    async () => {
      const [r] = await helper(
        [
          'call = ot.bs_price(100, 100, 1, 0.05, 0.2)',
          'put = ot.bs_price(100, 100, 1, 0.05, 0.2, "put")',
          'iv = ot.bs_iv(call, 100, 100, 1, 0.05, "call")',
          'ivp = ot.bs_iv(put, 100, 100, 1, r=0.05, kind="put")',
          'bad = ot.bs_iv(0.01, 100, 100, 1, 0.05, "call")',
          'ms = ot.to_et(pd.Series([%d]))',
          'naive = ot.to_et(pd.Series(["2026-01-05 09:30"]))',
          'utc = ot.to_et(pd.to_datetime(pd.Series(["2026-01-05T14:30:00Z"])))',
          'result = pd.DataFrame([{"call": call, "put": put, "iv": iv, "ivp": ivp, "bad": bad, "ms": ms.iloc[0].isoformat(), "naive": naive.iloc[0].isoformat(), "utc": utc.iloc[0].isoformat(), "tz": str(ms.dt.tz)}])',
        ]
          .join('\n')
          .replace('%d', String(nyMidnight('2026-01-05') + 9.5 * 3_600_000)),
      )
      // The textbook case: S = K = 100, t = 1, r = 5 %, σ = 20 % → call 10.4506, put 5.5735 (put–call parity: C − P = S − K·e^(−rt)).
      expect(r!.call).toBeCloseTo(10.4506, 4)
      expect(r!.put).toBeCloseTo(5.5735, 4)
      expect((r!.call as number) - (r!.put as number)).toBeCloseTo(100 - 100 * Math.exp(-0.05), 10)
      expect(r!.iv).toBeCloseTo(0.2, 8)
      expect(r!.ivp).toBeCloseTo(0.2, 8)
      expect(r!.bad).toBeNull()
      expect(r!.ms).toBe('2026-01-05T09:30:00-05:00')
      expect(r!.naive).toBe('2026-01-05T09:30:00-05:00')
      expect(r!.utc).toBe('2026-01-05T09:30:00-05:00')
      expect(r!.tz).toBe('America/New_York')
    },
    RUN_MS,
  )

  it(
    'every OT_HELPERS name exists in ot with the documented parameters',
    async () => {
      const [r] = await helper('def names(f):\n    return ",".join(f.__code__.co_varnames[:f.__code__.co_argcount])\nresult = pd.DataFrame([{h: names(getattr(ot, h)) for h in %s}])'.replace('%s', JSON.stringify(OT_HELPERS.map((h) => h.name))))
      for (const h of OT_HELPERS) {
        const params = /\(([^)]*)\)/.exec(h.signature)![1]!.split(',').map((p) => p.trim().split(/[:=]/)[0]!.trim()).filter(Boolean)
        expect(r![h.name], h.name).toBe(params.join(','))
      }
    },
    RUN_MS,
  )
})
