// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Frame, WidgetV2 } from '@terminal/core'
import { builtinRecipes } from '@terminal/core/node'
import { describeDataset, shortDate, subtitleForRecipe, subtitleForWidget, symbolsLabel } from '../src/subtitle'

/** 2026-10-16 14:00 UTC, the morning every fixture was recorded. */
const NOW = Date.UTC(2026, 9, 16, 14, 0)

function frame(columns: [string, 'string' | 'number' | 'time'][], rows: unknown[][]): Frame {
  return { columns: columns.map(([name, type]) => ({ name, type })), rows, meta: { connector: 'fixture', fetchedAt: NOW, ttl: 60_000 } }
}
const sub = (recipe: string, params: Record<string, unknown>, f?: Frame, view?: WidgetV2['view']) => subtitleForRecipe(recipe, params, view, f, NOW)
const widget = (data: WidgetV2['data'], view: WidgetV2['view'] = { preset: 'table' }): WidgetV2 => ({ id: 'w', title: 'x', size: 'md', data, view })

describe('subtitleForRecipe', () => {
  it('lists up to three symbols and counts more', () => {
    expect(symbolsLabel(['NVDA'])).toBe('NVDA')
    expect(symbolsLabel(['NVDA', 'AMD', 'AVGO'])).toBe('NVDA, AMD, AVGO')
    expect(symbolsLabel(['MU', 'SNDK', 'WDC', 'STX'])).toBe('4 symbols')
  })

  it('formats dates short, with the year only when it is not this year; epoch times read as New York dates', () => {
    expect(shortDate('2026-10-23', NOW)).toBe('Oct 23')
    expect(shortDate('2025-12-17', NOW)).toBe('Dec 17, 2025')
    expect(shortDate(Date.UTC(2026, 9, 23, 4), NOW)).toBe('Oct 23')
    expect(shortDate('tomorrow', NOW)).toBe('tomorrow')
    expect(shortDate(null, NOW)).toBe('')
  })

  it('ohlcv and index: symbols, interval and range, today for 1d, rebased or candles from the view, since a start date', () => {
    expect(sub('ohlcv', { symbols: ['NVDA'], interval: '5m', range: '1d' }, undefined, { preset: 'price', candle: true })).toBe('NVDA · 5m · today, candles')
    expect(sub('ohlcv', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], interval: '1d', range: '3mo' }, undefined, { preset: 'compare', normalize: true })).toBe('4 symbols · 1d · 3mo, rebased')
    expect(sub('ohlcv', { symbols: ['SPY', 'QQQ'], interval: '1d', range: '5d' }, undefined, { preset: 'compare', normalize: false })).toBe('SPY, QQQ · 1d · 5d')
    expect(sub('ohlcv', { symbols: ['SPY'], interval: '1w', range: '2y' })).toBe('SPY · 1w · 2y')
    expect(sub('ohlcv', { symbols: ['SPY'], start: '2020-01-01' })).toBe('SPY · 1d · since Jan 1, 2020')
    expect(sub('index', { symbol: '^GSPC', range: '3mo' })).toBe('^GSPC · 1d · 3mo')
  })

  it('quote: the symbols and the market state once the frame lands (v1 or yahoo column names)', () => {
    const p = { symbols: ['MU', 'SNDK', 'WDC', 'STX'] }
    expect(sub('quote', p)).toBe('4 symbols')
    expect(sub('quote', p, frame([['symbol', 'string'], ['market_state', 'string']], [['MU', 'REGULAR'], ['SNDK', 'REGULAR']]))).toBe('4 symbols · regular session')
    expect(sub('quote', { symbols: ['NVDA'] }, frame([['symbol', 'string'], ['marketState', 'string']], [['NVDA', 'POST']]))).toBe('NVDA · after hours')
    expect(sub('quote', { symbols: ['NVDA'] }, frame([['symbol', 'string'], ['marketState', 'string']], [['NVDA', 'PREPRE']]))).toBe('NVDA · pre-market')
    expect(sub('quote', { symbols: ['NVDA'] }, frame([['symbol', 'string'], ['price', 'number']], [['NVDA', 1]]))).toBe('NVDA')
  })

  it('options: expiry, DTE and the underlying from the frame; the request before it lands', () => {
    expect(sub('options', { symbol: 'NVDA', strikes: 10 })).toBe('NVDA · nearest expiration')
    expect(sub('options', { symbol: 'NVDA', expiration: '2026-11-20', type: 'call' })).toBe('NVDA · on or after Nov 20 · calls only')
    const f = frame([['underlying_symbol', 'string'], ['expiration', 'string'], ['dte', 'number'], ['underlying_price', 'number']], [['NVDA', '2026-10-23', 7, 182.43]])
    expect(sub('options', { symbol: 'NVDA' }, f)).toBe('NVDA · Oct 23 · 7 DTE · underlying 182.43')
  })

  it('news: the symbols, then the count and the window the headlines span', () => {
    const p = { symbols: ['NVDA'], limit: 20 }
    expect(sub('news', p)).toBe('NVDA · up to 20')
    const h = 3_600_000
    expect(sub('news', p, frame([['date', 'time'], ['title', 'string']], [[NOW - 2 * h, 'a'], [NOW - 5 * h, 'b']]))).toBe('NVDA · 2 headlines · last 5h')
    expect(sub('news', p, frame([['date', 'time'], ['title', 'string']], [[NOW - 72 * h, 'a']]))).toBe('NVDA · 1 headline · last 3 days')
  })

  it('macro: the series short name and the range; a multi-series widget lists its series', () => {
    expect(sub('macro', { series: 'treasury_10y', range: '1y' })).toBe('10Y · 1y')
    expect(sub('macro', { series: 'm2', range: '5y' })).toBe('M2 · 5y')
    const w = widget({ ten: { recipe: 'macro', params: { series: 'treasury_10y', range: '1y' } }, two: { recipe: 'macro', params: { series: 'treasury_2y', range: '1y' } }, ff: { recipe: 'macro', params: { series: 'fed_funds', range: '1y' } } }, { preset: 'compare', normalize: false })
    expect(subtitleForWidget(w, {}, NOW)).toBe('10Y, 2Y, Fed funds · 1y')
  })

  it('financials: the period and the count', () => {
    const p = { symbols: ['MU'], period: 'quarter', limit: 5 }
    expect(sub('financials', p)).toBe('MU · quarterly · last 5')
    expect(sub('financials', p, frame([['period_ending', 'time'], ['revenue', 'number']], [[1, 1], [2, 1]]))).toBe('MU · quarterly · 2 periods')
    expect(sub('financials', { symbols: ['MU'], period: 'annual' })).toBe('MU · annual · last 4')
  })

  it('earnings, calendar and ipos: the window, plus the count once the frame lands', () => {
    expect(sub('earnings', { symbols: ['MU', 'SNDK', 'WDC', 'STX'], from: '2026-10-16', to: '2026-12-15' })).toBe('4 symbols · Oct 16 to Dec 15')
    expect(sub('earnings', { symbols: ['MU'], from: '2026-10-16', to: '2026-10-16' }, frame([['symbol', 'string'], ['session', 'string']], [['MU', 'amc']]))).toBe('MU · Oct 16 · 1 date')
    expect(sub('calendar', { from: '2026-10-16', to: '2026-10-23' })).toBe('Oct 16 to Oct 23 · United States')
    expect(sub('calendar', { from: '2026-10-16', to: '2026-10-23', country: 'United States' }, frame([['date', 'time'], ['event', 'string']], [[NOW, 'CPI']]))).toBe('Oct 16 to Oct 23 · United States · 1 event')
    expect(sub('ipos', { from: '2026-10-16', to: '2026-11-15' }, frame([['symbol', 'string']], [['X'], ['Y']]))).toBe('Oct 16 to Nov 15 · 2 IPOs')
  })

  it('profile, metrics, estimates and volatility: the symbols and one word on what the table holds', () => {
    expect(sub('profile', { symbols: ['NVDA'] })).toBe('NVDA')
    expect(sub('profile', { symbols: ['NVDA'] }, frame([['symbol', 'string'], ['sector', 'string'], ['stock_exchange', 'string']], [['NVDA', 'Technology', 'NMS']]))).toBe('NVDA · Technology · NMS')
    expect(sub('profile', { symbols: ['NVDA', 'AMD'] }, frame([['symbol', 'string'], ['sector', 'string']], [['NVDA', 'Technology']]))).toBe('NVDA, AMD')
    expect(sub('metrics', { symbols: ['META', 'PINS', 'RDDT', 'SNAP'] })).toBe('4 symbols · multiples and margins')
    expect(sub('estimates', { symbols: ['RDDT'] })).toBe('RDDT · consensus')
    expect(sub('estimates', { symbols: ['RDDT'] }, frame([['symbol', 'string'], ['number_of_analysts', 'number']], [['RDDT', 33]]))).toBe('RDDT · 33 analysts')
    expect(sub('volatility', { symbols: ['MU'] })).toBe('MU · 30-day IV and realized')
  })

  it('history recipes: the limit before the frame, the row count after', () => {
    expect(sub('eps_history', { symbols: ['MU'], limit: 8 })).toBe('MU · last 8')
    expect(sub('eps_history', { symbols: ['MU'] }, frame([['symbol', 'string']], [['MU']]))).toBe('MU · 1 report')
    expect(sub('dividends', { symbols: ['AAPL'] })).toBe('AAPL · last 12')
    expect(sub('dividends', { symbols: ['AAPL'] }, frame([['symbol', 'string']], [['AAPL'], ['AAPL']]))).toBe('AAPL · 2 payments')
    expect(sub('insiders', { symbols: ['MU'], limit: 20 })).toBe('MU · last 20')
    expect(sub('insiders', { symbols: ['MU'] }, frame([['symbol', 'string']], [['MU']]))).toBe('MU · 1 transaction')
    expect(sub('institutions', { symbols: ['MU'] })).toBe('MU · top 20')
    expect(sub('institutions', { symbols: ['MU'] }, frame([['symbol', 'string']], [['MU']]))).toBe('MU · top 1 holder')
    expect(sub('short_interest', { symbols: ['MU'] })).toBe('MU · last 12 reports')
    expect(sub('short_interest', { symbols: ['MU'] }, frame([['settlement_date', 'time'], ['symbol', 'string']], [[Date.UTC(2026, 8, 30, 4), 'MU']]))).toBe('MU · latest Sep 30')
  })

  it('market-wide recipes: movers, screener, holdings, yield curve, search', () => {
    expect(sub('movers', { list: 'gainers' })).toBe('gainers · top 20 · over $5')
    expect(sub('movers', { list: 'active', limit: 10, min_price: 0 })).toBe('most active · top 10')
    expect(sub('screener', { sector: 'technology', mktcap_min: 1e10 })).toBe('technology')
    expect(sub('screener', {}, frame([['symbol', 'string']], [['A'], ['B']]))).toBe('whole market · 2 names')
    expect(sub('holdings', { symbol: 'SMH' })).toBe('SMH · top holdings')
    expect(sub('holdings', { symbol: 'SMH' }, frame([['symbol', 'string']], [['NVDA'], ['TSM']]))).toBe('SMH · top 2 holdings')
    expect(sub('yield_curve', {})).toBe('latest')
    expect(sub('yield_curve', { date: '2026-10-15' })).toBe('Oct 15')
    expect(sub('yield_curve', {}, frame([['date', 'string'], ['maturity', 'string']], [['2026-10-15', '3M'], ['2026-10-15', '10Y']]))).toBe('Oct 15 · 2 maturities')
    expect(sub('search', { q: 'micron' })).toBe('micron')
    expect(sub('search', { q: 'micron' }, frame([['symbol', 'string']], [['MU']]))).toBe('micron · 1 match')
  })

  it('says something for every built-in recipe, with and without a frame, and for an unknown recipe', () => {
    const params: Record<string, Record<string, unknown>> = {
      search: { q: 'a' },
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
      macro: { series: 'sofr' },
      yield_curve: {},
      index: { symbol: '^GSPC' },
      screener: { sector: 'energy' },
    }
    for (const r of builtinRecipes()) {
      expect(params, r.name).toHaveProperty(r.name)
      expect(sub(r.name, params[r.name]!), r.name).not.toBe('')
      expect(sub(r.name, params[r.name]!, frame([['symbol', 'string']], [])), r.name).not.toBe('')
    }
    expect(sub('my_recipe', { symbols: ['MU', 'AMD'], window: 20 }, frame([['x', 'number']], [[1]]))).toBe('MU, AMD · 20 · 1 row')
  })
})

