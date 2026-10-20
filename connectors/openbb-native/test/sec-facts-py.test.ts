// The Python behaviours the sec statement engine relies on (src/sec/facts/py.ts), against values Python 3.12 gives.
import { describe, expect, it } from 'vitest'
import { addDays, dateParts, dayNum, decimalDifference, isclose, median, pyRound, pySplitlines, pyStrip, spaceCollapse } from '../src/sec/facts/py.js'

describe('sec facts: python helpers', () => {
  it('rounds like round(): ties to even, exact binary value otherwise', () => {
    expect(pyRound(2.5)).toBe(2)
    expect(pyRound(3.5)).toBe(4)
    expect(pyRound(-1.5)).toBe(-2)
    expect(pyRound(0.125, 2)).toBe(0.12)
    expect(pyRound(2.675, 2)).toBe(2.67)
    expect(pyRound(1234.5678, 2)).toBe(1234.57)
    expect(pyRound(-0.4)).toBe(0)
    expect(pyRound(0.03125, 4)).toBe(0.0312)
    expect(pyRound(15_000_000.6)).toBe(15_000_001)
  })

  it('subtracts decimals exactly', () => {
    expect(decimalDifference(1.1, [0.1, 0.2])).toBe(0.8)
    expect(decimalDifference(0.3, [0.1, 0.1, 0.1])).toBe(0)
    expect(decimalDifference(5, [1.25, 1.25])).toBe(2.5)
  })

  it('compares floats like math.isclose and takes medians like statistics.median', () => {
    expect(isclose(1000, 1000.9, 1e-3)).toBe(true)
    expect(isclose(1000, 1002, 1e-3)).toBe(false)
    expect(isclose(0, 0.5, 1e-5, 1.0)).toBe(true)
    expect(median([3, 1, 2, 4])).toBe(2.5)
    expect(median([5, 1, 9])).toBe(5)
  })

  it('reads and shifts dates like datetime', () => {
    expect(dayNum('2024-02-30')).toBeNull()
    expect(dayNum('2024-13-01')).toBeNull()
    expect(dayNum('2024-02-29')! - dayNum('2023-02-28')!).toBe(366)
    expect(addDays('2024-03-01', -45)).toBe('2024-01-16')
    expect(dateParts('2023-12-31')).toEqual({ year: 2023, month: 12, day: 31 })
  })

  it('strips and splits like str', () => {
    expect(pyStrip('  x  ')).toBe('x')
    expect(pyStrip('﻿x')).toBe('﻿x')
    expect(spaceCollapse('a  \n b')).toBe('a b')
    expect(pySplitlines('a\nb\r\nc\n')).toEqual(['a', 'b', 'c'])
    expect(pySplitlines('')).toEqual([])
  })
})
