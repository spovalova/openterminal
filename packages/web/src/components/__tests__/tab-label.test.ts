import { describe, expect, it } from 'vitest'
import { tabLabel } from '../TabBar'
import { isBlankWorkspace } from '../../state'

describe('tab labels lead with the subject, never twice (taste rounds 1 and 2)', () => {
  it('moves a ticker the name ends on to the front', () => {
    expect(tabLabel('P/E over time for NVDA')).toBe('NVDA · P/E over time')
    expect(tabLabel('RSI and MACD on AMD')).toBe('AMD · RSI and MACD')
  })
  it('never repeats a ticker the name already starts with or holds in the middle (round 2: "AMD · AMD: RSI and MACD")', () => {
    expect(tabLabel('AMD: RSI and MACD')).toBe('AMD: RSI and MACD')
    expect(tabLabel('CRWV: why down')).toBe('CRWV: why down')
    expect(tabLabel('TSLA puts for next Friday')).toBe('TSLA puts for next Friday')
    expect(tabLabel('Why is CRWV down?')).toBe('Why is CRWV down?')
  })
  it('leaves names without a ticker alone', () => {
    expect(tabLabel('Memory names')).toBe('Memory names')
    expect(tabLabel('Correlation of the Mag 7 over 6 months')).toBe('Correlation of the Mag 7 over 6 months')
    expect(tabLabel('Outlook for CPI')).toBe('Outlook for CPI')
  })
})

describe('a blank Untitled workspace is never restored as a tab (round 2)', () => {
  it('is the default name with no widgets and no messages', () => {
    expect(isBlankWorkspace({ name: 'Untitled', widgets: [], messages: [] })).toBe(true)
    expect(isBlankWorkspace({ name: 'Untitled', widgets: [], messages: [{ role: 'user', text: 'hi' }] })).toBe(false)
    expect(isBlankWorkspace({ name: 'Memory stocks', widgets: [], messages: [] })).toBe(false)
  })
})
