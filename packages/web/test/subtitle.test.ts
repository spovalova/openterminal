import { describe, expect, it } from 'vitest'
import { KINDS, KIND_NAMES, parseWidget, type Frame, type Kind, type WidgetInput } from '@terminal/core'
import { shortDate, subtitleFor, symbolsLabel } from '../src/subtitle'

/** 2026-10-16 14:00 UTC, the morning every fixture was recorded. */
const NOW = Date.UTC(2026, 9, 16, 14, 0)

function frame(kind: Kind, rows: unknown[][]): Frame {
  return { columns: KINDS[kind].columns, rows, meta: { connector: 'fixture', fetchedAt: NOW, ttl: 60_000 } }
}
function widget(kind: Kind, params: Record<string, unknown>, view: WidgetInput['view'] = { type: 'table' }, size: WidgetInput['size'] = 'md') {
  return parseWidget({ id: 'w', title: 'x', size, query: { kind, params } as WidgetInput['query'], view })
}
const sub = (w: ReturnType<typeof widget>, f?: Frame) => subtitleFor(w, f, NOW)

describe('subtitleFor', () => {
  it('lists up to three symbols and counts more', () => {
    expect(symbolsLabel(['NVDA'])).toBe('NVDA')
    expect(symbolsLabel(['NVDA', 'AMD', 'AVGO'])).toBe('NVDA, AMD, AVGO')
    expect(symbolsLabel(['MU', 'SNDK', 'WDC', 'STX'])).toBe('4 symbols')
  })

  it('formats dates short, with the year only when it is not this year', () => {
    expect(shortDate('2026-10-23', NOW)).toBe('Oct 23')
    expect(shortDate('2025-12-17', NOW)).toBe('Dec 17, 2025')
    expect(shortDate('tomorrow', NOW)).toBe('tomorrow')
    expect(shortDate(null, NOW)).toBe('')
  })

  it('ohlcv: symbols, interval and range, today for 1d, rebased or candles from the view', () => {
    expect(sub(widget('ohlcv', { symbols: ['NVDA'], interval: '5m', range: '1d' }, { type: 'series', candle: true }))).toBe('NVDA · 5m · today, candles')
    expect(sub(widget('ohlcv', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], interval: '1d', range: '3mo' }, { type: 'series', normalize: true }))).toBe('4 symbols · 1d · 3mo, rebased')
    expect(sub(widget('ohlcv', { symbols: ['SPY', 'QQQ'], interval: '1d', range: '5d' }, { type: 'series' }))).toBe('SPY, QQQ · 1d · 5d')
    expect(sub(widget('ohlcv', { symbols: ['SPY'], interval: '1w', range: '2y' }))).toBe('SPY · 1w · 2y')
  })

  it('quote: the symbols and the market state once the frame lands', () => {
    const w = widget('quote', { symbols: ['MU', 'SNDK', 'WDC', 'STX'] })
    expect(sub(w)).toBe('4 symbols')
    expect(sub(w, frame('quote', [['MU', 1, 1, 1, 'REGULAR', null, null], ['SNDK', 1, 1, 1, 'REGULAR', null, null]]))).toBe('4 symbols · regular session')
    expect(sub(widget('quote', { symbols: ['NVDA'] }), frame('quote', [['NVDA', 1, 1, 1, 'POST', 2, 0.5]]))).toBe('NVDA · after hours')
    expect(sub(widget('quote', { symbols: ['NVDA'] }), frame('quote', [['NVDA', 1, 1, 1, 'PRE', 2, 0.5]]))).toBe('NVDA · pre-market')
    expect(sub(widget('quote', { symbols: ['NVDA'] }), frame('quote', [['NVDA', 1, 1, 1, null, null, null]]))).toBe('NVDA')
  })

  it('options: expiry, DTE and the underlying from the frame; the request before it lands', () => {
    const w = widget('options', { symbol: 'NVDA', strikes: 10 }, { type: 'chain' }, 'lg')
    expect(sub(w)).toBe('NVDA · nearest expiration')
    expect(sub(widget('options', { symbol: 'NVDA', expiration: '2026-11-20', type: 'call' }, { type: 'chain' }, 'lg'))).toBe('NVDA · on or after Nov 20 · calls only')
    const f = frame('options', [['NVDA', '2026-10-23', 'call', 180, 1, 1, 1, 1, 1, 50, 0.5, 0, 0, 0, 182.43, 7]])
    expect(sub(w, f)).toBe('NVDA · Oct 23 · 7 DTE · underlying 182.43')
  })

  it('news: the symbols, then the count and the window the headlines span', () => {
    const w = widget('news', { symbols: ['NVDA'], limit: 20 })
    expect(sub(w)).toBe('NVDA · up to 20')
    const h = 3_600_000
    expect(sub(w, frame('news', [[NOW - 2 * h, 'a', 's', 'u', 'NVDA'], [NOW - 5 * h, 'b', 's', 'u', 'NVDA']]))).toBe('NVDA · 2 headlines · last 5h')
    expect(sub(w, frame('news', [[NOW - 72 * h, 'a', 's', 'u', 'NVDA']]))).toBe('NVDA · 1 headline · last 3 days')
  })

  it('macro: the series names and the range', () => {
    expect(sub(widget('macro', { series: ['treasury_10y', 'treasury_2y', 'fed_funds'], range: '1y' }, { type: 'series' }))).toBe('10Y, 2Y, Fed funds · 1y')
    expect(sub(widget('macro', { series: ['m2'], range: '5y' }, { type: 'series' }))).toBe('M2 · 5y')
  })

  it('financials: the period and the count', () => {
    const w = widget('financials', { symbols: ['MU'], period: 'quarter', limit: 5 })
    expect(sub(w)).toBe('MU · quarterly · last 5')
    expect(sub(w, frame('financials', [['MU', '2026-08-28', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], ['MU', '2026-05-29', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]))).toBe('MU · quarterly · 2 periods')
    expect(sub(widget('financials', { symbols: ['MU'], period: 'annual' }))).toBe('MU · annual · last 4')
  })

  it('earnings, calendar and ipos: the window, plus the count once the frame lands', () => {
    expect(sub(widget('earnings', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], from: '2026-10-16', to: '2026-12-15' }))).toBe('4 symbols · Oct 16 to Dec 15')
    expect(sub(widget('earnings', { symbols: ['MU'], from: '2026-10-16', to: '2026-10-16' }), frame('earnings', [['MU', '2026-10-16', 'amc', 1]]))).toBe('MU · Oct 16 · 1 date')
    expect(sub(widget('calendar', { from: '2026-10-16', to: '2026-10-23' }))).toBe('Oct 16 to Oct 23 · United States')
    expect(sub(widget('calendar', { from: '2026-10-16', to: '2026-10-23' }), frame('calendar', [[NOW, 'United States', 'CPI', '', '', '']]))).toBe('Oct 16 to Oct 23 · United States · 1 event')
    expect(sub(widget('ipos', { from: '2026-10-16', to: '2026-11-15' }), frame('ipos', [['X', '2026-10-20', 'X Inc', 'NYSE', 20, 1, 'priced'], ['Y', '2026-10-21', 'Y Inc', 'NYSE', 20, 1, 'expected']]))).toBe('Oct 16 to Nov 15 · 2 IPOs')
  })

  it('profile, metrics, estimates and volatility: the symbols and one word on what the table holds', () => {
    expect(sub(widget('profile', { symbols: ['NVDA'] }))).toBe('NVDA')
    expect(sub(widget('profile', { symbols: ['NVDA'] }), frame('profile', [['NVDA', 'NVIDIA', 'NASDAQ', 'Technology', 'Semiconductors', 1, 1, 1, 'd']]))).toBe('NVDA · Technology · NASDAQ')
    expect(sub(widget('profile', { symbols: ['NVDA', 'AMD'] }), frame('profile', [['NVDA', 'NVIDIA', 'NASDAQ', 'Technology', 'Semiconductors', 1, 1, 1, 'd']]))).toBe('NVDA, AMD')
    expect(sub(widget('metrics', { symbols: ['META', 'PINS', 'RDDT', 'SNAP'] }))).toBe('4 symbols · multiples and margins')
    expect(sub(widget('estimates', { symbols: ['RDDT'] }))).toBe('RDDT · consensus')
    expect(sub(widget('estimates', { symbols: ['RDDT'] }), frame('estimates', [['RDDT', 'buy', 33, 130, 213.71, 300, 37, 1, 1, 1]]))).toBe('RDDT · 33 analysts')
    expect(sub(widget('volatility', { symbols: ['MU'] }))).toBe('MU · 30-day IV and realized')
  })

  it('history kinds: the limit before the frame, the row count after', () => {
    expect(sub(widget('eps_history', { symbols: ['MU'], limit: 8 }))).toBe('MU · last 8')
    expect(sub(widget('eps_history', { symbols: ['MU'] }), frame('eps_history', [['MU', '2026-09-24', 1, 1, 1]]))).toBe('MU · 1 report')
    expect(sub(widget('dividends', { symbols: ['AAPL'] }))).toBe('AAPL · last 12')
    expect(sub(widget('dividends', { symbols: ['AAPL'] }), frame('dividends', [['AAPL', '2026-08-11', 0.26], ['AAPL', '2026-05-12', 0.26]]))).toBe('AAPL · 2 payments')
    expect(sub(widget('insiders', { symbols: ['MU'], limit: 20 }))).toBe('MU · last 20')
    expect(sub(widget('insiders', { symbols: ['MU'] }), frame('insiders', [['MU', '2026-10-01', 'n', 't', 'sell', 1, 1, 1, 'u']]))).toBe('MU · 1 transaction')
    expect(sub(widget('institutions', { symbols: ['MU'] }))).toBe('MU · top 20')
    expect(sub(widget('institutions', { symbols: ['MU'] }), frame('institutions', [['MU', '2026-06-30', 'Vanguard', 1, 1, 1]]))).toBe('MU · top 1 holder')
    expect(sub(widget('short_interest', { symbols: ['MU'] }))).toBe('MU · last 12 reports')
    expect(sub(widget('short_interest', { symbols: ['MU'] }), frame('short_interest', [['MU', '2026-09-30', 1, 1, 1, 2.1]]))).toBe('MU · latest Sep 30')
  })

  it('market-wide kinds: movers, holdings, yield curve, search', () => {
    expect(sub(widget('movers', { list: 'gainers' }))).toBe('gainers · top 20 · over $5')
    expect(sub(widget('movers', { list: 'active', limit: 10, min_price: 0 }))).toBe('most active · top 10')
    expect(sub(widget('holdings', { symbol: 'SMH' }))).toBe('SMH · top holdings')
    expect(sub(widget('holdings', { symbol: 'SMH' }), frame('holdings', [['SMH', 'NVDA', 'NVIDIA', 20], ['SMH', 'TSM', 'TSMC', 10]]))).toBe('SMH · top 2 holdings')
    expect(sub(widget('yield_curve', {}))).toBe('latest')
    expect(sub(widget('yield_curve', { date: '2026-10-15' }))).toBe('Oct 15')
    expect(sub(widget('yield_curve', {}), frame('yield_curve', [['2026-10-15', '3M', 0.25, 4.1], ['2026-10-15', '10Y', 10, 4.3]]))).toBe('Oct 15 · 2 maturities')
    expect(sub(widget('search', { q: ['micron', 'sandisk'] }))).toBe('2 queries')
    expect(sub(widget('search', { q: ['micron'] }), frame('search', [['micron', 'MU', 'Micron', 'NASDAQ']]))).toBe('1 query · 1 match')
  })

  it('says something for every kind in the catalog, with and without a frame', () => {
    const params: Record<Kind, Record<string, unknown>> = {
      search: { q: ['a'] },
      quote: { symbols: ['A'] },
      ohlcv: { symbols: ['A'], interval: '1d', range: '1mo' },
      news: { symbols: ['A'] },
      earnings: { symbols: ['A'], from: '2026-10-16', to: '2026-10-17' },
      profile: { symbols: ['A'] },
      metrics: { symbols: ['A'] },
      financials: { symbols: ['A'] },
      estimates: { symbols: ['A'] },
      eps_history: { symbols: ['A'] },
      dividends: { symbols: ['A'] },
      insiders: { symbols: ['A'] },
      institutions: { symbols: ['A'] },
      short_interest: { symbols: ['A'] },
      options: { symbol: 'A' },
      volatility: { symbols: ['A'] },
      calendar: { from: '2026-10-16', to: '2026-10-17' },
      ipos: { from: '2026-10-16', to: '2026-10-17' },
      movers: {},
      holdings: { symbol: 'A' },
      macro: { series: ['sofr'] },
      yield_curve: {},
    }
    for (const kind of KIND_NAMES) {
      const w = widget(kind, params[kind], kind === 'options' ? { type: 'chain' } : { type: 'table' })
      expect(sub(w), kind).not.toBe('')
      expect(sub(w, frame(kind, [])), kind).not.toBe('')
    }
  })
})
