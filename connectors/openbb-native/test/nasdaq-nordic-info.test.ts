// nasdaq/nordic/info mixes live quote rows with reference rows. Its parity cases can only type-check the live values
// (Nasdaq serves different snapshots from one request to the next, and OpenBB caches them), so this checks the rows that
// do not move, the Instrument block and the Profile block read from the Morningstar fact sheet, exactly, on the
// recordings: OpenBB's answer at record time against the native rows.
import { describe, expect, it } from 'vitest'
import { compareRows } from '../src/compare.js'
import { readFixture } from '../src/harness/fixtures.js'
import type { Row } from '../src/types.js'

const STABLE = new Set(['Instrument', 'Profile'])
// The market status follows the trading session, and OpenBB's copy can be up to 15 minutes older than the native one.
const stable = (rows: readonly Row[]): Row[] => rows.filter((r) => STABLE.has(String(r.category)) && r.label !== 'Market Status')

describe('nasdaq nordic info, rows that do not move', () => {
  for (const name of ['nordic-info-aak', 'nordic-info-arion', 'nordic-info-kpy', 'nordic-info-bond', 'nordic-info-fund']) {
    it(`${name}: the Instrument and Profile rows are OpenBB's, value for value (but the market status)`, () => {
      const f = readFixture('nasdaq', name)
      const result = compareRows(stable(f.openbb!), stable(f.native))
      expect(result.problems, JSON.stringify(result.mismatches.slice(0, 5))).toEqual([])
      expect(result.cells).toBeGreaterThan(0)
    })
  }

  it('a share carries the fact sheet as Profile rows, in every currency and exchange it is published for', () => {
    const profile = (name: string): Row[] => readFixture('nasdaq', name).native.filter((r) => r.category === 'Profile')
    for (const name of ['nordic-info-aak', 'nordic-info-arion']) {
      expect(profile(name).map((r) => r.label), name).toEqual(expect.arrayContaining(['Description', 'Website', 'Employees', 'Forwards', 'Futures']))
    }
  })

  it('a bond has no fact sheet, and neither does a First North Finland share: OpenBB looks for it on Stockholm for any exchange it cannot name', () => {
    for (const name of ['nordic-info-bond', 'nordic-info-kpy']) {
      const f = readFixture('nasdaq', name)
      expect(f.native.filter((r) => r.category === 'Profile'), name).toEqual([])
      expect(f.openbb!.filter((r) => r.category === 'Profile'), name).toEqual([])
    }
  })
})
