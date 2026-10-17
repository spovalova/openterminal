import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KINDS } from '@terminal/core'
import openbb from '../src/index.js'
import { BREAKER_MS, buildUrl, changePct, describeHttpError, get, isDown, lastSessionDate, parseOpenbbTime, rangeStartDate, toMarketState, toProviderInterval, toSession } from '../src/openbb-api.js'
import { BASE, NOW, connectionRefused, fakeCtx, fixture, status } from './helpers.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('definition', () => {
  it('answers every kind, needs no key, and defaults to the keyless providers', () => {
    expect(openbb.kinds).toEqual(['search', 'quote', 'ohlcv', 'news', 'earnings'])
    const parsed = openbb.config.parse({})
    expect(parsed.baseUrl).toBe('http://127.0.0.1:6900')
    expect(parsed.providers).toEqual({})
    expect(openbb.config.safeParse({ baseUrl: 'not a url' }).success).toBe(false)
  })
})

describe('time and maps', () => {
  it('parses daily dates as New York midnight and zone-less intraday stamps as New York wall time', () => {
    expect(parseOpenbbTime('2026-10-13')).toBe(Date.UTC(2026, 9, 13, 4, 0)) // EDT is UTC-4
    expect(parseOpenbbTime('2026-10-13T09:30:00')).toBe(Date.UTC(2026, 9, 13, 13, 30))
    expect(parseOpenbbTime('2026-01-13T09:30:00')).toBe(Date.UTC(2026, 0, 13, 14, 30)) // EST is UTC-5
    expect(parseOpenbbTime('2026-10-13T09:30:00Z')).toBe(Date.UTC(2026, 9, 13, 9, 30))
    expect(parseOpenbbTime(null)).toBeNull()
  })
  it('maps ranges to start dates and finds the last session', () => {
    expect(rangeStartDate('3mo', new Date(NOW))).toBe('2026-07-16')
    expect(rangeStartDate('5d', new Date(NOW))).toBe('2026-10-09')
    expect(rangeStartDate('1d', new Date(NOW))).toBe('2026-10-16') // Friday 10:30 ET
    expect(lastSessionDate(new Date(Date.UTC(2026, 9, 17, 12)))).toBe('2026-10-16') // Saturday
    expect(lastSessionDate(new Date(Date.UTC(2026, 9, 19, 12)))).toBe('2026-10-16') // Monday 08:00 ET, before the open
  })
  it('maps intervals, sessions, market states, and percent changes', () => {
    expect(toProviderInterval('yfinance', '1w')).toBe('1W')
    expect(toProviderInterval('yfinance', '5m')).toBe('5m')
    expect(toProviderInterval('fmp', '1h')).toBe('1hour')
    expect(toProviderInterval('cboe', '1d')).toBe('1d')
    expect(toSession('after-hours')).toBe('amc')
    expect(toSession('pre-market')).toBe('bmo')
    expect(toSession('BMO')).toBe('bmo')
    expect(toSession('not-supplied')).toBeNull()
    expect(toMarketState('Closed')).toBe('CLOSED')
    expect(toMarketState('Open')).toBe('REGULAR')
    expect(toMarketState(undefined)).toBeNull()
    expect(changePct({ change_percent: -0.056269 }, 100)).toBe(-5.6269)
    expect(changePct({ prev_close: 931.24 }, 878.84)).toBe(-5.6269)
    expect(changePct({}, 1)).toBeNull()
  })
  it('builds URLs under /api/v1 and drops empty params', () => {
    expect(buildUrl('http://h:1/', '/equity/search', { query: 'micron', provider: 'nasdaq', limit: undefined })).toBe('http://h:1/api/v1/equity/search?query=micron&provider=nasdaq')
  })
})

