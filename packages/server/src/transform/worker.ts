// The Pyodide worker: one CPython in WebAssembly per thread, pandas, numpy and scipy loaded from the vendored
// wheels, `runtime.py` and `ot.py` installed, then `run` messages answered one at a time. The main thread
// (index.ts) owns the limits: it sets the interrupt flag past the CPU budget and terminates the thread when the
// flag is ignored or memory grows past the cap.
//
// This file runs as a plain Node worker (type stripping, no bundler), so it imports only `pyodide` and node
// builtins and uses erasable TypeScript syntax only. Protocol types are in protocol.ts, shared with index.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { loadPyodide, type PyodideInterface } from 'pyodide'
import type { RunRequest, WorkerData, WorkerMessage } from './protocol.js'

const data = workerData as WorkerData
const port = parentPort
if (!port) throw new Error('transform worker started without a parent port')

const post = (m: WorkerMessage) => port.postMessage(m)
const here = import.meta.url

/** The WebAssembly heap in MB, which only ever grows; the engine recycles the worker past the memory cap. */
function heapMb(py: PyodideInterface): number {
  const mod = (py as unknown as { _module?: { HEAPU8?: { byteLength: number } } })._module
  return Math.round((mod?.HEAPU8?.byteLength ?? 0) / 1e6)
}

async function boot(): Promise<{ py: PyodideInterface; run: (code: string, inputs: string, nowMs: number, maxRows: number) => string }> {
  const t0 = performance.now()
  const py = await loadPyodide({
    packageCacheDir: data.packagesDir,
    // The `js` module sees only this object: no fetch, no process, no require from Python.
    jsglobals: { setTimeout, clearTimeout, setInterval, clearInterval },
    stdout: () => {},
    stderr: () => {},
  })
  const t1 = performance.now()
  await py.loadPackage(data.packages, { messageCallback: () => {}, errorCallback: () => {} })
  const t2 = performance.now()
  py.setInterruptBuffer(new Uint8Array(data.interrupt))
  py.FS.writeFile('/home/pyodide/ot.py', readFileSync(fileURLToPath(new URL('./ot.py', here)), 'utf8'))
  py.FS.writeFile('/home/pyodide/runtime.py', readFileSync(fileURLToPath(new URL('./runtime.py', here)), 'utf8'))
  py.runPython('import sys\nsys.path.insert(0, "/home/pyodide")\nimport runtime')
  const runtime = py.pyimport('runtime') as { configure: (allowed: string[]) => void; run: (code: string, inputs: string, nowMs: number, maxRows: number) => string }
  runtime.configure(data.allowedImports)
  const t3 = performance.now()
  post({ t: 'ready', ms: { pyodide: Math.round(t1 - t0), packages: Math.round(t2 - t1), imports: Math.round(t3 - t2) }, heapMb: heapMb(py) })
  return { py, run: runtime.run }
}

const booted = boot().catch((err: unknown) => {
  post({ t: 'fatal', error: err instanceof Error ? err.message : String(err) })
  return undefined
})

port.on('message', async (msg: RunRequest) => {
  if (msg.t !== 'run') return
  const b = await booted
  if (!b) return
  const t0 = performance.now()
  let out: string
  try {
    out = b.run(msg.code, msg.inputs, msg.nowMs, msg.maxRows)
  } catch (err) {
    out = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
  post({ t: 'result', id: msg.id, out, ms: Math.round(performance.now() - t0), heapMb: heapMb(b.py) })
})
