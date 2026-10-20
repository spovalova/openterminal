// Porting progress per provider: catalog routes, ported, skipped, cases, recordings.
//   pnpm --filter @openterminal/openbb-native coverage [--json FILE]
import { writeFileSync } from 'node:fs'
import { PROVIDERS, snapshotDescriptors } from '../src/index.js'
import { loadCases } from '../src/harness/cases.js'
import { hasFixture, providerFixtureBytes } from '../src/harness/fixtures.js'

const rows = PROVIDERS.map((p) => {
  const catalog = snapshotDescriptors().filter((d) => d.providers.includes(p.name)).map((d) => d.route)
  const ported = Object.keys(p.routes).length
  const skipped = Object.keys(p.skipped ?? {}).length
  const cases = loadCases(p.name)
  const recorded = cases.filter((c) => hasFixture(p.name, c.name))
  const kb = providerFixtureBytes(p.name) / 1024
  return { provider: p.name, status: p.status, catalog: catalog.length, ported, skipped, todo: catalog.length - ported - skipped, cases: cases.length, unverified: cases.filter((c) => c.oracle === 'none').length, recorded: recorded.length, kb: Math.round(kb) }
})
const total = rows.reduce((t, r) => ({ catalog: t.catalog + r.catalog, ported: t.ported + r.ported, skipped: t.skipped + r.skipped, cases: t.cases + r.cases }), { catalog: 0, ported: 0, skipped: 0, cases: 0 })
const pad = (s: string | number, n: number) => String(s).padStart(n)
console.log(`${'provider'.padEnd(16)}${pad('status', 8)}${pad('routes', 8)}${pad('ported', 8)}${pad('skipped', 9)}${pad('todo', 6)}${pad('cases', 7)}${pad('no-oracle', 11)}${pad('recorded', 10)}${pad('KB', 6)}`)
for (const r of rows) console.log(`${r.provider.padEnd(16)}${pad(r.status, 8)}${pad(r.catalog, 8)}${pad(r.ported, 8)}${pad(r.skipped, 9)}${pad(r.todo, 6)}${pad(r.cases, 7)}${pad(r.unverified, 11)}${pad(r.recorded, 10)}${pad(r.kb, 6)}`)
console.log(`\n${total.ported} of ${total.catalog} route-provider pairs ported, ${total.skipped} skipped, ${total.cases} cases`)
const at = process.argv.indexOf('--json')
if (at >= 0 && process.argv[at + 1]) writeFileSync(process.argv[at + 1]!, JSON.stringify(rows, null, 2))
