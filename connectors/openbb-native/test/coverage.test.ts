// The porting rules every provider follows (README.md): routes the catalog lists, a parity case per route, a
// recording per case, no hidden clocks or network, and completeness once a provider says it is ported.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROVIDERS, snapshotDescriptors } from '../src/index.js'
import { loadCases, PACKAGE_DIR } from '../src/harness/cases.js'
import { hasFixture, MAX_PROVIDER_FIXTURE_BYTES, orphanBodies, providerFixtureBytes } from '../src/harness/fixtures.js'

const catalog = snapshotDescriptors()
const catalogProviders = new Set(catalog.flatMap((d) => d.providers))
const routesOf = (provider: string) => new Set(catalog.filter((d) => d.providers.includes(provider)).map((d) => d.route))

function sources(dir: URL): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir)
    if (statSync(url).isDirectory()) out.push(...sources(new URL(`${name}/`, dir)))
    else if (name.endsWith('.ts')) out.push(url.pathname)
  }
  return out
}

describe('providers', () => {
  it('has one module per catalog provider, named as OpenBB names it', () => {
    expect(PROVIDERS.map((p) => p.name).sort()).toEqual([...catalogProviders].sort())
  })

  for (const p of PROVIDERS) {
    describe(p.name, () => {
      const routes = routesOf(p.name)
      const cases = loadCases(p.name)

      it('answers only routes the catalog lists for it', () => {
        for (const r of [...Object.keys(p.routes), ...Object.keys(p.skipped ?? {})]) expect(routes.has(r), `${r} is not a ${p.name} route in catalog/openbb.json`).toBe(true)
      })

      it('has a parity case for every ported route, and only for ported routes', () => {
        for (const r of Object.keys(p.routes)) expect(cases.some((c) => c.route === r), `no case in src/${p.name}/cases.json for ${r}`).toBe(true)
        for (const c of cases) expect(r(p.routes, c.route), `case ${c.name}: ${c.route} is not ported`).toBe(true)
      })

      it('has a recording for every case that keeps one, within the size budget', () => {
        for (const c of cases) if (c.fixture) expect(hasFixture(p.name, c.name), `no recording for ${p.name}/${c.name}: run parity ${p.name} --record`).toBe(true)
        expect(orphanBodies(p.name), 'recorded bodies no case uses (parity --record prunes them)').toEqual([])
        expect(providerFixtureBytes(p.name)).toBeLessThanOrEqual(MAX_PROVIDER_FIXTURE_BYTES)
      })

      it('reads the clock, the network and credentials only through ctx', () => {
        for (const file of sources(new URL(`src/${p.name}/`, PACKAGE_DIR))) {
          const text = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
          const rel = file.slice(file.indexOf('/src/'))
          expect(text, `${rel}: use ctx.now()`).not.toMatch(/\bDate\.now\(|\bnew Date\(\s*\)/)
          expect(text, `${rel}: use ctx.credential()`).not.toMatch(/process\.env/)
          expect(text, `${rel}: use ctx.http`).not.toMatch(/(^|[^.\w])fetch\(/m)
        }
      })

      if (p.status === 'ported') {
        it('ports or skips, with a reason, every route the catalog lists for it', () => {
          const done = new Set([...Object.keys(p.routes), ...Object.keys(p.skipped ?? {})])
          expect([...routes].filter((r) => !done.has(r)).sort()).toEqual([])
          for (const [r, why] of Object.entries(p.skipped ?? {})) expect(why.length, `skipped ${r} needs a reason`).toBeGreaterThan(10)
        })
      }
    })
  }
})

function r(routes: Record<string, unknown>, route: string): boolean {
  return Object.prototype.hasOwnProperty.call(routes, route)
}
