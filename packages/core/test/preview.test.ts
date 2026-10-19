import { describe, expect, it } from 'vitest'
import { preview } from '../src/index.js'

const OHLCV_COLUMNS = [{ name: 'symbol', type: 'string' }, { name: 'time', type: 'time' }, { name: 'open', type: 'number' }, { name: 'high', type: 'number' }, { name: 'low', type: 'number' }, { name: 'close', type: 'number' }, { name: 'volume', type: 'number' }] as const
/** A price frame from row objects, in the ohlcv recipe's column order; missing fields are null. */
function ohlcvFrame(rows: Record<string, unknown>[]) {
  return { columns: OHLCV_COLUMNS.map((c) => ({ ...c })), rows: rows.map((r) => OHLCV_COLUMNS.map((c) => (r[c.name] === undefined ? null : r[c.name]))), meta: { connector: 'test', fetchedAt: 0, ttl: 60_000 } }
}

describe('preview', () => {
  const bars = (symbol: string, closes: number[]) =>
    closes.map((c, i) => ({ symbol, time: 1_000 + i * 60_000, open: c, high: c + 1, low: c - 1, close: c, volume: 100 }))

  it('returns every row for small frames and stats per symbol', () => {
    const f = ohlcvFrame([...bars('MU', [100, 110, 120]), ...bars('WDC', [50, 45])])
    const p = preview(f)
    expect(p.rowCount).toBe(5)
    expect(p.rows).toHaveLength(5)
    expect(p.stats.MU!.close).toEqual({ first: 100, last: 120, min: 100, max: 120, change: 20, changePct: 20 })
    expect(p.stats.WDC!.close).toEqual({ first: 50, last: 45, min: 45, max: 50, change: -5, changePct: -10 })
    expect(p.stats.MU!.time).toBeUndefined()
    expect(p.stats.MU!.volume).toBeDefined()
  })

  it('truncates rows past the limit but keeps stats over the whole frame', () => {
    const f = ohlcvFrame(bars('MU', Array.from({ length: 100 }, (_, i) => 100 + i)))
    const p = preview(f)
    expect(p.rowCount).toBe(100)
    expect(p.rows).toHaveLength(25)
    expect(p.stats.MU!.close!.last).toBe(199)
  })

  it('sorts by time before computing first and last', () => {
    const f = ohlcvFrame([...bars('MU', [120]).map((b) => ({ ...b, time: 3 })), ...bars('MU', [100]).map((b) => ({ ...b, time: 1 }))])
    expect(preview(f).stats.MU!.close).toMatchObject({ first: 100, last: 120, changePct: 20 })
  })

  it('uses * when there is no symbol column and ignores nulls', () => {
    const f = { columns: [{ name: 'x', type: 'number' as const }], rows: [[null], [2], [4]], meta: { connector: 't', fetchedAt: 0, ttl: 0 } }
    expect(preview(f).stats['*']!.x).toEqual({ first: 2, last: 4, min: 2, max: 4, change: 2, changePct: 100 })
  })

  it('gives null changePct when first is zero', () => {
    const f = { columns: [{ name: 'x', type: 'number' as const }], rows: [[0], [4]], meta: { connector: 't', fetchedAt: 0, ttl: 0 } }
    expect(preview(f).stats['*']!.x!.changePct).toBeNull()
  })
})
