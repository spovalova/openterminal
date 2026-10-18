import { describe, expect, it } from 'vitest'
import { defaultFormat, detectShape, displayUnit, keyField, mergeFieldConfig, orderByPriority, presetsFor, rolesFromShape, FieldConfigSchema, type Column } from '../src/index.js'

const col = (name: string, type: Column['type']): Column => ({ name, type })
const ohlcvCols = [col('symbol', 'string'), col('time', 'time'), col('open', 'number'), col('high', 'number'), col('low', 'number'), col('close', 'number'), col('volume', 'number')]
const bars = (syms: string[], n = 3) => syms.flatMap((s) => Array.from({ length: n }, (_, i) => [s, i * 86_400_000, 1, 2, 0.5, 1 + i, 100]))

describe('detectShape', () => {
  it('finds time, group, numeric and ohlc on a multi-symbol bar frame', () => {
    const s = detectShape(ohlcvCols, bars(['MU', 'WDC']))
    expect(s).toMatchObject({ time: 'time', group: 'symbol', numeric: ['open', 'high', 'low', 'close', 'volume'], options: false, oneRowPerGroup: false, x: 'time', xType: 'time', ohlc: true, groups: ['MU', 'WDC'] })
  })
  it('needs several distinct values for a group, except on a one-row frame', () => {
    const one = detectShape(ohlcvCols, bars(['MU']))
    expect(one.group).toBeUndefined()
    expect(one.oneRowPerGroup).toBe(false)
    const quote = detectShape([col('symbol', 'string'), col('price', 'number')], [['MU', 100]])
    expect(quote).toMatchObject({ group: 'symbol', oneRowPerGroup: true, numeric: ['price'] })
    const quotes = detectShape([col('symbol', 'string'), col('price', 'number')], [['MU', 100], ['WDC', 50]])
    expect(quotes.oneRowPerGroup).toBe(true)
    const dup = detectShape([col('symbol', 'string'), col('price', 'number')], [['MU', 100], ['MU', 50]])
    expect(dup.group).toBeUndefined()
  })
  it('tries series, ticker, cusip and name as group columns in that order', () => {
    expect(detectShape([col('series', 'string'), col('time', 'time'), col('value', 'number')], [['a', 1, 1], ['b', 1, 2]]).group).toBe('series')
    expect(detectShape([col('name', 'string'), col('cusip', 'string'), col('x', 'number')], [['A', '1', 1], ['B', '2', 2]]).group).toBe('cusip')
  })
  it('recognises an option chain and a numeric x-axis', () => {
    const chain = detectShape([col('strike', 'number'), col('expiration', 'string'), col('option_type', 'string'), col('iv', 'number')], [[100, '2026-11-20', 'call', 0.3]])
    expect(chain.options).toBe(true)
    expect(chain).toMatchObject({ x: 'strike', xType: 'number' })
    const curve = detectShape([col('maturity', 'string'), col('maturity_years', 'number'), col('rate', 'number')], [['1M', 0.08, 4.1], ['10Y', 10, 4.3]])
    expect(curve).toMatchObject({ x: 'maturity_years', xType: 'number', options: false })
    expect(detectShape([col('a', 'string'), col('b', 'number')], []).xType).toBeUndefined()
  })
  it('lists the presets each shape supports', () => {
    expect(presetsFor(detectShape(ohlcvCols, bars(['MU', 'WDC'])))).toEqual(['price', 'compare', 'indicator', 'table', 'heatmap'])
    expect(presetsFor(detectShape([col('symbol', 'string'), col('price', 'number')], [['MU', 1]]))).toEqual(['table', 'stat', 'facts', 'heatmap'])
    expect(presetsFor(detectShape([col('maturity_years', 'number'), col('rate', 'number')], [[1, 4], [10, 4.3]]))).toContain('curve')
    expect(presetsFor(detectShape([col('strike', 'number'), col('expiration', 'string'), col('type', 'string')], [[1, 'x', 'call']]))).toContain('chain')
  })
})

describe('field config', () => {
  it('derives roles from the shape', () => {
    const roles = rolesFromShape(detectShape(ohlcvCols, bars(['MU', 'WDC'])))
    expect(roles).toEqual({ symbol: 'group', time: 'time', open: 'measure', high: 'measure', low: 'measure', close: 'measure', volume: 'measure' })
    const curve = rolesFromShape(detectShape([col('maturity', 'string'), col('maturity_years', 'number'), col('rate', 'number')], [['1M', 0.08, 4.1], ['10Y', 10, 4.3]]))
    expect(curve).toEqual({ maturity: 'label', maturity_years: 'x', rate: 'measure' })
  })
  it('merges shape, annotations and overrides field by field, later layers winning', () => {
    const shape = detectShape(ohlcvCols, bars(['MU', 'WDC']))
    const merged = mergeFieldConfig(shape, { close: { unit: 'usd', label: 'Close', priority: 1 }, volume: { format: 'integer' } }, { close: { label: 'Last' }, pe: { unit: 'ratio', label: 'P/E (TTM)' } })
    expect(merged.close).toEqual({ role: 'measure', unit: 'usd', label: 'Last', priority: 1 })
    expect(merged.volume).toEqual({ role: 'measure', format: 'integer' })
    expect(merged.symbol).toEqual({ role: 'group' })
    expect(merged.pe).toEqual({ unit: 'ratio', label: 'P/E (TTM)' })
    expect(mergeFieldConfig(shape).time).toEqual({ role: 'time' })
  })
  it('validates field config and rejects unknown units, roles and long labels', () => {
    expect(FieldConfigSchema.parse({ unit: 'percent', role: 'measure', priority: 1, key: true })).toEqual({ unit: 'percent', role: 'measure', priority: 1, key: true })
    expect(() => FieldConfigSchema.parse({ unit: 'furlongs' })).toThrow()
    expect(() => FieldConfigSchema.parse({ role: 'axis' })).toThrow()
    expect(() => FieldConfigSchema.parse({ priority: 0 })).toThrow()
    expect(() => FieldConfigSchema.parse({ label: 'x'.repeat(41) })).toThrow()
  })
  it('picks default formats from the unit and the key field from `key` or the first measure', () => {
    expect(displayUnit('fraction')).toBe('percent')
    expect(displayUnit('usd')).toBe('usd')
    expect(defaultFormat({ unit: 'percent' }, 'number')).toBe('percent')
    expect(defaultFormat({ unit: 'usd' }, 'number')).toBe('price')
    expect(defaultFormat({ unit: 'shares' }, 'number')).toBe('compact')
    expect(defaultFormat({ unit: 'ratio' }, 'number')).toBe('ratio')
    expect(defaultFormat({ unit: 'days' }, 'number')).toBe('integer')
    expect(defaultFormat({}, 'time')).toBe('time')
    expect(defaultFormat({ format: 'link' }, 'string')).toBe('link')
    expect(defaultFormat({}, 'number')).toBe('text')
    const fields = { symbol: { role: 'group' as const }, a: { role: 'measure' as const }, b: { role: 'measure' as const, key: true } }
    expect(keyField(fields)).toBe('b')
    expect(keyField({ symbol: { role: 'group' }, a: { role: 'measure' } })).toBe('a')
    expect(keyField({ symbol: { role: 'group' } })).toBeUndefined()
  })
  it('orders columns by priority then frame order and drops hidden ones', () => {
    expect(orderByPriority(['a', 'b', 'c', 'd'], { a: { priority: 5 }, b: { priority: 1 }, c: { hidden: true }, d: {} })).toEqual(['b', 'a', 'd'])
  })
})
