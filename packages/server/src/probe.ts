// The catalog probe (PLAN.md section 17): one call per route with default params and a sample symbol, four at
// a time (OpenBB serves blocking provider calls on one event loop; eight stalled it and the 8 GB box OOM-killed it,
// docs/notes/openbb-probe.md part 3), the result recorded as the route's liveness on the catalog and in the
// liveness store. Run from `scripts/probe-catalog.ts` and, in-process, from (e)'s `POST /api/catalog/probe`.
import { lastWeek, validateParams, type Catalog, type ConnectorRegistry, type Descriptor, type DescriptorParam, type Frame } from '@openterminal/core'
import { livenessOf, livenessRow, type LivenessRow, type LivenessStore } from './liveness.js'

/**
 * What every route is asked for when it needs a value: a liquid name, last week, the US; for the FINRA bond routes an
 * issuer and a CUSIP (CoreWeave's 9.25% 2030s), because `fixedincome/corporate/bond_prices` with no filter is FINRA's
 * whole universe and times out (docs/notes/openbb-probe.md part 3).
 */
export const SAMPLE = { symbol: 'NVDA', query: 'nvidia', country: 'united_states', etf: 'SPY', index: '^GSPC', currency: 'EURUSD', crypto: 'BTCUSD', issuer: 'coreweave', cusip: '21873SAB4' } as const
/** The default number of routes in flight; `pnpm probe --concurrency=` and the probe route's body override it. */
export const PROBE_CONCURRENCY = 4

/**
 * OpenBB providers that answer without a key on this machine (docs/notes/openbb-probe.md), in the order the probe
 * retries them when a route's default provider wants credentials.
 */
export const KEYLESS_PROVIDERS: readonly string[] = ['yfinance', 'nasdaq', 'cboe', 'sec', 'finra', 'federal_reserve', 'us_treasury', 'oecd', 'imf', 'ecb', 'cftc', 'deribit', 'famafrench', 'tmx']

export type SampleResult = { params: Record<string, unknown> } | { skip: string }

/** A sample value for one param, or undefined when there is no sensible one. */
export function sampleValue(p: DescriptorParam, descriptor: Descriptor, now: number): unknown {
  const week = lastWeek(now)
  const name = p.name.toLowerCase()
  const list = (v: string) => (p.type === 'string[]' ? [v] : v)
  const inEnum = (v: string) => !p.enum || p.enum.includes(v)
  if (/^(symbol|symbols|ticker|tickers)$/.test(name)) {
    const ns = descriptor.route.split('/')[0] ?? ''
    if (ns === 'etf' || /holdings/.test(descriptor.route)) return list(SAMPLE.etf)
    if (ns === 'index') return list(SAMPLE.index)
    if (ns === 'currency') return list(SAMPLE.currency)
    if (ns === 'crypto') return list(SAMPLE.crypto)
    return list(SAMPLE.symbol)
  }
  if (/^(query|q|term|search|text)$/.test(name)) return SAMPLE.query
  if (name === 'issuer_name') return SAMPLE.issuer
  if (name === 'cusip') return list(SAMPLE.cusip)
  if (/^modules$/.test(name)) return ['price']
  if (/country/.test(name)) return inEnum(SAMPLE.country) ? list(SAMPLE.country) : p.enum ? list(p.enum[0]!) : list(SAMPLE.country)
  if (p.type === 'date') {
    if (/(start|from|min|period1|begin)/.test(name)) return week.start
    if (/(end|to|max|period2|until)/.test(name)) return week.end
    return week.end // a single date: last Friday, which every daily series has published by now
  }
  if (p.enum && p.enum.length > 0) {
    const d = p.default !== undefined && p.default !== null ? String(p.default) : undefined
    return list(d && p.enum.includes(d) ? d : p.enum[0]!)
  }
  if (p.default !== undefined && p.default !== null) return p.default
  if (p.type === 'boolean') return false
  if (p.type === 'integer' || p.type === 'number') return /limit|count|size|top|n$/.test(name) ? 10 : 1
  return undefined
}

