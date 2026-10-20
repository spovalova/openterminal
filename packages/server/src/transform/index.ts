// The transform engine (PLAN.md section 17, "Transforms"; docs/notes/v2-contracts.md, workstream b): one warm
// Pyodide worker per server that runs the agent's pandas scripts over frames.
//
// - Frames cross to Python by columns as JSON; `runtime.py` binds them as DataFrames (time columns tz-aware in
//   America/New_York) and returns `result` the same way; rows are rebuilt here.
// - Limits (`TRANSFORM_LIMITS`): inputs and code are checked before anything is sent; the worker gets a CPU
//   budget per run, past which the interrupt flag is raised (KeyboardInterrupt in the script) and, when that is
//   ignored for `interruptGraceMs`, the thread is terminated; process memory growing past `memoryMb` during a run
//   terminates it too; a worker whose WebAssembly heap passed `memoryMb` is recycled after the run. A terminated
//   worker is replaced lazily on the next run (cold start again).
// - Runs are serialised on the single worker; `warmup()` pays the cold start early.
// - The vendored wheels live in packages/server/pyodide (see scripts/vendor-pyodide.mjs); nothing is fetched. Every
//   path (the worker, its Python helpers, Pyodide's own files, the wheels) comes from `resources()`, so the release
//   bundle finds them in its lib/ directory.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  checkTransformInputs,
  TRANSFORM_ALLOWED_IMPORTS,
  TRANSFORM_LIMITS,
  type Column,
  type FieldConfig,
  type Frame,
  type TransformEngine,
  type TransformOutput,
  type TransformRunOptions,
} from '@openterminal/core'
import { resources } from '@openterminal/core/node'
import type { ColumnarFrame, RunRequest, RuntimeResult, WorkerData, WorkerMessage } from './protocol.js'

export type { ColumnarFrame } from './protocol.js'

/** Where `vendor-pyodide.mjs` puts the wheels (packages/server/pyodide; lib/wheels in the release bundle). */
export const PYODIDE_PACKAGES_DIR = resources().wheels
/** What the worker loads at boot; their dependency closure is what is vendored. */
export const PYODIDE_PACKAGES = ['pandas', 'scipy', 'tzdata'] as const

export type TransformEngineOptions = {
  log?: (msg: string) => void
  /** CPU budget per run (default `TRANSFORM_LIMITS.cpuMs`). */
  timeoutMs?: number
  /** Memory cap in MB (default `TRANSFORM_LIMITS.memoryMb`). */
  memoryMb?: number
  /** How long a script may ignore the interrupt before the worker is killed (default 1000 ms). */
  interruptGraceMs?: number
  /** Directory of vendored wheels (default `resources().wheels`, packages/server/pyodide from source). */
  packagesDir?: string
  /** Clock for `ot.last_week()` and friends and for `meta.fetchedAt`; injectable for tests. */
  now?: () => number
}

export type TransformEngineStats = {
  /** Milliseconds of the last cold start, by phase; undefined before the first boot. */
  coldStart?: { total: number; pyodide: number; packages: number; imports: number }
  /** Boots so far (1 after warmup; more after a kill or recycle). */
  boots: number
  runs: number
  /** Milliseconds of the last run inside Python, and end to end. */
  lastRun?: { python: number; total: number }
  heapMb: number
  /** Why the worker was last killed or recycled, if ever. */
  lastRestart?: string
}

export interface ServerTransformEngine extends TransformEngine {
  warmup(): Promise<void>
  close(): Promise<void>
  stats(): TransformEngineStats
}

/** The wheels the lock file says `PYODIDE_PACKAGES` need, as file names; missing ones mean the vendoring step was skipped. */
export function vendoredWheels(packagesDir = PYODIDE_PACKAGES_DIR): { file: string; present: boolean }[] {
  const lockPath = join(resources().pyodide, 'pyodide-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages: Record<string, { file_name: string; depends: string[] }> }
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    const p = lock.packages[name]
    if (!p) throw new Error(`"${name}" is not in the Pyodide lock file`)
    seen.add(name)
    for (const d of p.depends) visit(d)
  }
  for (const r of PYODIDE_PACKAGES) visit(r)
  return [...seen].sort().map((name) => {
    const file = lock.packages[name]!.file_name
    return { file, present: existsSync(join(packagesDir, file)) }
  })
}

type Pending = {
  id: number
  resolve: (r: TransformOutput) => void
  startedAt: number
  rss0: number
  timers: NodeJS.Timeout[]
  interval?: NodeJS.Timeout
  settled: boolean
  /** Set when the engine raised the interrupt; an error the script returns after that is reported as this reason. */
  interrupted?: string
}

type Handle = {
  worker: Worker
  interrupt: Uint8Array
  ready: Promise<void>
  bootedAt: number
  heapMb: number
  /** The pending run on this worker, if any. */
  pending?: Pending
  killed?: string
}

