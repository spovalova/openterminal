import { describe, expect, it } from 'vitest'
import { tabLabel } from '../TabBar'

describe('tab labels lead with the subject (taste round, change 15)', () => {
  it('puts a ticker named later in the name first', () => {
    expect(tabLabel('Why is CRWV down?')).toBe('CRWV · Why is CRWV down?')
    expect(tabLabel('P/E over time for NVDA')).toBe('NVDA · P/E over time for NVDA')
  })
  it('leaves names that already start with one, or have none, alone', () => {
    expect(tabLabel('TSLA puts for next Friday')).toBe('TSLA puts for next Friday')
    expect(tabLabel('Memory names')).toBe('Memory names')
    expect(tabLabel('RSI and MACD on AMD')).toBe('AMD · RSI and MACD on AMD')
    expect(tabLabel('Correlation of the Mag 7 over 6 months')).toBe('Correlation of the Mag 7 over 6 months')
  })
})
