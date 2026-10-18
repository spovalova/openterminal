import { describe, expect, it } from 'vitest'
import { NYSE_HOLIDAYS, addDays, baselineFor, describeMarketTime, isTradingDay, lastTradingDay, lastWeek, nextTradingDay, nyDate, nyMidnight, nyWallToUtc, prevClose, previousTradingDay, rangeStart, sessionAt, sessionBounds, thisWeek, tradingDays, tradingDaysBack, weekdayLabel, type Frame } from '../src/index.js'

const et = (y: number, m: number, d: number, h = 0, min = 0) => nyWallToUtc(y, m, d, h, min)

describe('New York wall clock', () => {
  it('converts wall time to instants across DST', () => {
    expect(new Date(et(2026, 7, 1, 9, 30)).toISOString()).toBe('2026-07-01T13:30:00.000Z') // EDT
    expect(new Date(et(2026, 1, 2, 9, 30)).toISOString()).toBe('2026-01-02T14:30:00.000Z') // EST
    expect(nyDate(Date.UTC(2026, 9, 20, 2))).toBe('2026-10-19') // 22:00 ET the evening before
    expect(nyMidnight('2026-10-20')).toBe(et(2026, 10, 20))
    expect(weekdayLabel('2026-10-20')).toBe('Tue')
    expect(weekdayLabel(et(2026, 10, 18, 12))).toBe('Sun')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('NYSE calendar', () => {
  it('knows weekends and holidays through 2027', () => {
    expect(NYSE_HOLIDAYS.filter((d) => d.startsWith('2027'))).toHaveLength(10)
    expect(isTradingDay('2026-10-20')).toBe(true)
    expect(isTradingDay('2026-10-17')).toBe(false) // Saturday
    expect(isTradingDay('2026-11-26')).toBe(false) // Thanksgiving
    expect(isTradingDay('2026-07-03')).toBe(false) // Independence Day observed
    expect(isTradingDay('2027-12-24')).toBe(false) // Christmas observed
    expect(isTradingDay('2025-01-09')).toBe(false) // day of mourning
    expect(isTradingDay('2027-04-26')).toBe(true)
  })
  it('walks trading days', () => {
    expect(tradingDays('2026-11-23', '2026-11-29')).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'])
    expect(tradingDays('2026-10-20', '2026-10-19')).toEqual([])
    expect(previousTradingDay('2026-11-30')).toBe('2026-11-27')
    expect(previousTradingDay('2026-09-08')).toBe('2026-09-04') // over Labor Day
    expect(nextTradingDay('2026-12-24')).toBe('2026-12-28')
    expect(tradingDaysBack('2026-10-20', 5)).toBe('2026-10-13')
  })
})

describe('sessions', () => {
  it('classifies instants as pre, regular, post or closed in ET', () => {
    expect(sessionAt(et(2026, 10, 20, 8, 0))).toBe('pre')
    expect(sessionAt(et(2026, 10, 20, 9, 29))).toBe('pre')
    expect(sessionAt(et(2026, 10, 20, 9, 30))).toBe('regular')
    expect(sessionAt(et(2026, 10, 20, 15, 59))).toBe('regular')
    expect(sessionAt(et(2026, 10, 20, 16, 0))).toBe('post')
    expect(sessionAt(et(2026, 10, 20, 19, 59))).toBe('post')
    expect(sessionAt(et(2026, 10, 20, 20, 0))).toBe('closed')
    expect(sessionAt(et(2026, 10, 20, 3, 59))).toBe('closed')
    expect(sessionAt(et(2026, 10, 17, 12, 0))).toBe('closed') // Saturday
    expect(sessionAt(et(2026, 11, 26, 12, 0))).toBe('closed') // Thanksgiving
  })
  it('closes early at 13:00 on the day after Thanksgiving', () => {
    expect(sessionBounds('2026-11-27').early).toBe(true)
    expect(sessionAt(et(2026, 11, 27, 13, 30))).toBe('post')
    expect(sessionAt(et(2026, 11, 27, 12, 30))).toBe('regular')
    expect(sessionBounds('2026-10-20').early).toBe(false)
  })
  it('describes the market time for the prompt', () => {
    expect(describeMarketTime(et(2026, 10, 20, 14, 5))).toBe('Tuesday 2026-10-20 14:05 ET, regular session')
    expect(describeMarketTime(et(2026, 10, 18, 9, 0))).toBe('Sunday 2026-10-18 09:00 ET, market closed')
    expect(describeMarketTime(et(2026, 10, 20, 7, 0))).toMatch(/pre-market session/)
  })
})

describe('last trading day, last week, ranges and baselines', () => {
  it('lastTradingDay is today after the open, else the previous session', () => {
    expect(lastTradingDay(et(2026, 10, 20, 9, 29))).toBe('2026-10-19')
    expect(lastTradingDay(et(2026, 10, 20, 9, 30))).toBe('2026-10-20')
    expect(lastTradingDay(et(2026, 10, 18, 15, 0))).toBe('2026-10-16') // Sunday
    expect(lastTradingDay(et(2026, 11, 26, 15, 0))).toBe('2026-11-25') // Thanksgiving
  })
  it('lastWeek is the previous Monday to Friday, with its trading days', () => {
    expect(lastWeek(et(2026, 10, 20, 12))).toEqual({ start: '2026-10-12', end: '2026-10-16', days: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'] })
    expect(lastWeek(et(2026, 10, 19, 12)).start).toBe('2026-10-12') // Monday still points at last week
    expect(lastWeek(et(2026, 10, 18, 12)).start).toBe('2026-10-05') // Sunday belongs to the week of the 12th
    expect(lastWeek(et(2026, 11, 30, 12)).days).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'])
    expect(thisWeek(et(2026, 10, 20, 12))).toEqual({ start: '2026-10-19', end: '2026-10-23', days: ['2026-10-19', '2026-10-20'] })
  })
  it('rangeStart matches the connectors’ windows and baselineFor is the session before', () => {
    const now = et(2026, 10, 20, 15)
    expect(rangeStart('1d', now)).toBe('2026-10-20')
    expect(rangeStart('5d', now)).toBe('2026-10-13')
    expect(rangeStart('1mo', now)).toBe('2026-09-20')
    expect(rangeStart('3mo', now)).toBe('2026-07-20')
    expect(rangeStart('1y', now)).toBe('2025-10-20')
    expect(rangeStart('5y', now)).toBe('2021-10-20')
    expect(rangeStart('1mo', et(2026, 3, 31, 12))).toBe('2026-02-28')
    expect(baselineFor('1d', now)).toBe('2026-10-19')
    expect(baselineFor('1mo', now)).toBe('2026-09-18') // the 20th is a Sunday; the Friday before
    expect(baselineFor('1d', et(2026, 11, 27, 15))).toBe('2026-11-25')
  })
})

describe('prevClose', () => {
  const bars: Frame = {
    columns: [{ name: 'symbol', type: 'string' }, { name: 'time', type: 'time' }, { name: 'close', type: 'number' }],
    rows: [
      ['NVDA', et(2026, 10, 19, 15, 55), 180],
      ['NVDA', et(2026, 10, 19, 16, 0), 181],
      ['NVDA', et(2026, 10, 20, 9, 30), 179],
      ['NVDA', et(2026, 10, 20, 9, 35), 178],
      ['AMD', et(2026, 10, 20, 9, 30), 150],
    ],
    meta: { connector: 'x', fetchedAt: 0, ttl: 0 },
  }
  it('is the last close before the New York date of each group’s latest row', () => {
    expect(prevClose(bars)).toEqual({ NVDA: 181, AMD: null })
  })
  it('works on daily bars and on macro series frames', () => {
    const daily: Frame = { ...bars, rows: [['NVDA', et(2026, 10, 16), 170], ['NVDA', et(2026, 10, 19), 180], ['NVDA', et(2026, 10, 20), 179]] }
    expect(prevClose(daily)).toEqual({ NVDA: 180 })
    const macro: Frame = { columns: [{ name: 'series', type: 'string' }, { name: 'time', type: 'time' }, { name: 'value', type: 'number' }], rows: [['sofr', et(2026, 10, 19), 4.1], ['sofr', et(2026, 10, 20), 4.2]], meta: daily.meta }
    expect(prevClose(macro)).toEqual({ sofr: 4.1 })
    expect(prevClose({ ...macro, columns: [{ name: 'x', type: 'string' }] })).toEqual({})
  })
})