describe('get', () => {
  it('unwraps the envelope, treats 204 as empty, and explains FastAPI errors', async () => {
    const { ctx, inits } = fakeCtx({
      [`${BASE}/a?provider=x`]: { results: [{ k: 1 }], provider: 'x' },
      [`${BASE}/b?provider=x`]: '',
      [`${BASE}/c?provider=x`]: status(422, JSON.stringify({ detail: [{ msg: "Input should be 'cboe' or 'yfinance'", loc: ['query', 'provider'] }] }), `${BASE}/c`),
    })
    expect(await get(ctx, '/a', { provider: 'x' })).toEqual([{ k: 1 }])
    expect(await get(ctx, '/b', { provider: 'x' })).toEqual([])
    await expect(get(ctx, '/c', { provider: 'x' })).rejects.toThrow("OpenBB 422 on /c: Input should be 'cboe' or 'yfinance'")
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal)
  })
  it('sends basic auth when configured', async () => {
    const { ctx, inits } = fakeCtx({ [`${BASE}/a`]: { results: [] } }, { username: 'u', password: 'p' })
    await get(ctx, '/a', {})
    expect((inits[0]?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })
  it('trips the breaker on a connection failure so later calls fail fast, then retries after the window', async () => {
    const { ctx, calls, logs } = fakeCtx({ [`${BASE}/a`]: connectionRefused() })
    await expect(get(ctx, '/a', {})).rejects.toThrow('OpenBB API not running at http://127.0.0.1:6900')
    expect(isDown()).toBe(true)
    await expect(get(ctx, '/a', {})).rejects.toThrow(/pip install/)
    expect(calls).toHaveLength(1)
    expect(logs[0]).toMatch(/skipping it for 30s/)
    vi.setSystemTime(NOW + BREAKER_MS + 1)
    await expect(get(ctx, '/a', {})).rejects.toThrow(/not running/)
    expect(calls).toHaveLength(2)
  })
  it('keeps a readable message for a plain string detail', () => {
    expect(describeHttpError(status(500, JSON.stringify({ detail: 'boom' }), `${BASE}/equity/price/quote?x=1`))).toBe('OpenBB 500 on /equity/price/quote: boom')
  })
})

describe('health', () => {
  it('lists providers when the API answers and tells the user how to start it when it does not', async () => {
    const up = fakeCtx({ [`${BASE}/coverage/providers`]: fixture('providers') })
    expect(await openbb.health!(up.ctx)).toBe('OpenBB API at http://127.0.0.1:6900 · 3 providers (yfinance, nasdaq, cboe)')
    const down = fakeCtx({ [`${BASE}/coverage/providers`]: connectionRefused() })
    await expect(openbb.health!(down.ctx)).rejects.toThrow(/not running at http:\/\/127\.0\.0\.1:6900\. Install and start it:\npip install "openbb\[routers\]" openbb-yfinance\nopenbb-api/)
  })
})

describe('kinds', () => {
  it('search: one request per query, nasdaq listing codes become exchange names', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/search?query=micron&provider=nasdaq`]: fixture('search-micron') })
    const frame = await openbb.queries.search!({ q: ['micron'] }, ctx)
    expect(frame.columns).toEqual(KINDS.search.columns)
    expect(frame.rows).toEqual([['micron', 'MU', 'Micron Technology, Inc. - Common Stock', 'NASDAQ']])
    expect(frame.meta.connector).toBe('openbb')
  })

  it('quote: one comma-joined request for yfinance, change computed from prev_close, no market state', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/price/quote?symbol=MU%2CSNDK&provider=yfinance`]: fixture('quote-MU-SNDK') })
    const frame = await openbb.queries.quote!({ symbols: ['MU', 'SNDK'] }, ctx)
    expect(frame.columns).toEqual(KINDS.quote.columns)
    expect(frame.rows).toEqual([
      ['SNDK', 1299.3, -6.8489, 8839992, null, null, null],
      ['MU', 878.84, -5.6269, 30145042, null, null, null],
    ])
  })

  it('quote: a symbol with no price (unknown, or an ETF on yfinance) makes the whole query throw so the registry falls back', async () => {
    const etf = { symbol: 'SPY', asset_type: 'ETF', bid: 761.2, ask: 763.35, prev_close: 771.79, volume: 63538029 }
    const { ctx } = fakeCtx({ [`${BASE}/equity/price/quote?symbol=MU%2CSPY%2CZZZZ&provider=yfinance`]: { results: [...(fixture('quote-MU-SNDK') as { results: unknown[] }).results, etf] } })
    await expect(openbb.queries.quote!({ symbols: ['MU', 'SPY', 'ZZZZ'] }, ctx)).rejects.toThrow('yfinance returned no price for SPY, ZZZZ')
  })

  it('quote: a nasdaq row carries market status and a fractional change_percent', async () => {
    const row = { symbol: 'MU', last_price: 878.84, prev_close: 931.24, change_percent: -0.0563, volume: 30515800, market_status: 'Closed' }
    const { ctx } = fakeCtx({ [`${BASE}/equity/price/quote?symbol=MU&provider=nasdaq`]: { results: [row] } }, { providers: { quote: 'nasdaq' } })
    const frame = await openbb.queries.quote!({ symbols: ['MU'] }, ctx)
    expect(frame.rows).toEqual([['MU', 878.84, -5.63, 30515800, 'CLOSED', null, null]])
  })

  it('quote: a provider without comma lists is called once per symbol; a failing symbol fails the table', async () => {
    const { ctx, calls, logs } = fakeCtx(
      {
        [`${BASE}/equity/price/quote?symbol=MU&provider=cboe`]: { results: [{ symbol: 'MU', last_price: 875.41, change_percent: -0.056269 }] },
        [`${BASE}/equity/price/quote?symbol=SNDK&provider=cboe`]: status(500, '{"detail":"upstream"}'),
      },
      { providers: { quote: 'cboe' } },
    )
    await expect(openbb.queries.quote!({ symbols: ['MU', 'SNDK'] }, ctx)).rejects.toThrow('cboe returned no price for SNDK')
    expect(calls).toHaveLength(2)
    expect(logs.some((l) => l.startsWith('skipped SNDK: OpenBB 500'))).toBe(true)
    const ok = await openbb.queries.quote!({ symbols: ['MU'] }, ctx)
    expect(ok.rows).toEqual([['MU', 875.41, -5.6269, null, null, null, null]])
  })

  it('ohlcv: daily bars for two symbols come back sorted by symbol then time with New York midnight stamps', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/price/historical?symbol=MU%2CSNDK&start_date=2026-07-16&interval=1d&provider=yfinance`]: fixture('historical-MU-SNDK-1d') })
    const frame = await openbb.queries.ohlcv!({ symbols: ['MU', 'SNDK'], interval: '1d', range: '3mo' }, ctx)
    expect(frame.columns).toEqual(KINDS.ohlcv.columns)
    expect(frame.rows.map((r) => r[0])).toEqual(['MU', 'MU', 'MU', 'SNDK', 'SNDK', 'SNDK'])
    expect(frame.rows[0]!.slice(0, 3)).toEqual(['MU', Date.UTC(2026, 9, 1, 4), 1054.0799560546875])
    const times = frame.rows.map((r) => r[1] as number)
    expect(times.slice(0, 3)).toEqual([...times.slice(0, 3)].sort((a, b) => a - b))
  })

  it('ohlcv: a single symbol without a symbol field is stamped with the requested one; intraday stamps are exchange time; 1w becomes 1W', async () => {
    const { ctx } = fakeCtx({
      [`${BASE}/equity/price/historical?symbol=NVDA&start_date=2026-10-16&interval=5m&provider=yfinance`]: fixture('historical-NVDA-5m'),
      [`${BASE}/equity/price/historical?symbol=MU&start_date=2025-10-16&interval=1W&provider=yfinance`]: fixture('historical-MU-1W'),
    })
    const intraday = await openbb.queries.ohlcv!({ symbols: ['NVDA'], interval: '5m', range: '1d' }, ctx)
    expect(intraday.rows[0]!.slice(0, 2)).toEqual(['NVDA', Date.UTC(2026, 9, 13, 13, 30)])
    const weekly = await openbb.queries.ohlcv!({ symbols: ['MU'], interval: '1w', range: '1y' }, ctx)
    expect(weekly.rows).toHaveLength(2)
    expect(weekly.rows[0]![0]).toBe('MU')
  })

  it('news: dedupes by url, keeps newest first, caps at limit, and tags the first requested symbol', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/news/company?symbol=MU%2CSNDK&limit=3&provider=nasdaq`]: fixture('news-MU-SNDK') })
    const frame = await openbb.queries.news!({ symbols: ['MU', 'SNDK'], limit: 3 }, ctx)
    expect(frame.columns).toEqual(KINDS.news.columns)
    expect(frame.rows).toHaveLength(3)
    const urls = frame.rows.map((r) => r[3])
    expect(new Set(urls).size).toBe(3)
    expect(frame.rows.every((r) => r[4] === 'MU' || r[4] === 'SNDK')).toBe(true)
    expect(frame.rows[0]![2]).toBeTypeOf('string')
    const times = frame.rows.map((r) => r[1] as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('earnings: filters the market-wide window to our symbols and maps the session word', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/calendar/earnings?start_date=2026-10-17&end_date=2026-12-16&provider=nasdaq`]: fixture('earnings-window') })
    const frame = await openbb.queries.earnings!({ symbols: ['MU', 'SNDK', 'WDC', 'STX'], from: '2026-10-17', to: '2026-12-16' }, ctx)
    expect(frame.columns).toEqual(KINDS.earnings.columns)
    expect(frame.rows).toEqual([
      ['WDC', '2026-10-22', 'amc', 3.97],
      ['STX', '2026-10-27', 'amc', 7.11],
      ['SNDK', '2026-10-29', 'amc', 45.22],
    ])
  })

  it('falls through to the registry when the API is down: every kind throws the not-running message', async () => {
    const { ctx, calls } = fakeCtx({ [`${BASE}/equity/price/quote?symbol=MU&provider=yfinance`]: connectionRefused() })
    await expect(openbb.queries.quote!({ symbols: ['MU'] }, ctx)).rejects.toThrow(/not running/)
    await expect(openbb.queries.news!({ symbols: ['MU'], limit: 5 }, ctx)).rejects.toThrow(/not running/)
    expect(calls).toHaveLength(1)
  })
})
