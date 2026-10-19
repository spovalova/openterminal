import { describe, expect, it } from 'vitest'
import { headerLabels, label, textWidths, uniformFormats } from '../src/components/DataTable.js'

const col = (name: string, type: 'string' | 'number' | 'time' = 'string') => ({ name, type })

describe('DataTable columns sized to content and aligned by type (taste round, change 5)', () => {
  it('headers come from display names in sentence case, never the raw name', () => {
    expect(label('pair')).toBe('Pair')
    expect(label('num_estimates')).toBe('Estimates')
    expect(label('day', { day: 'day' })).toBe('Day')
    expect(label('x', { x: 'Fwd P/E' })).toBe('Fwd P/E')
  })
  it('tells two columns with the same label apart by their format', () => {
    const out = headerLabels([col('entry'), col('entry_price', 'number')], { entry: 'date', entry_price: 'price' }, { entry_price: 'Entry' })
    expect(out).toEqual({ entry: 'Entry date', entry_price: 'Entry price' })
  })
  it('prints a compact column under a million grouped, so 1.94K never sits beside 2,310', () => {
    const cols = [col('breakeven', 'number'), col('mktcap', 'number')]
    const rows = [[1940.25, 2.1e10], [619.4, 3e9]]
    expect(uniformFormats(cols, rows, { breakeven: 'compact', mktcap: 'compact' })).toEqual({ breakeven: 'price', mktcap: 'compact' })
    expect(uniformFormats([col('oi', 'number')], [[2310], [619]], { oi: 'compact' })).toEqual({ oi: 'integer' })
  })
  it('sizes short text to its longest value and leaves headlines flexible', () => {
    const cols = [col('pair'), col('headline')]
    const rows = [['AMZN / GOOGL', 'x'.repeat(90)], ['NVDA / TSLA', 'short']]
    const w = textWidths(cols, rows, { pair: 'text', headline: 'text' }, { pair: 'Pair', headline: 'Headline' })
    expect(w.pair).toBeGreaterThan(90)
    expect(w.pair).toBeLessThan(140)
    expect(w.headline).toBeUndefined()
  })
})