/**
 * Params for one probe call: every required param, plus an optional symbol or query (routes that take one answer
 * better with it), validated so the descriptor's defaults are applied. A required param with no sample (a dataflow
 * id, a BLS table) skips the route rather than guessing.
 */
export function sampleParams(descriptor: Descriptor, now: number = Date.now()): SampleResult {
  const params: Record<string, unknown> = {}
  for (const p of descriptor.params) {
    // Optional params worth sending: a symbol or query (routes answer better with one) and FINRA's issuer filter
    // (without it bond_prices is the whole TRACE universe and times out).
    const wanted = p.required || /^(symbol|symbols|query|q|issuer_name)$/.test(p.name)
    if (!wanted) continue
    const v = sampleValue(p, descriptor, now)
    if (v === undefined) {
      if (p.required) return { skip: `no sample for required param "${p.name}"` }
      continue
    }
    params[p.name] = v
  }
  const checked = validateParams(descriptor, params)
  if (!checked.ok) return { skip: `sample params rejected: ${checked.issues.join('; ')}` }
  return { params: checked.params }
}

export type ErrorClass = 'down' | 'needs key' | 'timeout' | 'not found' | 'bad params' | 'provider error' | 'http 4xx' | 'http 5xx' | 'no envelope' | 'rate limited' | 'empty' | 'other'

/** One label per failure family, for the probe summary and the retry rule. */
export function classifyError(message: string): ErrorClass {
  const m = message
  if (/not running|ECONNREFUSED|ECONNRESET|fetch failed/i.test(m)) return 'down'
  if (/timed out|timeout|aborted|AbortError/i.test(m)) return 'timeout'
  if (/\b(401|403)\b|api[_ ]?key|credential|unauthori[sz]ed|forbidden|missing.*key|requires? (a|an) (api )?key|not authenticated/i.test(m)) return 'needs key'
  if (/\b429\b|rate limit|too many requests/i.test(m)) return 'rate limited'
  if (/OpenBB 404|HTTP 404|\b404\b/.test(m)) return 'not found'
  if (/OpenBB 422|\b422\b|ParamError|is required|not in |unknown param|validation error/i.test(m)) return 'bad params'
  if (/OpenBB 500|\b500\b/.test(m)) return 'provider error'
  if (/OpenBB 5\d\d|HTTP 5\d\d/.test(m)) return 'http 5xx'
  if (/OpenBB 4\d\d|HTTP 4\d\d/.test(m)) return 'http 4xx'
  if (/no results field|non-JSON|not an OpenAPI/i.test(m)) return 'no envelope'
  if (/returned no |no data|empty/i.test(m)) return 'empty'
  return 'other'
}

export type ProbeResult = LivenessRow & {
  params: Record<string, unknown>
  /** The provider that answered (or was tried last), when the route has providers. */
  provider?: string
  errorClass?: ErrorClass
  /** Set when the route was not called: no sample params. */
  skipped?: string
  /** Set when the recorded result came from the quiet retry pass. */
  retried?: 'timeout'
}

export type ProbeOptions = {
  concurrency?: number
  /** Only these connectors (default: every connector in the catalog). */
  connectors?: string[]
  /** Only routes this predicate keeps. */
  match?: (d: Descriptor) => boolean
  /** Stop after this many routes (for a quick run). */
  limit?: number
  /** Per-call timeout. */
  timeoutMs?: number
  now?: () => number
  /** Record results here as well as on the catalog. */
  store?: LivenessStore
  /** Retry a `needs key` failure with the route's keyless providers (OpenBB). On by default. */
  keylessRetry?: boolean
  /** When a connector is down, poll its health this often and for this long before giving up on it. */
  downPollMs?: number
  downWaitMs?: number
  /**
   * Try routes that timed out once more at the end, two at a time, when the connector is no longer under the
   * main pass's load. On by default: OpenBB serves blocking provider calls on one event loop, so a route that
   * timed out behind a slow neighbour is usually alive.
   */
  retryTimeouts?: boolean
  log?: (msg: string) => void
  onResult?: (r: ProbeResult) => void
}

