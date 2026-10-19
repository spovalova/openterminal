// OpenBB descriptors (PLAN.md section 17): generated from the live `/openapi.json` with core's
// `descriptorsFromOpenApi`, cached on disk per OpenBB document, served from the cache when the API is down.
//
// The cache key is the document's `info.version` plus a fingerprint of its route and model names: OpenBB 5
// reports `info.version: "1"` for every release, so the version alone never changes, while installing a
// provider extension (`pip install openbb-fmp`) adds routes and schemas and must regenerate. The cache row has
// the shape (e)'s store keeps per connector: `{ connector, version, descriptors, generatedAt }` plus the fingerprint.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHttp, descriptorsFromOpenApi, parseDescriptors, type Ctx, type Descriptor, type OpenApiDoc } from '@openterminal/core'
import { ConfigSchema, DEFAULT_BASE_URL, authHeaders, isConnectionFailure, isDown, markDown, markUp, notRunning, type Config } from './openbb-api.js'

export const CATALOG_FILE = 'openbb.json'
/** Fetching and parsing the 8.5 MB document takes well under a second locally; a slow machine gets this long. */
export const OPENAPI_TIMEOUT_MS = 20_000

export type CatalogCache = {
  connector: 'openbb'
  /** OpenBB's `info.version` ("1" on OpenBB 5). */
  version: string
  /** Hash of the document's GET paths and schema names; changes when an extension is installed or OpenBB upgraded. */
  fingerprint: string
  baseUrl: string
  generatedAt: number
  descriptors: Descriptor[]
}

/** `$TERMINAL_HOME/catalog/openbb.json`, or `~/.terminal/catalog/openbb.json`. */
export function defaultCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TERMINAL_HOME?.trim()
  return join(home && home.length > 0 ? home : join(homedir(), '.terminal'), 'catalog', CATALOG_FILE)
}

/** The cache key of an OpenAPI document: its version and a hash of what the generator reads. */
export function fingerprintOpenApi(doc: OpenApiDoc): { version: string; fingerprint: string } {
  const version = String(doc.info?.version ?? '')
  const paths = Object.entries(doc.paths ?? {})
    .filter(([, methods]) => methods && typeof methods === 'object' && 'get' in methods)
    .map(([p]) => p)
    .sort()
  const schemas = Object.keys(doc.components?.schemas ?? {}).sort()
  const h = createHash('sha1')
  h.update(version)
  h.update('\n')
  h.update(paths.join('\n'))
  h.update('\n')
  h.update(schemas.join('\n'))
  return { version, fingerprint: h.digest('hex').slice(0, 16) }
}

export function readCatalogCache(path: string): CatalogCache | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as Partial<CatalogCache>
  if (c.connector !== 'openbb' || typeof c.fingerprint !== 'string' || !Array.isArray(c.descriptors)) return undefined
  try {
    return { connector: 'openbb', version: String(c.version ?? ''), fingerprint: c.fingerprint, baseUrl: String(c.baseUrl ?? ''), generatedAt: Number(c.generatedAt ?? 0), descriptors: parseDescriptors(c.descriptors) }
  } catch {
    return undefined
  }
}

export function writeCatalogCache(path: string, cache: CatalogCache): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache), 'utf8')
  renameSync(tmp, path)
}

export type LoadOptions = {
  /** Where the cache lives; defaults to `$TERMINAL_HOME/catalog/openbb.json`. */
  catalogPath?: string
  now?: () => number
  timeoutMs?: number
}

export type LoadResult = {
  descriptors: Descriptor[]
  /** `generated` from a fresh document, `cached` when the document matched the cache or the API was down, `none` when neither was available. */
  source: 'generated' | 'cached' | 'none'
  version?: string
  fingerprint?: string
  error?: string
}