export function createTransformEngine(opts: TransformEngineOptions = {}): ServerTransformEngine {
  const log = opts.log ?? (() => {})
  const timeoutMs = opts.timeoutMs ?? TRANSFORM_LIMITS.cpuMs
  const memoryMb = opts.memoryMb ?? TRANSFORM_LIMITS.memoryMb
  const graceMs = opts.interruptGraceMs ?? 1000
  const packagesDir = opts.packagesDir ?? PYODIDE_PACKAGES_DIR
  const now = opts.now ?? Date.now

  const stats: TransformEngineStats = { boots: 0, runs: 0, heapMb: 0 }
  let handle: Handle | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let nextId = 1
  let closed = false

  function spawn(): Handle {
    const missing = vendoredWheels(packagesDir).filter((w) => !w.present)
    if (missing.length > 0) throw new Error(`transform engine: ${missing.length} Pyodide wheel(s) missing from ${packagesDir} (${missing.map((m) => m.file).join(', ')}); run node packages/server/scripts/vendor-pyodide.mjs`)
    const interrupt = new SharedArrayBuffer(1)
    const res = resources()
    const workerData: WorkerData = {
      packagesDir,
      pyodideDir: res.pyodide,
      scriptsDir: res.transformScripts,
      packages: [...PYODIDE_PACKAGES],
      allowedImports: [...TRANSFORM_ALLOWED_IMPORTS],
      interrupt,
    }
    // From source the worker is TypeScript: Node ≥ 22.18 strips types natively, older 22.x needs the flag, and under
    // tsx the loader is inherited through execArgv. The release bundle's worker is plain JavaScript.
    const features = (process as unknown as { features?: { typescript?: unknown } }).features
    const needsStrip = res.transformWorker.endsWith('.ts') && !features?.typescript && !process.execArgv.some((a) => a.includes('tsx'))
    const execArgv = needsStrip ? [...process.execArgv, '--experimental-strip-types'] : undefined
    const worker = new Worker(pathToFileURL(res.transformWorker), { workerData, ...(execArgv ? { execArgv } : {}), stdout: true, stderr: true })
    worker.stdout.on('data', () => {})
    worker.stderr.on('data', () => {})
    const t0 = now()
    const h: Handle = { worker, interrupt: new Uint8Array(interrupt), bootedAt: t0, heapMb: 0, ready: undefined as unknown as Promise<void> }
    h.ready = new Promise<void>((resolve, reject) => {
      const onReady = (m: WorkerMessage) => {
        if (m.t === 'ready') {
          const total = now() - t0
          stats.coldStart = { total, ...m.ms }
          stats.boots += 1
          h.heapMb = m.heapMb
          stats.heapMb = m.heapMb
          log(`transform worker ready in ${total} ms (pyodide ${m.ms.pyodide}, packages ${m.ms.packages}, imports ${m.ms.imports}); heap ${m.heapMb} MB`)
          worker.off('message', onReady)
          resolve()
        } else if (m.t === 'fatal') {
          worker.off('message', onReady)
          reject(new Error(`transform worker failed to start: ${m.error}`))
        }
      }
      worker.on('message', onReady)
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('transform worker exited during start')))
    })
    h.ready.catch(() => {})
    worker.on('message', (m: WorkerMessage) => {
      if (m.t !== 'result') return
      const p = h.pending
      if (!p || p.id !== m.id) return
      h.heapMb = m.heapMb
      stats.heapMb = m.heapMb
      stats.lastRun = { python: m.ms, total: now() - p.startedAt }
      const parsed = parseResult(m.out, now())
      settle(h, p, p.interrupted && isError(parsed) ? { error: p.interrupted } : parsed)
      if (m.heapMb > memoryMb) retire(h, `WebAssembly heap at ${m.heapMb} MB passed the ${memoryMb} MB cap after a run`)
    })
    worker.on('error', (err) => {
      const p = h.pending
      if (p) settle(h, p, { error: `transform worker crashed: ${err.message}` })
      retire(h, `crashed: ${err.message}`)
    })
    worker.on('exit', (code) => {
      const p = h.pending
      if (p) settle(h, p, { error: h.killed ?? `transform worker exited (code ${code})` })
      if (handle === h) handle = undefined
    })
    return h
  }

  /** Stop using this worker; terminate it once nothing is pending. */
  function retire(h: Handle, why: string) {
    if (handle === h) handle = undefined
    if (!h.killed) {
      h.killed = why
      stats.lastRestart = why
      log(`transform worker retired: ${why}`)
    }
    void h.worker.terminate()
  }

  function settle(h: Handle, p: Pending, out: TransformOutput) {
    if (p.settled) return
    p.settled = true
    for (const t of p.timers) clearTimeout(t)
    if (p.interval) clearInterval(p.interval)
    h.interrupt[0] = 0
    if (h.pending === p) h.pending = undefined
    stats.runs += 1
    p.resolve(out)
  }

  async function ensure(): Promise<Handle> {
    if (closed) throw new Error('transform engine is closed')
    if (!handle) handle = spawn()
    const h = handle
    try {
      await h.ready
    } catch (err) {
      if (handle === h) handle = undefined
      void h.worker.terminate()
      throw err
    }
    return h
  }

  function execute(inputs: Record<string, Frame>, code: string, columns: Record<string, FieldConfig> | undefined, ro: TransformRunOptions): Promise<TransformOutput> {
    return new Promise<TransformOutput>((resolve) => {
      ensure().then(
        (h) => {
          if (ro.signal?.aborted) return resolve({ error: 'transform aborted' })
          const id = nextId++
          const budget = ro.timeoutMs ?? timeoutMs
          const p: Pending = { id, resolve: (r) => resolve(stamp(r, columns)), startedAt: now(), rss0: process.memoryUsage().rss, timers: [], settled: false }
          h.pending = p
          const kill = (why: string) => {
            if (p.settled) return
            retire(h, why)
            settle(h, p, { error: why })
          }
          const interruptThenKill = (why: string) => {
            if (p.settled) return
            p.interrupted = why
            h.interrupt[0] = 2
            p.timers.push(setTimeout(() => kill(`${why} and did not stop when interrupted; the worker was killed`), graceMs))
          }
          p.timers.push(setTimeout(() => interruptThenKill(`transform exceeded the ${(budget / 1000).toFixed(budget % 1000 ? 1 : 0)} s CPU budget`), budget))
          p.interval = setInterval(() => {
            const grown = (process.memoryUsage().rss - p.rss0) / 1e6
            if (grown > memoryMb) kill(`transform exceeded the ${memoryMb} MB memory cap (process grew ${Math.round(grown)} MB)`)
          }, 250)
          ro.signal?.addEventListener('abort', () => interruptThenKill('transform aborted'), { once: true })
          const req: RunRequest = { t: 'run', id, code, inputs: JSON.stringify(toColumnar(inputs)), nowMs: now(), maxRows: TRANSFORM_LIMITS.outputRows }
          h.worker.postMessage(req)
        },
        (err: unknown) => resolve({ error: err instanceof Error ? err.message : String(err) }),
      )
    })
  }

  function stamp(r: TransformOutput, columns: Record<string, FieldConfig> | undefined): TransformOutput {
    if (isError(r)) return r
    const f = r as Frame
    return columns && Object.keys(columns).length > 0 ? { ...f, meta: { ...f.meta, fields: { ...columns } } } : f
  }

  return {
    run(inputs, code, columns, ro = {}) {
      const issue = checkTransformInputs(inputs)
      if (issue) return Promise.resolve({ error: issue })
      if (code.length > TRANSFORM_LIMITS.codeChars) return Promise.resolve({ error: `transform code is ${code.length.toLocaleString()} characters; the cap is ${TRANSFORM_LIMITS.codeChars.toLocaleString()}` })
      if (code.trim().length === 0) return Promise.resolve({ error: 'transform code is empty' })
      const job = queue.then(() => execute(inputs, code, columns, ro))
      queue = job.catch(() => {})
      return job
    },
    async warmup() {
      await ensure()
    },
    async close() {
      closed = true
      const h = handle
      handle = undefined
      if (h) {
        const p = h.pending
        if (p) settle(h, p, { error: 'transform engine closed' })
        await h.worker.terminate()
      }
    },
    stats: () => ({ ...stats }),
  }
}

