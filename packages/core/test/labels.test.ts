import { describe, expect, it } from 'vitest'
import { enumLabel, fieldLabel, splitName } from '../src/index.js'

describe('fieldLabel (change 11: no raw identifiers)', () => {
  it('reads snake_case and camelCase as sentence-case words', () => {
    expect(fieldLabel('period_ending')).toBe('Period ending')
    expect(fieldLabel('close_before')).toBe('Close before')
    expect(fieldLabel('market_cap')).toBe('Market cap')
    expect(fieldLabel('trailingPE')).toBe('Trailing P/E')
    expect(fieldLabel('regularMarketChangePercent')).toBe('Regular market change %')
    expect(fieldLabel('pair')).toBe('Pair')
    expect(fieldLabel('date')).toBe('Date')
    expect(fieldLabel('session')).toBe('Session')
  })
  it('keeps the trade acronyms and tenors', () => {
    expect(fieldLabel('eps_actual')).toBe('EPS actual')
    expect(fieldLabel('eps_history')).toBe('EPS history')
    expect(fieldLabel('spread_10y_2y')).toBe('Spread 10Y 2Y')
    expect(fieldLabel('surprise_percent')).toBe('Surprise %')
    expect(fieldLabel('reaction_pct')).toBe('Reaction %')
    expect(fieldLabel('ev_ebitda')).toBe('EV EBITDA')
    expect(fieldLabel('iv30_high')).toBe('IV30 high')
    expect(fieldLabel('sp_rating')).toBe('S&P rating')
    expect(fieldLabel('year_52w_high')).toBe('Year 52w high')
  })
  it('drops a leading count word', () => {
    expect(fieldLabel('num_estimates')).toBe('Estimates')
    expect(fieldLabel('number_of_analysts')).toBe('Analysts')
    expect(fieldLabel('num')).toBe('Num')
  })
  it('splits names on every boundary', () => {
    expect(splitName('fiftyTwoWeekHigh')).toEqual(['fifty', 'Two', 'Week', 'High'])
    expect(splitName('a_b-c.d e')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('enumLabel', () => {
  it('reads the session and rating enums', () => {
    expect(enumLabel('after-hours')).toBe('After the close')
    expect(enumLabel('amc')).toBe('After the close')
    expect(enumLabel('pre-market')).toBe('Before the open')
    expect(enumLabel('not-supplied')).toBe('—')
    expect(enumLabel('buy')).toBe('Buy')
    expect(enumLabel('strong_buy')).toBe('Strong buy')
    expect(enumLabel('consumer-cyclical')).toBe('Consumer cyclical')
  })
  it('passes names, tickers and prose through', () => {
    expect(enumLabel('NVDA')).toBe('NVDA')
    expect(enumLabel('The Motley Fool')).toBe('The Motley Fool')
    expect(enumLabel('Nvidia beats, shares fall.')).toBe('Nvidia beats, shares fall.')
    expect(enumLabel('2026-10-21')).toBe('2026-10-21')
  })
})
