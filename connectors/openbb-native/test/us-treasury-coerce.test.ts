// The pydantic-style coercions the us_treasury ports rely on (src/us_treasury/coerce.ts), pinned to what pydantic 2 does.
import { describe, expect, it } from 'vitest'
import { coerceValue, toCamel, validateModel } from '../src/us_treasury/coerce.js'
import { buildFilters, defaultStartDate, sortedDesc } from '../src/us_treasury/helpers.js'
import { createNativeCtx } from '../src/ctx.js'

describe('coerceValue', () => {
  it('reads ints and floats like pydantic lax mode', () => {
    expect(coerceValue('int', '123')).toBe(123)
    expect(coerceValue('int', '1.0')).toBe(1)
    expect(coerceValue('int', ' 12 ')).toBe(12)
    expect(() => coerceValue('int', '12.5')).toThrow()
    expect(() => coerceValue('int', '1e3')).toThrow()
    expect(coerceValue('float', '1e3')).toBe(1000)
    expect(coerceValue('float', '.5')).toBe(0.5)
    expect(() => coerceValue('float', '1,5')).toThrow()
    expect(() => coerceValue('float', '')).toThrow()
  })

  it('accepts a datetime string as a date only at midnight', () => {
    expect(coerceValue('date', '2026-10-20T00:00:00')).toBe('2026-10-20')
    expect(() => coerceValue('date', '2026-10-20T10:00:00')).toThrow()
    expect(() => coerceValue('date', '2026-02-30')).toThrow()
    expect(coerceValue('datetime', '2026-10-20T10:30:00.123')).toBe('2026-10-20T10:30:00.123000')
    expect(coerceValue('datetime', '2026-10-20T10:30:00Z')).toBe('2026-10-20T10:30:00+00:00')
  })

  it('reads booleans, Yes/No literals and strings', () => {
    expect(coerceValue('bool', 'Yes')).toBe(true)
    expect(coerceValue('bool', 'no')).toBe(false)
    expect(() => coerceValue('bool', '')).toThrow()
    expect(coerceValue('yesno', 'No')).toBe('No')
    expect(() => coerceValue('yesno', 'yes')).toThrow()
    expect(() => coerceValue('str', 5)).toThrow()
  })
})

describe('validateModel', () => {
  it('renames aliases and camel-case keys, keeps unknown keys, and drops missing values', () => {
    const row = validateModel({ issue_date: 'date!', interest_rate: 'float', price_per_100: 'float' }, { interest_rate: 'intRate' }, { issueDate: '2026-10-01T00:00:00', intRate: '0.5', pricePer100: '99.5', extraKey: 'x', gone: null }, 'Model')
    expect(row).toEqual({ issue_date: '2026-10-01', interest_rate: 0.5, price_per_100: 99.5, extraKey: 'x' })
  })

  it('requires the required fields', () => {
    expect(() => validateModel({ cusip: 'str!' }, {}, {}, 'Model')).toThrow(/Field required/)
  })

  it('matches pydantic to_camel', () => {
    expect(toCamel('price_per_100')).toBe('pricePer100')
    expect(toCamel('tint_cusip1_due_date')).toBe('tintCusip1DueDate')
    expect(toCamel('cusip')).toBe('cusip')
  })
})

describe('FiscalData helpers', () => {
  it('builds filters and the trailing default window from the injected clock', () => {
    expect(buildFilters([['record_date', 'gte', '2026-01-01'], ['record_date', 'lte', undefined]])).toBe('record_date:gte:2026-01-01')
    expect(buildFilters([['a', 'eq', undefined]])).toBeUndefined()
    const ctx = createNativeCtx({ now: () => new Date(2026, 9, 20, 12) })
    expect(defaultStartDate(undefined, undefined, 365, ctx)).toBe('2025-10-20')
    expect(defaultStartDate(undefined, '2026-03-01', 30, ctx)).toBe('2026-01-30')
    expect(defaultStartDate('2020-01-01', '2026-03-01', 30, ctx)).toBe('2020-01-01')
  })

  it('sorts descending with ties in their original order, as Python does', () => {
    const rows = [{ k: 'a', i: 1 }, { k: 'b', i: 2 }, { k: 'a', i: 3 }, { k: 'b', i: 4 }]
    expect(sortedDesc(rows, (r) => [r.k]).map((r) => r.i)).toEqual([2, 4, 1, 3])
  })
})