describe('subtitleForWidget and describeDataset', () => {
  it('describes the primary dataset and names the other datasets as markers', () => {
    const w = widget({ main: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, events: { recipe: 'earnings', params: { symbols: ['MU'], from: '2026-01-01', to: '2026-12-31' } } }, { preset: 'price', candle: true, events: 'events' })
    expect(subtitleForWidget(w, {}, NOW)).toBe('MU · 1d · 6mo, candles · earnings markers')
  })
  it('a route by its path and the params that matter, with the frame’s row count; a transform by what it derives from', () => {
    expect(describeDataset({ connector: 'openbb', route: 'equity/price/quote', params: { symbol: ['NVDA', 'AMD'], provider: 'yfinance' } })).toBe('equity/price/quote · symbol=NVDA, AMD')
    expect(describeDataset({ connector: 'openbb', route: 'equity/price/historical', params: { symbol: 'NVDA' } }, undefined, frame([['time', 'time'], ['close', 'number']], [[1, 1], [2, 2]]))).toBe('equity/price/historical · symbol=NVDA · 2 bars')
    expect(describeDataset({ inputs: { price: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } }, eps: { recipe: 'eps_history', params: { symbols: ['NVDA'] } } }, code: 'result = price' })).toBe('derived from ohlcv + eps_history · NVDA')
    const w = widget({ main: { connector: 'openbb', route: 'economy/calendar', params: { start_date: '2026-10-19', end_date: '2026-10-24', country: 'united_states', provider: 'nasdaq' } } })
    expect(subtitleForWidget(w, {}, NOW)).toBe('economy/calendar · start_date=2026-10-19 · end_date=2026-10-24 · country=united_states')
  })
})
