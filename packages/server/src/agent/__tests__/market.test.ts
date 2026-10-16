import { describe, expect, it } from 'vitest'
import { easternDate, easternParts, marketState } from '../market.js'

// 2026-10-16 is a Friday. EDT is UTC-4 in October.
const et = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 16, h + 4, m))

describe('marketState', () => {
  it('maps NYSE sessions in Eastern time', () => {
    expect(marketState(et(3, 59))).toBe('closed')
    expect(marketState(et(4, 0))).toBe('pre')
    expect(marketState(et(9, 29))).toBe('pre')
    expect(marketState(et(9, 30))).toBe('regular')
    expect(marketState(et(15, 59))).toBe('regular')
    expect(marketState(et(16, 0))).toBe('post')
    expect(marketState(et(19, 59))).toBe('post')
    expect(marketState(et(20, 0))).toBe('closed')
    expect(marketState(et(23, 30))).toBe('closed')
  })

  it('is closed on weekends', () => {
    expect(marketState(new Date(Date.UTC(2026, 9, 17, 15)))).toBe('closed') // Saturday 11:00 ET
    expect(marketState(new Date(Date.UTC(2026, 9, 18, 15)))).toBe('closed') // Sunday
    expect(marketState(new Date(Date.UTC(2026, 9, 19, 15)))).toBe('regular') // Monday
  })

  it('uses the Eastern calendar day, not UTC', () => {
    // 23:30 ET on Friday is 03:30 UTC Saturday.
    const p = easternParts(et(23, 30))
    expect(p.date).toBe('2026-10-16')
    expect(p.weekday).toBe(5)
    expect(p.time).toBe('23:30')
    expect(easternDate(et(23, 30), 60)).toBe('2026-12-15')
  })

  it('handles standard time after the DST change', () => {
    // 2026-11-02 is a Monday; EST is UTC-5, so 14:30 UTC is 09:30 ET.
    expect(marketState(new Date(Date.UTC(2026, 10, 2, 14, 29)))).toBe('pre')
    expect(marketState(new Date(Date.UTC(2026, 10, 2, 14, 30)))).toBe('regular')
  })
})
