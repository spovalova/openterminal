// One parity case end to end: shape the params exactly as the openbb connector does, ask the live OpenBB API and the
// native handler, compare. Recording captures the native side's upstream exchanges for the replay tests.
import { parseParams, type Descriptor, type ValidatedParams } from '@openterminal/core'
import { compareRows, jsonRows, type CompareResult } from '../compare.js'
import { createNativeCtx } from '../ctx.js'
import { applicableParams, nativeParams, toQuery, withProvider } from '../params.js'
import { recordingFetch, replayFetch, type Exchange } from '../record.js'
import { COMMANDS, nativeCommand, nativeHandler, nativeProvider, snapshotDescriptors } from '../index.js'
import type { NativeHandler, ProviderDef, Row } from '../types.js'
import type { Case } from './cases.js'
import type { Fixture } from './fixtures.js'

export const DEFAULT_OPENBB = 'http://127.0.0.1:6900'
/** A cold OpenBB route that sweeps a directory or a large archive can take minutes (federal_reserve state_average: 146 s). */
const OPENBB_TIMEOUT_MS = 300_000

export function descriptorOf(route: string): Descriptor | undefined {
  return snapshotDescriptors().find((d) => d.route === route)
}

/** A provider by name, or the command set (`commands`): the routes that take no provider. */
export function sourceDef(name: string): ProviderDef | undefined {
  return name === COMMANDS.name ? COMMANDS : nativeProvider(name)
}

function handlerFor(provider: string, route: string): NativeHandler | undefined {
  return provider === COMMANDS.name ? nativeCommand(route) : nativeHandler(route, provider)
}

/** Validate and shape a case's params for its provider, as the registry and the openbb connector would. */
export function shapeCase(provider: string, c: Pick<Case, 'route' | 'params'>): { descriptor: Descriptor; sent: ValidatedParams } {
  const descriptor = descriptorOf(c.route)
  if (!descriptor) throw new Error(`route ${c.route} is not in catalog/openbb.json`)
  if (provider === COMMANDS.name) {
    if (descriptor.providers.length) throw new Error(`route ${c.route} takes a provider (${descriptor.providers.join(', ')}); it is not a command`)
    return { descriptor, sent: parseParams(descriptor, c.params) }
  }
  if (!descriptor.providers.includes(provider)) throw new Error(`route ${c.route} does not list provider ${provider} (it has ${descriptor.providers.join(', ')})`)
  const validated = parseParams(descriptor, { ...c.params, provider })
  return { descriptor, sent: applicableParams(descriptor, withProvider(descriptor, validated)) }
}

/** OpenBB's `results` for a shaped call, or the error it gave. */
export async function askOpenbb(base: string, route: string, sent: ValidatedParams): Promise<{ rows: Row[] } | { error: string }> {
  const qs = new URLSearchParams(toQuery(sent)).toString()
  const url = `${base.replace(/\/+$/, '')}/api/v1/${route}${qs ? `?${qs}` : ''}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OPENBB_TIMEOUT_MS) })
    const text = await res.text()
    if (!res.ok) return { error: `OpenBB HTTP ${res.status}: ${text.slice(0, 300)}` }
    if (!text) return { rows: [] }
    const body = JSON.parse(text) as { results?: unknown }
    return { rows: jsonRows(body.results) }
  } catch (err) {
    return { error: `OpenBB request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export type NativeRunOptions = {
  fetch?: typeof fetch
  /** A replay passes a sleep that returns at once. */
  sleep?: (ms: number) => Promise<void>
  now?: Date
  env?: Record<string, string | undefined>
  log?: (msg: string) => void
}

/** Run the native handler for a provider and route on shaped params; rows as they would cross the API. */
export async function runNative(provider: string, route: string, sent: ValidatedParams, opts: NativeRunOptions = {}): Promise<Row[]> {
  const handler = handlerFor(provider, route)
  if (!handler) throw new Error(`${provider} has no native handler for ${route}`)
  const now = opts.now
  // A fresh cache per run: a recording must hold every download its replay asks for.
  const ctx = createNativeCtx({ cache: new Map(), ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.env ? { env: opts.env } : {}), ...(opts.log ? { log: opts.log } : {}), ...(now ? { now: () => new Date(now.getTime()) } : {}) })
  return jsonRows(await handler(nativeParams(sent), ctx))
}

export type CaseResult = {
  provider: string
  name: string
  route: string
  ok: boolean
  ms: number
  oracle: Case['oracle']
  compare?: CompareResult
  error?: string
  openbbError?: string
  fixture?: Fixture
}

/** The credential values a provider reads, from the environment, for redaction in recordings. */
export function secretsFor(provider: string, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of sourceDef(provider)?.credentials ?? []) {
    const v = env[name.toUpperCase()]
    if (v) out[name] = v
  }
  return out
}

/** Live: OpenBB and native side by side, recording the native exchanges. */
export async function runCaseLive(provider: string, c: Case, opts: { base?: string; env?: Record<string, string | undefined>; log?: (msg: string) => void } = {}): Promise<CaseResult> {
  const started = Date.now()
  const base = { provider, name: c.name, route: c.route, oracle: c.oracle }
  let sent: ValidatedParams
  try {
    sent = shapeCase(provider, c).sent
  } catch (err) {
    return { ...base, ok: false, ms: 0, error: err instanceof Error ? err.message : String(err) }
  }
  const env = opts.env ?? {}
  const recorder = recordingFetch(fetch, secretsFor(provider, env))
  const now = new Date()
  const [ob, nv] = await Promise.all([
    c.oracle === 'openbb' ? askOpenbb(opts.base ?? DEFAULT_OPENBB, c.route, sent) : Promise.resolve(undefined),
    runNative(provider, c.route, sent, { fetch: recorder.fetch, now, env, ...(opts.log ? { log: opts.log } : {}) }).then(
      (rows) => ({ rows }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    ),
  ])
  const ms = Date.now() - started
  if ('error' in nv) return { ...base, ok: false, ms, error: `native: ${nv.error}`, ...(ob && 'error' in ob ? { openbbError: ob.error } : {}) }
  const fixture: Fixture = { case: c.name, route: c.route, provider, params: nativeParams(sent), recordedAt: now.toISOString(), exchanges: recorder.exchanges as Exchange[], openbb: null, native: nv.rows }
  if (c.oracle === 'none') return { ...base, ok: nv.rows.length > 0, ms, ...(nv.rows.length ? {} : { error: 'native returned no rows' }), fixture }
  if (!ob || 'error' in ob) return { ...base, ok: false, ms, openbbError: ob?.error ?? 'no OpenBB answer', fixture }
  const compare = compareRows(ob.rows, nv.rows, c.compare)
  return { ...base, ok: compare.ok, ms, compare, fixture: { ...fixture, openbb: ob.rows } }
}

/** Offline: rerun the handler on a recording. Same native rows as recorded, and parity with OpenBB's recorded rows. */
export async function runCaseReplay(c: Case, f: Fixture): Promise<{ rows: Row[]; compare?: CompareResult }> {
  const sent = f.params as ValidatedParams
  const rows = await runNative(f.provider, c.route, sent, { fetch: replayFetch(f.exchanges), sleep: async () => {}, now: new Date(f.recordedAt), env: replayEnv(f.provider) })
  return { rows, ...(f.openbb ? { compare: compareRows(f.openbb, rows, c.compare) } : {}) }
}

/** Credentials as the recording redacted them, so replayed requests carry the same placeholders. */
function replayEnv(provider: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of sourceDef(provider)?.credentials ?? []) env[name.toUpperCase()] = `{{${name}}}`
  return env
}
