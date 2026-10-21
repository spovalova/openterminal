// Every recorded case, offline: the native handler rerun on its recorded upstream responses must give the same rows
// as when it was recorded, and those rows must still match what OpenBB answered at that moment.
import { describe, expect, it } from 'vitest'
import { COMMANDS, PROVIDERS } from '../src/index.js'
import { loadCases } from '../src/harness/cases.js'
import { hasFixture, readFixture } from '../src/harness/fixtures.js'
import { runCaseReplay } from '../src/harness/run.js'

for (const provider of [...PROVIDERS, COMMANDS]) {
  const cases = loadCases(provider.name).filter((c) => c.fixture && hasFixture(provider.name, c.name))
  if (cases.length === 0) continue
  describe(`replay ${provider.name}`, () => {
    for (const c of cases) {
      it(`${c.name} (${c.route})`, async () => {
        const f = readFixture(provider.name, c.name)
        const { rows, compare } = await runCaseReplay(c, f)
        expect(rows).toEqual(f.native)
        if (compare) expect(compare.problems, JSON.stringify(compare.mismatches.slice(0, 5))).toEqual([])
      })
    }
  })
}