// ---- frame conversion (JS side) ----

/** Rows → columns, the shape `runtime.py` reads. */
export function toColumnar(inputs: Record<string, Frame>): Record<string, ColumnarFrame> {
  const out: Record<string, ColumnarFrame> = {}
  for (const [name, f] of Object.entries(inputs)) {
    const data: Record<string, unknown[]> = {}
    f.columns.forEach((c, i) => {
      data[c.name] = f.rows.map((r) => {
        const v = r[i]
        if (v === undefined || v === null) return null
        if (typeof v === 'number') return Number.isFinite(v) ? v : null
        return v
      })
    })
    out[name] = { columns: f.columns.map((c) => ({ name: c.name, type: c.type })), data }
  }
  return out
}

/** Columns → rows: the worker's payload as a Frame. */
export function fromColumnar(cf: ColumnarFrame, fetchedAt: number): Frame {
  const columns: Column[] = cf.columns.map((c) => ({ name: c.name, type: asType(c.type) }))
  const n = columns.length > 0 ? (cf.data[columns[0]!.name]?.length ?? 0) : 0
  const lists = columns.map((c) => cf.data[c.name] ?? [])
  const rows: unknown[][] = new Array(n)
  for (let i = 0; i < n; i++) rows[i] = lists.map((l) => (l[i] === undefined ? null : l[i]))
  return { columns, rows, meta: { connector: 'transform', fetchedAt, ttl: 0 } }
}

function isError(r: TransformOutput): r is { error: string; traceback?: string } {
  return typeof (r as { error?: unknown }).error === 'string'
}

function asType(t: string): Column['type'] {
  return t === 'number' || t === 'time' || t === 'boolean' ? t : 'string'
}

function parseResult(out: string, fetchedAt: number): TransformOutput {
  let r: RuntimeResult
  try {
    r = JSON.parse(out) as RuntimeResult
  } catch (err) {
    return { error: `transform result could not be parsed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!r.ok) return { error: r.error, ...(r.traceback ? { traceback: r.traceback } : {}) }
  return fromColumnar(r, fetchedAt)
}
