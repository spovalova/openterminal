import { describe, expect, it } from 'vitest'
import { coerceCell, flattenRow, inferColumns, inferFrame, looksLikeDate, nyWallToUtc, parseTime } from '../src/index.js'

describe('parseTime', () => {
  it('reads OpenBB dates as New York midnight, zone-less datetimes as New York wall time, zoned ones as such', () => {
    expect(parseTime('2026-10-20')).toBe(nyWallToUtc(2026, 10, 20))
    expect(parseTime('2026-10-21T08:30:00')).toBe(nyWallToUtc(2026, 10, 21, 8, 30))
    expect(parseTime('2026-10-21 08:30')).toBe(nyWallToUtc(2026, 10, 21, 8, 30))
    expect(parseTime('2026-10-21T08:30:00Z')).toBe(Date.UTC(2026, 9, 21, 8, 30))
    expect(parseTime('2026-10-21T08:30:00+02:00')).toBe(Date.UTC(2026, 9, 21, 6, 30))
    expect(parseTime(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(parseTime(new Date(5))).toBe(5)
    expect(parseTime('yesterday')).toBeNull()
    expect(parseTime(null)).toBeNull()
    expect(looksLikeDate('2026-10-20')).toBe(true)
    expect(looksLikeDate('NVDA')).toBe(false)
  })
})

describe('flattenRow and coerceCell', () => {
  it('flattens one level with dotted names and joins scalar arrays', () => {
    expect(flattenRow({ a: 1, b: { c: 2, d: { e: 3 } }, tags: ['x', 'y'], objs: [{ k: 1 }], when: new Date(0) })).toEqual({ a: 1, 'b.c': 2, 'b.d': '{"e":3}', tags: 'x, y', objs: '[{"k":1}]', when: new Date(0) })
  })
  it('coerces cells to their column type and nulls what does not fit', () => {
    expect(coerceCell('12.5', 'number')).toBe(12.5)
    expect(coerceCell('abc', 'number')).toBeNull()
    expect(coerceCell(true, 'number')).toBe(1)
    expect(coerceCell('2026-10-20', 'time')).toBe(nyWallToUtc(2026, 10, 20))
    expect(coerceCell('true', 'boolean')).toBe(true)
    expect(coerceCell(0, 'boolean')).toBe(false)
    expect(coerceCell(12, 'string')).toBe('12')
    expect(coerceCell({ a: 1 }, 'string')).toBe('{"a":1}')
    expect(coerceCell(undefined, 'string')).toBeNull()
  })
})

describe('inferColumns and inferFrame', () => {
  const rows = [
    { symbol: 'NVDA', date: '2026-10-20', close: 180.5, note: null, extra: 'x', flag: true },
    { symbol: 'AMD', date: '2026-10-20', close: 150, note: 'n', extra: 'y', flag: false, only_here: 3 },
  ]
  it('puts descriptor fields first in descriptor order, then extra keys, typing dates as time', () => {
    const descriptor = { fields: [{ name: 'date', type: 'time' as const }, { name: 'symbol', type: 'string' as const }, { name: 'close', type: 'number' as const }, { name: 'missing', type: 'number' as const }] }
    expect(inferColumns(rows, { descriptor })).toEqual([
      { name: 'date', type: 'time' },
      { name: 'symbol', type: 'string' },
      { name: 'close', type: 'number' },
      { name: 'missing', type: 'number' },
      { name: 'note', type: 'string' },
      { name: 'extra', type: 'string' },
      { name: 'flag', type: 'boolean' },
      { name: 'only_here', type: 'number' },
    ])
    expect(inferColumns(rows, { descriptor, dropEmpty: true }).map((c) => c.name)).not.toContain('missing')
  })
  it('infers time when every value parses as a date and keeps string when one does not', () => {
    expect(inferColumns([{ d: '2026-10-20' }, { d: '2026-10-21T10:00:00' }, { d: null }])).toEqual([{ name: 'd', type: 'time' }])
    expect(inferColumns([{ d: '2026-10-20' }, { d: 'n/a' }])).toEqual([{ name: 'd', type: 'string' }])
    expect(inferColumns([{ d: null }])).toEqual([{ name: 'd', type: 'string' }])
  })
  it('restricts to `only` when given', () => {
    expect(inferColumns(rows, { only: ['close', 'symbol', 'ghost'] }).map((c) => c.name)).toEqual(['close', 'symbol'])
  })
  it('builds a frame with coerced cells and meta', () => {
    const f = inferFrame(rows, { connector: 'acme', ttl: 5 })
    expect(f.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['symbol:string', 'date:time', 'close:number', 'note:string', 'extra:string', 'flag:boolean', 'only_here:number'])
    expect(f.rows[0]).toEqual(['NVDA', nyWallToUtc(2026, 10, 20), 180.5, null, 'x', true, null])
    expect(f.meta).toMatchObject({ connector: 'acme', ttl: 5 })
    expect(typeof f.meta.fetchedAt).toBe('number')
  })
  it('handles nested provider rows (yahoo quoteSummary)', () => {
    const f = inferFrame([{ symbol: 'MU', financialData: { grossMargins: 0.43, targetMeanPrice: 200 }, price: { marketCap: 1e11 } }], { connector: 'yahoo' })
    expect(f.columns.map((c) => c.name)).toEqual(['symbol', 'financialData.grossMargins', 'financialData.targetMeanPrice', 'price.marketCap'])
    expect(f.rows[0]).toEqual(['MU', 0.43, 200, 1e11])
  })
})
