import { describe, expect, it } from 'vitest'
import { displayText, formatCell } from '@openterminal/ui'
import { fieldLabel, type Frame, type WidgetV2 } from '@openterminal/core'
import { bondLabel, subtitleForWidget, symbolsLabel } from '../../subtitle'
import { displayName, legendLabel } from '../series-data'
import { formatValue, markerKindLabel } from '../chart/data'

describe('no raw identifiers in the UI (taste round, change 11)', () => {
  it('series and axis names read as display names; tickers stay as written', () => {
    expect(legendLabel('spread_10y_2y')).toBe('10Y-2Y')
    expect(legendLabel('eps_ttm')).toBe('EPS TTM')
    expect(displayName('trailing_pe')).toBe('Trailing P/E')
    for (const t of ['NVDA', 'BRK.B', 'PBR-A']) expect(displayName(t)).toBe(t)
    expect(markerKindLabel('eps_history')).toBe('Earnings')
  })
  it('round 2 (change 8): an index by its name, a bond by its coupon and year, a flag as a tick, markers by what they mark', () => {
    expect(displayName('^GSPC')).toBe('S&P 500')
    expect(legendLabel('^NDX')).toBe('Nasdaq 100')
    expect(symbolsLabel(['^GSPC'])).toBe('S&P 500')
    expect(bondLabel('CRWV6083302', '9.25% 2030 notes, yield')).toBe('CRWV 9.25% 2030')
    expect(bondLabel('CRWV6083302', 'CoreWeave bond')).toBe('CRWV bond')
    expect(bondLabel('NVDA')).toBeUndefined()
    expect(fieldLabel('is_convertible')).toBe('Conv.')
    expect(formatCell(true)).toBe('✓')
    expect(formatCell(false)).toBe('—')
    const spx: WidgetV2 = {
      id: 'w1',
      title: 'S&P 500, last week',
      size: 'lg',
      data: { main: { recipe: 'index', params: { symbol: '^GSPC', interval: '1d', range: '1mo' } }, events: { inputs: { cal: { recipe: 'calendar', params: {} } }, code: 'result = cal' } as never },
      view: { preset: 'price', candle: true, events: 'events' },
    } as WidgetV2
    const subtitle = subtitleForWidget(spx)
    expect(subtitle).toContain('S&P 500')
    expect(subtitle).toContain('release markers')
    expect(subtitle).not.toMatch(/\^GSPC|derived/)
    const bonds: Frame = { columns: [{ name: 'date', type: 'time' }, { name: 'cusip', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }], rows: [[1, '21873SAB4', 'CRWV6083302', 85]], meta: { connector: 'openbb', fetchedAt: 0, ttl: 0 } }
    const bondWidget = { id: 'w2', title: '9.25% 2030 notes, yield', size: 'md', data: { main: { connector: 'openbb', route: 'finra/fixedincome/bond_historical', params: { cusip: '21873SAB4' } } }, view: { preset: 'price' } } as WidgetV2
    expect(subtitleForWidget(bondWidget, { main: bonds })).toBe('Bond history · CRWV 9.25% 2030')
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
