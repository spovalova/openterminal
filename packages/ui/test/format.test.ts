import { describe, expect, it } from 'vitest'
import { formatCell, formatCompact, formatDuration, inferFormats, isNumericFormat, sortRows, direction } from '../src/format.js'

describe('formatCell', () => {
  it('renders empty values as a dash', () => {
    expect(formatCell(null, 'price')).toBe('—')
    expect(formatCell(undefined, 'text')).toBe('—')
    expect(formatCell('', 'link')).toBe('—')
    expect(formatCell(NaN, 'integer')).toBe('—')
  })
  it('price has two decimals and thousands separators', () => {
    expect(formatCell(1234.5, 'price')).toBe('1,234.50')
    expect(formatCell(0.005, 'price')).toBe('0.01')
  })
  it('percent is a plain level with two decimals, never signed', () => {
    expect(formatCell(36.9, 'percent')).toBe('36.90%')
    expect(formatCell(1.234, 'percent')).toBe('1.23%')
    expect(formatCell(-0.5, 'percent')).toBe('-0.50%')
    expect(formatCell(0, 'percent')).toBe('0.00%')
  })
  it('change is signed with two decimals', () => {
    expect(formatCell(1.234, 'change')).toBe('+1.23%')
    expect(formatCell(-0.5, 'change')).toBe('-0.50%')
    expect(formatCell(0, 'change')).toBe('0.00%')
  })
  it('compact scales to K, M, B, T with one decimal (two under ten)', () => {
    expect(formatCell(1_234_000_000, 'compact')).toBe('1.23B')
    expect(formatCell(45_600_000_000, 'compact')).toBe('45.6B')
    expect(formatCell(456_700_000, 'compact')).toBe('456.7M')
    expect(formatCell(12_340, 'compact')).toBe('12.3K')
    expect(formatCell(4_420_000_000_000, 'compact')).toBe('4.42T')
    expect(formatCell(-2_150_000_000, 'compact')).toBe('-2.15B')
    expect(formatCell(950, 'compact')).toBe('950')
    expect(formatCell(12.5, 'compact')).toBe('12.5')
    expect(formatCell(null, 'compact')).toBe('—')
    expect(formatCompact(NaN)).toBe('—')
    expect(isNumericFormat('compact')).toBe(true)
    expect(isNumericFormat('change')).toBe(true)
  })
  it('integer rounds and groups', () => {
    expect(formatCell(12345678.9, 'integer')).toBe('12,345,679')
  })
  it('time is HH:mm on the same local day, else a date', () => {
    const now = new Date(2026, 9, 16, 14, 30).getTime()
    const sameDay = new Date(2026, 9, 16, 9, 5).getTime()
    const other = new Date(2026, 9, 14, 9, 5).getTime()
    expect(formatCell(sameDay, 'time', now)).toBe('09:05')
    expect(formatCell(other, 'time', now)).toBe('2026-10-14')
  })
  it('date passes through and link shows the host', () => {
    expect(formatCell('2026-10-22', 'date')).toBe('2026-10-22')
    expect(formatCell('https://www.reuters.com/x/y', 'link')).toBe('reuters.com')
    expect(formatCell('not a url', 'link')).toBe('not a url')
  })
})

describe('direction', () => {
  it('classifies sign', () => {
    expect(direction(2)).toBe('up')
    expect(direction(-2)).toBe('down')
    expect(direction(0)).toBeNull()
    expect(direction(null)).toBeNull()
  })
})

describe('inferFormats', () => {
  it('maps the quote and news catalogs', () => {
    expect(
      inferFormats([
        { name: 'symbol', type: 'string' },
        { name: 'price', type: 'number' },
        { name: 'change_pct', type: 'number' },
        { name: 'volume', type: 'number' },
        { name: 'time', type: 'time' },
        { name: 'url', type: 'string' },
        { name: 'date', type: 'string' },
      ]),
    ).toEqual({ symbol: 'text', price: 'price', change_pct: 'change', volume: 'integer', time: 'time', url: 'link', date: 'date' })
  })
})

describe('sortRows', () => {
  const rows: unknown[][] = [
    ['b', 2],
    ['a', null],
    ['c', 1],
    ['d', 3],
  ]
  it('sorts numbers with nulls last in both directions', () => {
    expect(sortRows(rows, 1, 'asc').map((r) => r[0])).toEqual(['c', 'b', 'd', 'a'])
    expect(sortRows(rows, 1, 'desc').map((r) => r[0])).toEqual(['d', 'b', 'c', 'a'])
  })
  it('sorts strings and does not mutate input', () => {
    expect(sortRows(rows, 0, 'desc').map((r) => r[0])).toEqual(['d', 'c', 'b', 'a'])
    expect(rows[0]?.[0]).toBe('b')
  })
})

describe('formatDuration', () => {
  it('picks a unit', () => {
    expect(formatDuration(840)).toBe('840ms')
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(125_000)).toBe('2m 05s')
  })
})
