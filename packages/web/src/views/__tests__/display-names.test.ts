import { describe, expect, it } from 'vitest'
import { displayText } from '@terminal/ui'
import { displayName, legendLabel } from '../series-data'
import { formatValue, markerKindLabel } from '../chart/data'

describe('no raw identifiers in the UI (taste round, change 11)', () => {
  it('series and axis names read as display names; tickers stay as written', () => {
    expect(legendLabel('spread_10y_2y')).toBe('10Y-2Y')
    expect(legendLabel('eps_ttm')).toBe('EPS TTM')
    expect(displayName('trailing_pe')).toBe('Trailing P/E')
    for (const t of ['NVDA', 'BRK.B', '^GSPC', 'PBR-A']) expect(displayName(t)).toBe(t)
    expect(markerKindLabel('eps_history')).toBe('Earnings')
  })
  it('enum cells by their reading, ticker lists capped at three', () => {
    expect(displayText('after-hours')).toBe('After the close')
    expect(displayText('not-supplied')).toBe('—')
    expect(displayText('strong_buy')).toBe('Strong buy')
    expect(displayText('GOOGL,ANET,AAPL,HRL,SNDK')).toBe('GOOGL, ANET, AAPL +2')
    expect(displayText('The Motley Fool')).toBe('The Motley Fool')
  })
})

describe('axis and legend numbers (change 13)', () => {
  it('a level under a million reads in full, never 7.66K', () => {
    expect(formatValue(7659.44, 'compact')).toBe('7,659.44')
    expect(formatValue(95394, 'compact')).toBe('95,394')
    expect(formatValue(95_394_231, 'compact')).toBe('95.4M')
  })
})
