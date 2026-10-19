// A few built-in recipes in the shape `GET /api/recipes` returns, for jsdom tests (the YAML loader is Node-only).
import type { Recipe } from '@terminal/core'

const symbols = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ticker symbols' } as const

export const RECIPES: Recipe[] = [
  {
    name: 'quote',
    title: '{symbols} quote',
    summary: 'Latest price, day change, volume, market state and extended-hours price per symbol.',
    params: { type: 'object', properties: { symbols }, required: ['symbols'] },
    view: { preset: 'stat', column: 'last_price', change: 'change_percent' },
    size: 'sm',
    routes: [
      { connector: 'openbb', route: 'equity/price/quote', provider: 'yfinance', params: { symbol: '{symbols}' } },
      { connector: 'yahoo', route: 'quote', params: { symbols: '{symbols}' } },
      { connector: 'finnhub', route: 'quote', params: { symbol: '{symbols|first}' } },
    ],
  },
  {
    name: 'ohlcv',
    title: '{symbols} {interval} {range}',
    summary: 'Price bars per symbol over a range at an interval, long format with a symbol column.',
    params: {
      type: 'object',
      properties: { symbols, interval: { type: 'string', enum: ['1m', '5m', '15m', '1h', '1d', '1w'], default: '1d' }, range: { type: 'string', enum: ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'], default: '3mo' } },
      required: ['symbols'],
    },
    view: { preset: 'price', volume: false },
    size: 'lg',
    routes: [
      { connector: 'openbb', route: 'equity/price/historical', provider: 'yfinance', params: { symbol: '{symbols}', start_date: '{range|start_date}', interval: '{interval|openbb_interval}' } },
      { connector: 'yahoo', route: 'chart', params: { symbol: '{symbols}', period1: '{range|start_date}', interval: '{interval|yahoo_interval}' } },
    ],
  },
  {
    name: 'eps_history',
    title: '{symbols} reported EPS',
    summary: 'Reported EPS against the estimate per quarter.',
    params: { type: 'object', properties: { symbols, limit: { type: 'integer', minimum: 1, maximum: 40, default: 8 } }, required: ['symbols'] },
    view: { preset: 'table' },
    size: 'md',
    routes: [{ connector: 'openbb', route: 'equity/fundamental/historical_eps', provider: 'fmp', params: { symbol: '{symbols}', limit: '{limit}' } }],
  },
]
