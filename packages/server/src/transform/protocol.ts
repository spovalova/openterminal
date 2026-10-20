// Messages between the transform engine (index.ts, main thread) and the Pyodide worker (worker.ts). Types only.

export type WorkerData = {
  /** Directory holding the vendored wheels; `loadPackage` reads from it and never reaches the network. */
  packagesDir: string
  /** Pyodide's own files (pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json): its `indexURL`. */
  pyodideDir: string
  /** Directory holding `runtime.py` and `ot.py`. */
  scriptsDir: string
  /** Packages to load at boot (pandas, scipy, tzdata). */
  packages: string[]
  allowedImports: string[]
  /** One byte: set to 2 (SIGINT) by the main thread to raise KeyboardInterrupt in the running script. */
  interrupt: SharedArrayBuffer
}

export type RunRequest = {
  t: 'run'
  id: number
  code: string
  /** JSON of `Record<name, ColumnarFrame>`. */
  inputs: string
  nowMs: number
  maxRows: number
}

/** A frame by columns, the shape that crosses the JSON boundary in both directions. */
export type ColumnarFrame = { columns: { name: string; type: string }[]; data: Record<string, unknown[]> }

export type WorkerMessage =
  | { t: 'ready'; ms: { pyodide: number; packages: number; imports: number }; heapMb: number }
  | { t: 'result'; id: number; out: string; ms: number; heapMb: number }
  | { t: 'fatal'; error: string }

/** What `runtime.run` returns, parsed. */
export type RuntimeResult =
  | ({ ok: true; rowCount: number; stdout?: string } & ColumnarFrame)
  | { ok: false; error: string; traceback?: string; stdout?: string }
