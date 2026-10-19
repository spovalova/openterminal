import { describe, expect, it } from 'vitest'
import { nyDate, nyMidnight, nyParts, utcDate } from '../src/time.js'

describe('New York clock helpers', () => {
  it('nyMidnight is DST aware', () => {
    expect(nyMidnight(2026, 7, 15).toISOString()).toBe('2026-07-15T04:00:00.000Z')
    expect(nyMidnight(2026, 1, 15).toISOString()).toBe('2026-01-15T05:00:00.000Z')
    // Spring forward (2026-03-08) and fall back (2026-11-01) days.
    expect(nyMidnight(2026, 3, 8).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(nyMidnight(2026, 11, 1).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(nyMidnight(2026, 11, 2).toISOString()).toBe('2026-11-02T05:00:00.000Z')
  })

  it('nyParts reports wall-clock time and weekday in New York', () => {
    expect(nyParts(new Date('2026-10-16T20:40:00.000Z'))).toEqual({ year: 2026, month: 10, day: 16, hour: 16, minute: 40, weekday: 5 })
    expect(nyParts(new Date('2026-10-17T03:30:00.000Z'))).toEqual({ year: 2026, month: 10, day: 16, hour: 23, minute: 30, weekday: 5 })
  })

  it('nyDate uses the New York calendar day', () => {
    expect(nyDate(new Date('2026-12-23T20:00:00.000Z'))).toBe('2026-12-23')
    expect(nyDate(new Date('2026-12-24T03:00:00.000Z'))).toBe('2026-12-23')
    expect(nyDate(new Date('2026-01-01T05:00:00.000Z'))).toBe('2026-01-01')
    expect(nyDate(new Date('2026-01-01T04:59:00.000Z'))).toBe('2025-12-31')
  })

  it('utcDate is the UTC calendar day of a 00:00Z stamp', () => {
    expect(utcDate(new Date('2026-10-23T00:00:00.000Z'))).toBe('2026-10-23')
    expect(nyDate(new Date('2026-10-23T00:00:00.000Z'))).toBe('2026-10-22')
  })
})
