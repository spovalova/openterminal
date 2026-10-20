// Recorded cases: test/fixtures/<provider>/<case>.json.gz holds the upstream exchanges the native handler made, the
// rows OpenBB answered with at the same moment, and the native rows. The replay tests rerun the handler on the
// exchanges and require the same native rows and parity with OpenBB's. Response bodies are stored once per provider
// under bodies/<hash>.gz, so a symbol directory every case downloads is kept a single time.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Exchange } from '../record.js'
import type { Row } from '../types.js'
import { PACKAGE_DIR } from './cases.js'

/** One recorded response body, compressed. Larger ones: choose smaller params, or set `fixture: false` with a reason. */
export const MAX_BODY_BYTES = 768 * 1024
/** Every recording of one provider together, bodies included. */
export const MAX_PROVIDER_FIXTURE_BYTES = 8 * 1024 * 1024

type StoredExchange = Omit<Exchange, 'body'> & { bodyRef: string }
type StoredFixture = Omit<Fixture, 'exchanges'> & { exchanges: StoredExchange[] }

export type Fixture = {
  case: string
  route: string
  provider: string
  /** The params the handler got (shaped, without provider). */
  params: Record<string, unknown>
  /** ctx.now() during the recording; the replay runs at the same instant. */
  recordedAt: string
  exchanges: Exchange[]
  /** OpenBB's rows at record time; null for `oracle: none`. */
  openbb: Row[] | null
  native: Row[]
}

export function fixturePath(provider: string, name: string): URL {
  return new URL(`test/fixtures/${provider}/${name}.json.gz`, PACKAGE_DIR)
}

export function bodiesDir(provider: string): URL {
  return new URL(`test/fixtures/${provider}/bodies/`, PACKAGE_DIR)
}

export function hasFixture(provider: string, name: string): boolean {
  return existsSync(fixturePath(provider, name))
}

/** Compressed size of one recording without its shared bodies. */
export function fixtureBytes(provider: string, name: string): number {
  return hasFixture(provider, name) ? statSync(fixturePath(provider, name)).size : 0
}

/** Compressed size of everything recorded for a provider. */
export function providerFixtureBytes(provider: string): number {
  const dir = new URL(`test/fixtures/${provider}/`, PACKAGE_DIR)
  if (!existsSync(dir)) return 0
  let n = 0
  for (const f of readdirSync(dir)) if (f.endsWith('.json.gz')) n += statSync(new URL(f, dir)).size
  if (existsSync(bodiesDir(provider))) for (const f of readdirSync(bodiesDir(provider))) n += statSync(new URL(f, bodiesDir(provider))).size
  return n
}

function readStored(provider: string, name: string): StoredFixture {
  return JSON.parse(gunzipSync(readFileSync(fixturePath(provider, name))).toString('utf8')) as StoredFixture
}

export function readFixture(provider: string, name: string): Fixture {
  const stored = readStored(provider, name)
  const exchanges = stored.exchanges.map(({ bodyRef, ...e }) => ({ ...e, body: gunzipSync(readFileSync(new URL(`${bodyRef}.gz`, bodiesDir(provider)))).toString('utf8') }))
  return { ...stored, exchanges }
}

/** Write a recording and its bodies; returns the compressed bytes written. Refuses a body over MAX_BODY_BYTES. */
export function writeFixture(f: Fixture): number {
  mkdirSync(bodiesDir(f.provider), { recursive: true })
  let bytes = 0
  const exchanges: StoredExchange[] = f.exchanges.map(({ body, ...e }) => {
    const bodyRef = createHash('sha256').update(body).digest('hex').slice(0, 20)
    const path = new URL(`${bodyRef}.gz`, bodiesDir(f.provider))
    if (!existsSync(path)) {
      const gz = gzipSync(Buffer.from(body), { level: 9 })
      if (gz.length > MAX_BODY_BYTES) throw new Error(`a response in ${f.provider}/${f.case} (${e.url}) is ${(gz.length / 1024).toFixed(0)} KB compressed (max ${MAX_BODY_BYTES / 1024} KB): choose smaller params or set "fixture": false with a reason`)
      writeFileSync(path, gz)
      bytes += gz.length
    }
    return { ...e, bodyRef }
  })
  const gz = gzipSync(Buffer.from(JSON.stringify({ ...f, exchanges })), { level: 9 })
  writeFileSync(fixturePath(f.provider, f.case), gz)
  return bytes + gz.length
}

/** Body files no recording of the provider refers to any more. */
export function orphanBodies(provider: string): string[] {
  const dir = new URL(`test/fixtures/${provider}/`, PACKAGE_DIR)
  if (!existsSync(bodiesDir(provider))) return []
  const used = new Set<string>()
  for (const f of readdirSync(dir)) if (f.endsWith('.json.gz')) for (const e of readStored(provider, f.slice(0, -'.json.gz'.length)).exchanges) used.add(`${e.bodyRef}.gz`)
  return readdirSync(bodiesDir(provider)).filter((f) => !used.has(f))
}

/** Delete bodies nothing refers to; returns how many. */
export function pruneBodies(provider: string): number {
  const orphans = orphanBodies(provider)
  for (const f of orphans) rmSync(new URL(f, bodiesDir(provider)))
  return orphans.length
}
