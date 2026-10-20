import { describe, expect, it } from 'vitest'
import { chooseKeys, compareRows, jsonRows, sameValue } from '../src/compare.js'

describe('compareRows', () => {
  const ob = [
    { date: '2026-10-01', close: 354.11, volume: 31080774 },
    { date: '2026-10-02', close: 370.59, volume: 55330140 },
  ]

  it('passes identical rows, keyed by date', () => {
    const r = compareRows(ob, structuredClone(ob))
    expect(r.ok).toBe(true)
    expect(r.keys).toEqual(['date'])
    expect(r.cells).toBe(6)
  })

  it('reports a missing column, a wrong value and a missing row', () => {
    const r = compareRows(ob, [{ date: '2026-10-01', close: 354.12 }])
    expect(r.ok).toBe(false)
    expect(r.missingColumns).toEqual(['volume'])
    expect(r.problems.join(' ')).toMatch(/1 of OpenBB's 2 matched/)
    expect(r.mismatches.map((m) => m.column)).toContain('close')
  })

  it('treats a date and the same day at midnight as equal, and compares zoned instants', () => {
    expect(sameValue('2026-10-01', '2026-10-01T00:00:00', 1e-9, 0)).toBe(true)
    expect(sameValue('2026-10-01T13:30:00Z', '2026-10-01T09:30:00-04:00', 1e-9, 0)).toBe(true)
    expect(sameValue('2026-10-01T09:30:00', '2026-10-01T09:30:00Z', 1e-9, 0)).toBe(false)
  })

  it('accepts float noise but not real differences', () => {
    expect(sameValue(0.012159999999999999, 0.01216, 1e-9, 1e-12)).toBe(true)
    expect(sameValue(0.0121, 0.01216, 1e-9, 1e-12)).toBe(false)
  })

  it('checks volatile columns for presence only, or within liveTol', () => {
    const a = [{ symbol: 'TSLA', last_price: 373.9, name: 'TESLA' }]
    const b = [{ symbol: 'TSLA', last_price: 375.1, name: 'TESLA' }]
    expect(compareRows(a, b, { volatile: ['last_price'] }).ok).toBe(true)
    expect(compareRows(a, b, { volatile: ['last_price'], liveTol: 0.001 }).ok).toBe(false)
    expect(compareRows(a, [{ symbol: 'TSLA', name: 'TESLA' }], { volatile: ['last_price'] }).ok).toBe(false)
  })

  it('overlap mode compares the shared rows', () => {
    const native = [...ob, { date: '2026-10-05', close: 378.73, volume: 1 }]
    expect(compareRows(ob, native).ok).toBe(false)
    expect(compareRows(ob, native, { rows: 'overlap', minOverlap: 0.6 }).ok).toBe(true)
  })

  it('falls back to row order when nothing identifies a row', () => {
    expect(chooseKeys([{ a: 1 }, { a: 1 }])).toEqual([])
    expect(compareRows([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 2 }]).ok).toBe(true)
    expect(compareRows([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }]).ok).toBe(false)
  })

  it('jsonRows turns one object into a row and drops undefined', () => {
    expect(jsonRows({ a: 1, b: undefined })).toEqual([{ a: 1 }])
    expect(jsonRows(null)).toEqual([])
  })
})
