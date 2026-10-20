// Live parity: every case of the named providers against a running OpenBB API (default http://127.0.0.1:6900).
//   pnpm --filter @openterminal/openbb-native parity cboe finra [--route equity/price/quote] [--case name]
//        [--record] [--force] [--base URL] [--json report.json] [--concurrency 2] [--verbose]
// --record writes test/fixtures/<provider>/<case>.json.gz for every passing case (all cases with --force), which
// the replay tests then check offline. Credentials come from the environment (FRED_API_KEY, …). Exit 1 on a failure.
import { writeFileSync } from 'node:fs'
import { PROVIDERS } from '../src/index.js'
import { loadCases, type Case } from '../src/harness/cases.js'
import { pruneBodies, writeFixture } from '../src/harness/fixtures.js'
import { DEFAULT_OPENBB, runCaseLive, type CaseResult } from '../src/harness/run.js'

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const valued = new Set(['route', 'case', 'base', 'json', 'concurrency'])
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(argv[i - 1]!.replace(/^--/, ''))))
const names = positional.includes('all') ? PROVIDERS.map((p) => p.name) : positional
if (names.length === 0) {
  console.error('usage: parity <provider…|all> [--route R] [--case NAME] [--record] [--force] [--base URL] [--json FILE] [--concurrency N] [--verbose]')
  process.exit(2)
}
const unknown = names.filter((n) => !PROVIDERS.some((p) => p.name === n))
if (unknown.length) {
  console.error(`unknown provider(s): ${unknown.join(', ')}`)
  process.exit(2)
}

const base = option('base') ?? DEFAULT_OPENBB
const concurrency = Math.max(1, Number(option('concurrency') ?? 2))
const verbose = flag('verbose')
const jobs: { provider: string; c: Case }[] = []
for (const provider of names) {
  for (const c of loadCases(provider)) {
    if (option('route') && c.route !== option('route')) continue
    if (option('case') && c.name !== option('case')) continue
    jobs.push({ provider, c })
  }
}
if (jobs.length === 0) {
  console.error('no cases matched')
  process.exit(2)
}

const fmt = (r: CaseResult): string => {
  const head = `${r.ok ? '✓' : '✗'} ${r.provider}/${r.name}  ${r.route}  ${(r.ms / 1000).toFixed(1)}s`
  if (r.error || r.openbbError) return `${head}\n    ${[r.error, r.openbbError].filter(Boolean).join('\n    ')}`
  if (!r.compare) return `${head}  (oracle: none, ${r.fixture?.native.length ?? 0} rows)`
  const c = r.compare
  const line = `${head}  rows ${c.matchedRows}/${c.openbbRows} (native ${c.nativeRows})  cells ${c.cellMatches}/${c.cells}${c.extraColumns.length ? `  extra: ${c.extraColumns.join(',')}` : ''}`
  if (r.ok && !verbose) return line
  const detail = [...c.problems, ...c.mismatches.slice(0, verbose ? 25 : 8).map((m) => `${m.row} ${m.column}: openbb=${JSON.stringify(m.openbb)} native=${JSON.stringify(m.native)}`)]
  return `${line}\n    ${detail.join('\n    ')}`
}

const results: CaseResult[] = []
let next = 0
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const { provider, c } = jobs[next++]!
    const r = await runCaseLive(provider, c, { base, env: process.env, ...(verbose ? { log: (m: string) => console.error(`    [${provider}] ${m}`) } : {}) })
    if (flag('record') && r.fixture && c.fixture && (r.ok || flag('force'))) {
      try {
        const bytes = writeFixture(r.fixture)
        if (verbose) console.error(`    recorded ${(bytes / 1024).toFixed(1)} KB`)
      } catch (err) {
        r.ok = false
        r.error = [r.error, err instanceof Error ? err.message : String(err)].filter(Boolean).join('; ')
      }
    }
    results.push(r)
    console.log(fmt(r))
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
if (flag('record')) for (const provider of names) {
  const pruned = pruneBodies(provider)
  if (pruned) console.log(`pruned ${pruned} unused recorded bodies of ${provider}`)
}

const failed = results.filter((r) => !r.ok)
const openbbDown = results.filter((r) => r.openbbError && !r.error)
console.log(`\n${results.length} cases: ${results.length - failed.length} passed, ${failed.length} failed${openbbDown.length ? ` (${openbbDown.length} because OpenBB itself errored: consider oracle "none" with a reason)` : ''}`)
const out = option('json')
if (out) {
  writeFileSync(out, JSON.stringify(results.map(({ fixture: _f, ...r }) => r), null, 2))
  console.log(`report: ${out}`)
}
process.exit(failed.length ? 1 : 0)