export type ProbeSummary = {
  total: number
  called: number
  ok: number
  failed: number
  skipped: number
  /** Routes that answered with zero rows (counted in `ok`). */
  empty: number
  /** Routes that answered only after a keyless-provider retry. */
  keylessRetries: number
  /** Routes that timed out in the main pass and answered on the quiet retry. */
  timeoutRetries: number
  byConnector: Record<string, { routes: number; ok: number; failed: number; skipped: number }>
  byNamespace: Record<string, { routes: number; ok: number }>
  errorClasses: Array<{ errorClass: ErrorClass; count: number; examples: string[] }>
  ms: number
  results: ProbeResult[]
}

/** Keyless providers of a descriptor other than the one just tried, in retry order. */
export function keylessAlternatives(descriptor: Descriptor, tried: string | undefined): string[] {
  return KEYLESS_PROVIDERS.filter((p) => descriptor.providers.includes(p) && p !== tried)
}

async function callOnce(registry: ConnectorRegistry, d: Descriptor, params: Record<string, unknown>, timeoutMs: number): Promise<{ frame: Frame; ms: number } | { error: string; ms: number }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
  const t0 = performance.now()
  try {
    const frame = await registry.run({ connector: d.connector, route: d.route, params }, { signal: ac.signal, bypassCache: true })
    return { frame, ms: Math.round(performance.now() - t0) }
  } catch (err) {
    const reason = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err
    return { error: reason instanceof Error ? reason.message : String(reason), ms: Math.round(performance.now() - t0) }
  } finally {
    clearTimeout(timer)
  }
}

/** Probe one route: the default provider first, then the keyless alternatives when the default wants a key. */
export async function probeRoute(registry: ConnectorRegistry, d: Descriptor, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? 20_000
  const sample = sampleParams(d, now())
  if ('skip' in sample) return { ...livenessRow(d, { checkedAt: now(), ok: false, error: sample.skip }), params: {}, skipped: sample.skip }
  let params = sample.params
  let provider: string | undefined = typeof params.provider === 'string' ? params.provider : undefined
  let retried = false
  let last: { error: string; ms: number } | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await callOnce(registry, d, params, timeoutMs)
    if ('frame' in r) {
      const liveness = { checkedAt: now(), ok: true, rows: r.frame.rows.length, ms: r.ms, sampleColumns: r.frame.columns.slice(0, 8).map((c) => c.name) }
      const out: ProbeResult = { ...livenessRow(d, liveness), params }
      if (provider) out.provider = provider
      if (retried) out.errorClass = 'needs key' // what the default provider said; the row itself is ok
      return out
    }
    last = r
    const cls = classifyError(r.error)
    if (cls === 'down') break
    if (!(opts.keylessRetry ?? true) || cls !== 'needs key') break
    const next = keylessAlternatives(d, provider).find((p) => p !== provider && !(params.provider === p))
    if (!next) break
    retried = true
    provider = next
    params = { ...params, provider: next }
  }
  const error = last?.error ?? 'unknown failure'
  const out: ProbeResult = { ...livenessRow(d, { checkedAt: now(), ok: false, ms: last?.ms, error: error.slice(0, 300) }), params, errorClass: classifyError(error) }
  if (provider) out.provider = provider
  return out
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Probe every route of the catalog (or the selected ones), `concurrency` at a time, recording liveness on the
 * catalog and in the store. Skipped routes (no sample params) are left with unknown liveness so the agent can
 * still find them. A connector that goes down mid-run (the OpenBB process restarting) is not a thousand dead
 * routes: a `down` result is never recorded, the workers pause until the connector's health probe passes
 * (polling `downPollMs` for up to `downWaitMs`) and the route is tried again; if it never comes back the rest of
 * its routes are skipped as `connector down`.
 */
