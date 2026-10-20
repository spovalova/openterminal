// The Deribit port's own logic on made-up exchange answers: the option chain (inverse contracts carried to USD, the
// order of the rows, New York time), the windows of candles, and the model's renaming. The recorded replays cover
// the live shapes; these pin the parts a recording of one underlying cannot.
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { chartWindows } from '../src/deribit/helpers.js'
import { expirationDate, fromDayNumber, toTimestamp, utcText } from '../src/deribit/client.js'
import { by, shape } from '../src/deribit/model.js'
import { newYorkText, optionsChains } from '../src/deribit/options.js'

const json = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: '2.0', result }), { status: 200 })

function ticker(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: 1792526394539,
    state: 'open',
    stats: { high: null, low: null, price_change: null, volume: 2, volume_usd: 5, volume_notional: 7 },
    greeks: { delta: 0.5, gamma: 0.1, vega: 0.2, theta: -0.3, rho: 0.4 },
    index_price: 80000,
    instrument_name: name,
    last_price: null,
    settlement_price: 0.01,
    min_price: 0.005,
    max_price: 0.02,
    open_interest: 3,
    mark_price: 0.0125,
    interest_rate: 0,
    estimated_delivery_price: 80000,
    best_ask_price: 0.013,
    best_bid_price: 0.012,
    mark_iv: 50,
    bid_iv: 49,
    ask_iv: 51,
    underlying_price: 80010,
    underlying_index: 'BTC-23OCT26',
    best_ask_amount: 2,
    best_bid_amount: 3,
    ...over,
  }
}

describe('derivatives/options/chains', () => {
  const names = ['BTC-23OCT26-80000-P', 'BTC-23OCT26-80000-C', 'BTC-23OCT26-70000-C', 'BTC-30OCT26-80000-C']
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname.endsWith('/get_instruments')) return json(names.map((n) => ({ instrument_name: n, kind: 'option', instrument_type: 'reversed', contract_size: 1 })))
    if (url.pathname.endsWith('/ticker')) return json(ticker(url.searchParams.get('instrument_name')!, url.searchParams.get('instrument_name') === 'BTC-30OCT26-80000-C' ? { estimated_delivery_price: 79000, last_price: 0.02 } : {}))
    return new Response('{}', { status: 404 })
  }
  const ctx = createNativeCtx({ fetch: fetchImpl, now: () => new Date('2026-10-20T12:00:00Z'), cache: new Map() })

  it('orders by expiration, strike and type, and carries inverse prices to USD at the index level', async () => {
    const rows = await optionsChains({ symbol: 'btc' }, ctx)
    expect(rows.map((r) => r.contract_symbol)).toEqual(['BTC-23OCT26-70000-C', 'BTC-23OCT26-80000-C', 'BTC-23OCT26-80000-P', 'BTC-30OCT26-80000-C'])
    const call = rows[1]!
    expect(call).toMatchObject({ underlying_symbol: 'BTC-23OCT26', expiration: '2026-10-23', dte: 3, strike: 80000, option_type: 'call', contract_size: 1, is_inverse: true, open_interest: 3, bid_size: 3, ask_size: 2, implied_volatility: 50, delta: 0.5, underlying_price: 80010, underlying_spot_price: 80000, interest_rate: 0 })
    expect(call.mark).toBeCloseTo(1000, 9)
    expect(call.bid).toBeCloseTo(960, 9)
    expect(call.ask).toBeCloseTo(1040, 9)
    expect(call.settlement_price).toBeCloseTo(800, 9)
    expect(call.min_price).toBeCloseTo(400, 9)
    expect(call.max_price).toBeCloseTo(1600, 9)
    // The model reads the exchange's USD volume where it names it `volume_usd`, then the notional that follows it.
    expect(call.volume_notional).toBe(7)
    expect(call.timestamp).toBe('2026-10-20 15:59:54.539000-04:00')
    // A price the exchange left out stays out; one it quoted is carried too.
    expect(call).not.toHaveProperty('last_trade_price')
    expect(rows[3]!.last_trade_price).toBeCloseTo(1600, 9)
  })
})

describe('time', () => {
  it('writes New York time as pandas does, in summer and winter', () => {
    expect(newYorkText(Date.parse('2026-10-20T19:59:54.539Z'))).toBe('2026-10-20 15:59:54.539000-04:00')
    expect(newYorkText(Date.parse('2026-12-01T05:00:00Z'))).toBe('2026-12-01 00:00:00-05:00')
  })

  it('writes UTC time as pydantic does', () => {
    expect(utcText(Date.parse('2018-08-14T10:24:47Z'))).toBe('2018-08-14T10:24:47Z')
    expect(utcText(Date.parse('2026-10-20T19:32:51.918Z'))).toBe('2026-10-20T19:32:51.918000Z')
  })

  it('reads dates, datetimes (UTC unless they name a zone), day numbers and expiration codes', () => {
    expect(toTimestamp('2025-06-02')).toBe(Date.parse('2025-06-02T00:00:00Z'))
    expect(toTimestamp('2025-06-02 10:30:00')).toBe(Date.parse('2025-06-02T10:30:00Z'))
    expect(toTimestamp('2025-06-02T10:30:00+02:00')).toBe(Date.parse('2025-06-02T08:30:00Z'))
    expect(fromDayNumber(20_000)).toBe('2024-10-04')
    expect(expirationDate('27MAR26')).toBe('2026-03-27')
    expect(expirationDate('6NOV26')).toBe('2026-11-06')
  })
})

describe('chartWindows', () => {
  it('keeps a short span whole and splits a long one into pages that share their edge candle', () => {
    expect(chartWindows(0, 0, '60')).toEqual([[0, 0]])
    const hour = 3_600_000
    expect(chartWindows(0, 10 * hour, '60')).toEqual([[0, 10 * hour]])
    expect(chartWindows(0, 12 * hour, '60', 5)).toEqual([
      [0, 5 * hour],
      [5 * hour, 10 * hour],
      [10 * hour, 12 * hour],
    ])
    // The daily step is a day.
    expect(chartWindows(0, 3 * 86_400_000, '1D', 2)).toEqual([
      [0, 2 * 86_400_000],
      [2 * 86_400_000, 3 * 86_400_000],
    ])
  })
})

describe('the model', () => {
  it('renames, lets a later key win, keeps what it does not know, and leaves out missing values', () => {
    const row = shape({ instrument_name: 'X', volume_usd: 1, volume_notional: 2, price_change: null, fresh: 'kept' }, { symbol: 'instrument_name', volume_notional: 'volume_usd', change_percent: 'price_change' })
    expect(row).toEqual({ symbol: 'X', volume_notional: 2, fresh: 'kept' })
  })

  it('sorts by several keys like a Python tuple', () => {
    const rows = [{ a: 2, b: 'x' }, { a: 1, b: 'z' }, { a: 1, b: 'y' }]
    expect([...rows].sort(by((r) => r.a, (r) => r.b)).map((r) => r.b)).toEqual(['y', 'z', 'x'])
  })
})