/** A ctx for callers that have none (a connector's `descriptors()` called without the registry): default config, the plain fetch. */
export function defaultCtx(): Ctx<Config> {
  return { http: createHttp(), config: ConfigSchema.parse({ baseUrl: DEFAULT_BASE_URL }), log: () => {} }
}

/**
 * Fetch `${baseUrl}/openapi.json`, compare it with the cache, regenerate when it changed, and fall back to the
 * cache (or nothing) when the API is down. Breaker-aware: an open breaker skips the fetch; a connection failure
 * trips it, so the registry's first calls fail fast like the kind handlers do.
 */
export async function loadDescriptors(ctx: Ctx<Config> = defaultCtx(), opts: LoadOptions = {}): Promise<LoadResult> {
  const path = opts.catalogPath ?? defaultCatalogPath()
  const now = opts.now ?? Date.now
  const { baseUrl } = ctx.config
  const cached = readCatalogCache(path)
  const fallback = (error: string): LoadResult => {
    if (cached) {
      ctx.log(`${error}; serving ${cached.descriptors.length} cached descriptors from ${path}`)
      return { descriptors: cached.descriptors, source: 'cached', version: cached.version, fingerprint: cached.fingerprint, error }
    }
    ctx.log(`${error}; no cached catalog at ${path}`)
    return { descriptors: [], source: 'none', error }
  }
  if (isDown(now())) return fallback(notRunning(baseUrl))

  let doc: unknown
  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? OPENAPI_TIMEOUT_MS)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
    doc = await ctx.http.get(`${baseUrl.replace(/\/+$/, '')}/openapi.json`, { signal, headers: authHeaders(ctx.config) })
  } catch (err) {
    if (isConnectionFailure(err)) {
      markDown(now())
      return fallback(notRunning(baseUrl))
    }
    return fallback(`openapi.json failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  markUp()
  if (!doc || typeof doc !== 'object' || !('paths' in doc)) return fallback(`openapi.json at ${baseUrl} is not an OpenAPI document`)

  const { version, fingerprint } = fingerprintOpenApi(doc as OpenApiDoc)
  if (cached && cached.fingerprint === fingerprint) {
    return { descriptors: cached.descriptors, source: 'cached', version, fingerprint }
  }
  const descriptors = descriptorsFromOpenApi(doc, 'openbb')
  try {
    writeCatalogCache(path, { connector: 'openbb', version, fingerprint, baseUrl, generatedAt: now(), descriptors })
    ctx.log(`generated ${descriptors.length} descriptors from ${baseUrl}/openapi.json (fingerprint ${fingerprint}) into ${path}`)
  } catch (err) {
    ctx.log(`generated ${descriptors.length} descriptors but could not write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { descriptors, source: 'generated', version, fingerprint }
}

// ---- per-process memo, shared by descriptors() and call() ----

let memo: { baseUrl: string; promise: Promise<Descriptor[]> } | undefined

/** Forget the loaded descriptors (tests, or after the OpenBB side changed). */
export function resetDescriptors(): void {
  memo = undefined
}

/**
 * The connector's descriptors for a ctx, loaded once per process and base URL. A load that found nothing is not
 * memoised, so the next call tries the API again (it may have started since).
 */
export function descriptorsFor(ctx: Ctx<Config> = defaultCtx(), opts: LoadOptions = {}): Promise<Descriptor[]> {
  const { baseUrl } = ctx.config
  if (memo && memo.baseUrl === baseUrl) return memo.promise
  const promise = loadDescriptors(ctx, opts).then((r) => {
    if (r.descriptors.length === 0) memo = undefined
    return r.descriptors
  })
  memo = { baseUrl, promise }
  return promise
}

/** The descriptor of one route, or undefined when the catalog does not list it. */
export async function descriptorFor(ctx: Ctx<Config>, route: string, opts: LoadOptions = {}): Promise<Descriptor | undefined> {
  const all = await descriptorsFor(ctx, opts)
  return all.find((d) => d.route === route)
}