export async function probeCatalog(registry: ConnectorRegistry, catalog: Catalog, opts: ProbeOptions = {}): Promise<ProbeSummary> {
  const t0 = performance.now()
  const log = opts.log ?? (() => {})
  let targets = catalog.all().filter((d) => (!opts.connectors || opts.connectors.includes(d.connector)) && (!opts.match || opts.match(d)))
  if (opts.limit !== undefined) targets = targets.slice(0, opts.limit)
  const concurrency = Math.max(1, opts.concurrency ?? PROBE_CONCURRENCY)
  const results: ProbeResult[] = new Array<ProbeResult>(targets.length)
  const queue = targets.map((_, i) => i)
  const dead = new Set<string>()
  const waits = new Map<string, Promise<boolean>>()
  let done = 0

  /** One shared wait per connector: poll its health until it answers or the budget runs out. */
  const waitFor = (connector: string): Promise<boolean> => {
    let w = waits.get(connector)
    if (!w) {
      w = (async () => {
        const poll = opts.downPollMs ?? 5_000
        const budget = opts.downWaitMs ?? 180_000
        const start = Date.now()
        log(`probe: ${connector} is down; waiting up to ${Math.round(budget / 1000)} s for it to come back`)
        for (;;) {
          await sleep(poll)
          const h = await registry.health(connector, { timeoutMs: Math.min(poll, 5_000) })
          if (h.ok) {
            log(`probe: ${connector} is back`)
            waits.delete(connector)
            return true
          }
          if (Date.now() - start >= budget) {
            log(`probe: ${connector} did not come back; skipping its remaining routes`)
            dead.add(connector)
            return false
          }
        }
      })()
      waits.set(connector, w)
    }
    return w
  }

  const finish = (i: number, r: ProbeResult) => {
    results[i] = r
    done++
    if (!r.skipped) catalog.setLiveness(targets[i]!, livenessOf(toRow(r)))
    opts.onResult?.(r)
    if (done % 50 === 0 || done === targets.length) log(`probe: ${done}/${targets.length}`)
  }

  const worker = async () => {
    for (;;) {
      const i = queue.shift()
      if (i === undefined) return
      const d = targets[i]!
      if (dead.has(d.connector)) {
        finish(i, { ...livenessRow(d, { checkedAt: (opts.now ?? Date.now)(), ok: false, error: 'connector down' }), params: {}, skipped: 'connector down' })
        continue
      }
      const r = await probeRoute(registry, d, opts)
      if (r.errorClass === 'down' && !r.ok) {
        const back = await waitFor(d.connector)
        if (back) queue.unshift(i)
        else finish(i, { ...r, skipped: 'connector down' })
        continue
      }
      finish(i, r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))

  // The quiet pass: timeouts again, two at a time, now that nothing else is queued on the connector.
  let timeoutRetries = 0
  if (opts.retryTimeouts ?? true) {
    const again = results.map((r, i) => [r, i] as const).filter(([r]) => !r.ok && !r.skipped && r.errorClass === 'timeout' && !dead.has(r.connector)).map(([, i]) => i)
    if (again.length > 0) {
      log(`probe: retrying ${again.length} timed-out routes two at a time`)
      let n = 0
      const retry = async () => {
        for (;;) {
          const i = again[n++]
          if (i === undefined) return
          const d = targets[i]!
          const r = await probeRoute(registry, d, opts)
          if (r.errorClass === 'down' && !r.ok) continue // the connector went away again; the first result stands
          if (r.ok) timeoutRetries++
          results[i] = r.ok ? { ...r, retried: 'timeout' } : r
          if (!r.skipped) catalog.setLiveness(d, livenessOf(toRow(results[i]!)))
        }
      }
      await Promise.all([retry(), retry()])
    }
  }
  if (opts.store) await opts.store.put(results.filter((r) => !r.skipped).map(toRow))
  return summarize(results, Math.round(performance.now() - t0), timeoutRetries)
}

/** The liveness row of a result: the ref and the `Liveness` block, nothing the probe added for its summary. */
export function toRow(r: ProbeResult): LivenessRow {
  const row: LivenessRow = { connector: r.connector, route: r.route, checkedAt: r.checkedAt, ok: r.ok }
  if (r.rows !== undefined) row.rows = r.rows
  if (r.ms !== undefined) row.ms = r.ms
  if (r.error !== undefined) row.error = r.error
  if (r.sampleColumns !== undefined) row.sampleColumns = r.sampleColumns
  return row
}

export function summarize(results: ProbeResult[], ms: number, timeoutRetries = 0): ProbeSummary {
  const byConnector: ProbeSummary['byConnector'] = {}
  const byNamespace: ProbeSummary['byNamespace'] = {}
  const classes = new Map<ErrorClass, { count: number; examples: string[] }>()
  let ok = 0
  let failed = 0
  let skipped = 0
  let empty = 0
  let keylessRetries = 0
  for (const r of results) {
    const c = (byConnector[r.connector] ??= { routes: 0, ok: 0, failed: 0, skipped: 0 })
    c.routes++
    const ns = r.route.split('/')[0] ?? r.route
    const n = (byNamespace[ns] ??= { routes: 0, ok: 0 })
    n.routes++
    if (r.skipped) {
      skipped++
      c.skipped++
      continue
    }
    if (r.ok) {
      ok++
      c.ok++
      n.ok++
      if (r.rows === 0) empty++
      if (r.errorClass === 'needs key') keylessRetries++
    } else {
      failed++
      c.failed++
      const cls = r.errorClass ?? 'other'
      const e = classes.get(cls) ?? { count: 0, examples: [] }
      e.count++
      if (e.examples.length < 3) e.examples.push(`${r.connector}:${r.route}${r.provider ? ` (${r.provider})` : ''}: ${(r.error ?? '').slice(0, 120)}`)
      classes.set(cls, e)
    }
  }
  return {
    total: results.length,
    called: results.length - skipped,
    ok,
    failed,
    skipped,
    empty,
    keylessRetries,
    timeoutRetries,
    byConnector,
    byNamespace,
    errorClasses: [...classes.entries()].map(([errorClass, e]) => ({ errorClass, ...e })).sort((a, b) => b.count - a.count),
    ms,
    results,
  }
}

/** What (e)'s `POST /api/catalog/probe` calls: every route (or one connector's), liveness into the store, four numbers back. */
export type ProbeFn = (opts: { connector?: string; concurrency?: number; signal?: AbortSignal }) => Promise<{ probed: number; alive: number; dead: number; ms: number }>

/**
 * The probe as the server runs it in-process: over the registry's catalog, rows into the store and onto the
 * catalog, one run at a time (a second request while one runs gets the running one's result).
 */
export function createProbeFn(deps: { registry: ConnectorRegistry; store: LivenessStore; log?: (msg: string) => void; defaults?: Omit<ProbeOptions, 'connectors' | 'concurrency' | 'store' | 'log'> }): ProbeFn {
  let running: Promise<{ probed: number; alive: number; dead: number; ms: number }> | undefined
  return (opts) => {
    if (running) return running
    running = (async () => {
      const catalog = await deps.registry.catalog()
      const s = await probeCatalog(deps.registry, catalog, {
        ...(deps.defaults ?? {}),
        ...(opts.connector ? { connectors: [opts.connector] } : {}),
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
        store: deps.store,
        log: deps.log,
      })
      deps.log?.(renderSummary(s))
      return { probed: s.called, alive: s.ok, dead: s.failed, ms: s.ms }
    })().finally(() => {
      running = undefined
    })
    return running
  }
}

/** The summary as text for the terminal and the probe note. */
export function renderSummary(s: ProbeSummary): string {
  const lines: string[] = []
  lines.push(`${s.total} routes: ${s.ok} answered (${s.empty} with no rows), ${s.failed} failed, ${s.skipped} skipped (no sample params); ${s.keylessRetries} answered only on a keyless provider, ${s.timeoutRetries} only on the quiet retry; ${(s.ms / 1000).toFixed(1)} s`)
  for (const [name, c] of Object.entries(s.byConnector)) lines.push(`  ${name}: ${c.ok}/${c.routes} ok, ${c.failed} failed, ${c.skipped} skipped`)
  const ns = Object.entries(s.byNamespace).sort((a, b) => b[1].routes - a[1].routes)
  lines.push(`  by namespace: ${ns.map(([k, v]) => `${k} ${v.ok}/${v.routes}`).join(', ')}`)
  if (s.errorClasses.length) {
    lines.push('  error classes:')
    for (const e of s.errorClasses) {
      lines.push(`    ${e.errorClass}: ${e.count}`)
      for (const ex of e.examples) lines.push(`      ${ex}`)
    }
  }
  return lines.join('\n')
}
