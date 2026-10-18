import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KINDS, KIND_NAMES } from '@terminal/core'
import openbb from '../src/index.js'
import {
  BREAKER_MS,
  DEFAULT_PROVIDERS,
  buildUrl,
  changePct,
  cleanText,
  countryParam,
  describeHttpError,
  get,
  insiderAction,
  isDown,
  ivRank,
  lastSessionDate,
  maturityLabel,
  parseOpenbbTime,
  pct,
  pickExpiration,
  rangeStartDate,
  strikeWindow,
  toMarketState,
  toProviderInterval,
  toSession,
} from '../src/openbb-api.js'
import { BASE, NOW, connectionRefused, fakeCtx, fixture, status } from './helpers.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('definition', () => {
  it('answers every kind, needs no key, and defaults to the keyless providers', () => {
    expect(openbb.kinds).toEqual([...KIND_NAMES])
    expect(Object.keys(DEFAULT_PROVIDERS).sort()).toEqual([...KIND_NAMES].sort())
    expect(new Set(Object.values(DEFAULT_PROVIDERS))).toEqual(new Set(['nasdaq', 'yfinance', 'sec', 'finra', 'cboe', 'federal_reserve']))
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

// ---------------------------------------------------------------- v1.2 kinds

describe('v1.2 helpers', () => {
  it('scales fractions to percent, cleans calendar cells, maps countries and maturities', () => {
    expect(pct(0.0563)).toBe(5.63)
    expect(pct(1.4875101)).toBe(148.751)
    expect(pct(null)).toBeNull()
    expect(pct('0.1')).toBeNull()
    expect(cleanText(' ')).toBeNull()
    expect(cleanText('-')).toBeNull()
    expect(cleanText('1.390M')).toBe('1.390M')
    expect(cleanText(null)).toBeNull()
    expect(countryParam('United States')).toBe('united_states')
    expect(countryParam('euro area')).toBe('euro_area')
    expect(countryParam('US')).toBe('us')
    expect(maturityLabel('month_1')).toBe('1M')
    expect(maturityLabel('year_10')).toBe('10Y')
    expect(maturityLabel('overnight')).toBe('overnight')
    expect(maturityLabel(null)).toBeNull()
  })
  it('ranks IV inside its one-year range, clamped, null on a flat range', () => {
    expect(ivRank(51.645, 44.442, 107.699)).toBe(11.3869)
    expect(ivRank(10, 20, 30)).toBe(0)
    expect(ivRank(40, 20, 30)).toBe(100)
    expect(ivRank(25, 25, 25)).toBeNull()
    expect(ivRank(null, 1, 2)).toBeNull()
  })
  it('maps insider words to actions for sec and yfinance rows', () => {
    expect(insiderAction('Disposition', 'Open market or private sale of non-derivative or derivative security', null)).toBe('sell')
    expect(insiderAction('Disposition', 'Payment of exercise price or tax liability by delivering or withholding securities', null)).toBe('other')
    expect(insiderAction('Disposition', 'Bona fide gift', null)).toBe('other')
    expect(insiderAction('Acquisition', 'Open market or private purchase of non-derivative or derivative security', null)).toBe('buy')
    expect(insiderAction('Acquisition', 'Grant, award or other acquisition pursuant to Rule 16b-3(d)', null)).toBe('grant')
    expect(insiderAction('Acquisition', 'Exercise or conversion of derivative security exempted pursuant to Rule 16b-3', null)).toBe('other')
    expect(insiderAction(null, '', 'Sale at price 959.14 - 989.59 per share.')).toBe('sell')
    expect(insiderAction(null, '', 'Purchase at price 95.00 per share.')).toBe('buy')
    expect(insiderAction(null, '', 'Stock Award(Grant) at price 0.00 per share.')).toBe('grant')
    expect(insiderAction(null, null, null)).toBe('other')
  })
  it('picks the expiration: snap forward to a listed date, else nearest at least a week out, else nearest tomorrow or later, else the first', () => {
    const listed = [
      { expiration: '2026-10-19', dte: 1 },
      { expiration: '2026-10-23', dte: 5 },
      { expiration: '2026-10-26', dte: 8 },
      { expiration: '2026-11-20', dte: 33 },
    ]
    expect(pickExpiration(listed)?.expiration).toBe('2026-10-26')
    expect(pickExpiration(listed, '2026-10-23')?.expiration).toBe('2026-10-23')
    expect(pickExpiration(listed, '2026-10-24')?.expiration).toBe('2026-10-26')
    expect(pickExpiration(listed, '2026-11-21')).toBeNull()
    expect(pickExpiration(listed.slice(0, 2))?.expiration).toBe('2026-10-19')
    expect(pickExpiration([{ expiration: '2026-10-18', dte: 0 }])?.expiration).toBe('2026-10-18')
    expect(pickExpiration([])).toBeNull()
  })
  it('keeps the n strikes nearest the price on each side and a strike equal to the price', () => {
    const strikes = [330, 335, 340, 342.5, 345, 350, 355, 340, 345]
    expect(strikeWindow(strikes, 342.62, 2)).toEqual([340, 342.5, 345, 350])
    expect(strikeWindow(strikes, 340, 1)).toEqual([335, 340, 342.5])
    expect(strikeWindow(strikes, 342.62, 30)).toEqual([330, 335, 340, 342.5, 345, 350, 355])
    expect(strikeWindow(strikes, 1000, 2)).toEqual([350, 355])
  })
})

describe('profile', () => {
  it('one comma-joined request, rows in the requested order with yfinance field names mapped', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/profile?symbol=MU%2CAAPL&provider=yfinance`]: fixture('profile-MU-AAPL') })
    const frame = await openbb.queries.profile!({ symbols: ['MU', 'AAPL'] }, ctx)
    expect(frame.columns).toEqual(KINDS.profile.columns)
    expect(frame.rows).toEqual([
      ['MU', 'Micron Technology, Inc.', 'NMS', 'Technology', 'Semiconductors', 994340044800, 61000, 2.226, 'Micron Technology, Inc.'],
      ['AAPL', 'Apple Inc.', 'NMS', 'Technology', 'Consumer Electronics', 5012516765696, 150000, 1.069, 'Apple Inc.'],
    ])
  })
  it('logs a symbol the provider dropped and throws when it dropped every one (204)', async () => {
    const { ctx, logs } = fakeCtx({
      [`${BASE}/equity/profile?symbol=MU%2CZZZZ&provider=yfinance`]: fixture('profile-MU-AAPL'),
      [`${BASE}/equity/profile?symbol=ZZZZ&provider=yfinance`]: '',
    })
    const partial = await openbb.queries.profile!({ symbols: ['MU', 'ZZZZ'] }, ctx)
    expect(partial.rows.map((r) => r[0])).toEqual(['MU'])
    expect(logs).toContain('yfinance: no profile for ZZZZ')
    await expect(openbb.queries.profile!({ symbols: ['ZZZZ'] }, ctx)).rejects.toThrow('yfinance returned no profile for ZZZZ')
  })
})

describe('metrics', () => {
  it('scales margins, growth and ROE to percent, passes dividend_yield through, and turns debt_to_equity into a ratio', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/fundamental/metrics?symbol=AAPL%2CMSFT%2CMU&provider=yfinance`]: fixture('metrics-AAPL-MSFT-MU') })
    const frame = await openbb.queries.metrics!({ symbols: ['AAPL', 'MSFT', 'MU'] }, ctx)
    expect(frame.columns).toEqual(KINDS.metrics.columns)
    expect(frame.rows[0]).toEqual(['AAPL', 5012516765696, 39.38761, 35.85982, 2.75, 29.974, 10.785, 46.66576, 48.653, 32.623, 27.619, 16.4, 28.7, 148.751, 0.78445, 0.31])
    expect(frame.rows.map((r) => r[0])).toEqual(['AAPL', 'MSFT', 'MU'])
    expect(frame.rows[2]![15]).toBe(0.07) // MU's yield is 0.07 percent, not 7
  })
  it('throws on a 204 so the registry falls back', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/fundamental/metrics?symbol=ZZZZ&provider=yfinance`]: '' })
    await expect(openbb.queries.metrics!({ symbols: ['ZZZZ'] }, ctx)).rejects.toThrow('yfinance returned no metrics for ZZZZ')
  })
})

describe('financials', () => {
  const urls = (symbol: string, period: string, limit: number) => ['income', 'cash', 'balance'].map((st) => `${BASE}/equity/fundamental/${st}?symbol=${symbol}&period=${period}&limit=${limit}&provider=yfinance`)
  it('joins income, cash and balance on period_ending, newest first, capex positive, fcf = ocf − capex', async () => {
    const [income, cash, balance] = urls('MU', 'quarter', 3)
    const { ctx, calls } = fakeCtx({ [income!]: fixture('financials-income-MU'), [cash!]: fixture('financials-cash-MU'), [balance!]: fixture('financials-balance-MU') })
    const frame = await openbb.queries.financials!({ symbols: ['MU'], period: 'quarter', limit: 3 }, ctx)
    expect(frame.columns).toEqual(KINDS.financials.columns)
    expect(calls).toHaveLength(3)
    expect(frame.rows[0]).toEqual(['MU', '2026-05-31', 41456000000, 35056000000, 33318000000, 28243000000, 24.67, 25388000000, 7826000000, 17562000000, 24995000000, 6376000000, 1129393151])
    expect(frame.rows.map((r) => r[1])).toEqual(['2026-05-31', '2026-02-28', '2025-11-30'])
  })
  it('cuts to limit, keeps the income rows when a statement fails (shares fall back to diluted weighted average), throws when all three fail', async () => {
    const [income, cash, balance] = urls('MU', 'annual', 2)
    const { ctx, logs } = fakeCtx({ [income!]: fixture('financials-income-MU'), [cash!]: fixture('financials-cash-MU'), [balance!]: status(500, '{"detail":"upstream"}') })
    const frame = await openbb.queries.financials!({ symbols: ['MU'], period: 'annual', limit: 2 }, ctx)
    expect(frame.rows).toHaveLength(2)
    expect(frame.rows[0]!.slice(10)).toEqual([null, null, 1145000000])
    expect(logs.some((l) => l.startsWith('skipped MU balance: OpenBB 500'))).toBe(true)
    const down = fakeCtx(Object.fromEntries(urls('ZZZZ', 'quarter', 4).map((u) => [u, status(500, '{"detail":"nope"}')])))
    await expect(openbb.queries.financials!({ symbols: ['ZZZZ'], period: 'quarter', limit: 4 }, down.ctx)).rejects.toThrow('OpenBB 500')
    const empty = fakeCtx(Object.fromEntries(urls('ZZZZ', 'quarter', 4).map((u) => [u, { results: [] }])))
    await expect(openbb.queries.financials!({ symbols: ['ZZZZ'], period: 'quarter', limit: 4 }, empty.ctx)).rejects.toThrow('yfinance returned no financials for ZZZZ')
  })
})

describe('estimates', () => {
  it('merges consensus with the yfinance 0q and 0y EPS estimates; upside and growth are percent', async () => {
    const { ctx } = fakeCtx({
      [`${BASE}/equity/estimates/consensus?symbol=MU%2CAAPL&provider=yfinance`]: fixture('estimates-consensus-MU-AAPL'),
      [`${BASE}/yfinance/estimates/earnings?symbol=MU%2CAAPL`]: fixture('estimates-earnings-MU-AAPL'),
    })
    const frame = await openbb.queries.estimates!({ symbols: ['MU', 'AAPL'] }, ctx)
    expect(frame.columns).toEqual(KINDS.estimates.columns)
    expect(frame.rows).toEqual([
      ['MU', 'strong_buy', 46, 361, 1560.5652, 3000, 77.571, 38.27861, 176.54659, 133.77],
      ['AAPL', 'buy', 39, 215, 329.3759, 405, -4.1007, 1.97842, 8.82006, 18.23],
    ])
  })
  it('keeps the consensus columns when the EPS route fails, and throws when both answer nothing', async () => {
    const { ctx, logs } = fakeCtx({
      [`${BASE}/equity/estimates/consensus?symbol=MU&provider=yfinance`]: fixture('estimates-consensus-MU-AAPL'),
      [`${BASE}/yfinance/estimates/earnings?symbol=MU`]: status(500, '{"detail":"boom"}'),
    })
    const frame = await openbb.queries.estimates!({ symbols: ['MU'] }, ctx)
    expect(frame.rows).toEqual([['MU', 'strong_buy', 46, 361, 1560.5652, 3000, 77.571, null, null, null]])
    expect(logs.some((l) => l.startsWith('skipped eps estimates'))).toBe(true)
    const empty = fakeCtx({ [`${BASE}/equity/estimates/consensus?symbol=ZZZZ&provider=yfinance`]: '', [`${BASE}/yfinance/estimates/earnings?symbol=ZZZZ`]: '' })
    await expect(openbb.queries.estimates!({ symbols: ['ZZZZ'] }, empty.ctx)).rejects.toThrow('yfinance returned no estimates for ZZZZ')
  })
})

describe('eps_history', () => {
  it('newest first per symbol in the requested order, the next report carries the estimate only, surprise already percent', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/fundamental/historical_eps?symbol=AAPL%2CMU&limit=3&provider=yfinance`]: fixture('eps-history-MU-AAPL') })
    const frame = await openbb.queries.eps_history!({ symbols: ['AAPL', 'MU'], limit: 3 }, ctx)
    expect(frame.columns).toEqual(KINDS.eps_history.columns)
    expect(frame.rows).toEqual([
      ['AAPL', '2026-11-02', null, 1.98, null],
      ['AAPL', '2026-07-30', 2.02, 1.89, 6.74],
      ['AAPL', '2026-04-30', 2.01, 1.94, 3.46],
      ['MU', '2026-12-23', null, 38.28, null],
      ['MU', '2026-09-30', 33.42, 31.82, 5.03],
      ['MU', '2026-06-24', 25.11, 20.69, 21.39],
    ])
  })
  it('cuts to limit locally when the provider returns more, and throws on 204', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/fundamental/historical_eps?symbol=MU&limit=1&provider=yfinance`]: fixture('eps-history-MU-AAPL'), [`${BASE}/equity/fundamental/historical_eps?symbol=ZZZZ&limit=8&provider=yfinance`]: '' })
    const frame = await openbb.queries.eps_history!({ symbols: ['MU'], limit: 1 }, ctx)
    expect(frame.rows).toEqual([['MU', '2026-12-23', null, 38.28, null]])
    await expect(openbb.queries.eps_history!({ symbols: ['ZZZZ'], limit: 8 }, ctx)).rejects.toThrow('yfinance returned no eps history for ZZZZ')
  })
})

describe('dividends', () => {
  it('one request per symbol (the route is single-symbol), rows stamped with the symbol, newest first, cut to limit', async () => {
    const { ctx, calls } = fakeCtx({ [`${BASE}/equity/fundamental/dividends?symbol=AAPL&provider=yfinance`]: fixture('dividends-AAPL'), [`${BASE}/equity/fundamental/dividends?symbol=MU&provider=yfinance`]: { results: [{ ex_dividend_date: '2026-10-14', amount: 0.15 }] } })
    const frame = await openbb.queries.dividends!({ symbols: ['AAPL', 'MU'], limit: 3 }, ctx)
    expect(frame.columns).toEqual(KINDS.dividends.columns)
    expect(calls).toHaveLength(2)
    expect(frame.rows).toEqual([
      ['AAPL', '2026-08-10', 0.27],
      ['AAPL', '2026-05-11', 0.27],
      ['AAPL', '2026-02-09', 0.26],
      ['MU', '2026-10-14', 0.15],
    ])
  })
  it('a 400 for one symbol is skipped; a 400 for every symbol throws', async () => {
    const err = () => status(400, JSON.stringify({ detail: "Error getting data for ZZZZ: 'NoneType' object has no attribute 'empty'" }))
    const { ctx, logs } = fakeCtx({ [`${BASE}/equity/fundamental/dividends?symbol=AAPL&provider=yfinance`]: fixture('dividends-AAPL'), [`${BASE}/equity/fundamental/dividends?symbol=ZZZZ&provider=yfinance`]: err() })
    const frame = await openbb.queries.dividends!({ symbols: ['AAPL', 'ZZZZ'], limit: 2 }, ctx)
    expect(frame.rows).toHaveLength(2)
    expect(logs.some((l) => l.startsWith('skipped ZZZZ: OpenBB 400'))).toBe(true)
    await expect(openbb.queries.dividends!({ symbols: ['ZZZZ'], limit: 2 }, ctx)).rejects.toThrow('OpenBB 400')
  })
})

describe('insiders', () => {
  it('sec Form 4 rows: action from the transaction code, value = shares × price, holdings-only rows (no date) dropped, newest first', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/ownership/insider_trading?symbol=MU&limit=20&provider=sec`]: fixture('insiders-MU') })
    const frame = await openbb.queries.insiders!({ symbols: ['MU'], limit: 20 }, ctx)
    expect(frame.columns).toEqual(KINDS.insiders.columns)
    expect(frame.rows).toHaveLength(6)
    expect(frame.rows[0]).toEqual(['MU', '2026-10-14', 'RAY MICHAEL CHARLES', 'SVP, Chief Legal Officer', 'sell', 40, 947.29, 37891.6, 'https://www.sec.gov/Archives/edgar/data/723125/000159319926000005/primarydocument.xml'])
    expect(frame.rows.map((r) => r[4])).toEqual(['sell', 'grant', 'other', 'other', 'sell', 'other'])
    expect(frame.rows[1]!.slice(5, 8)).toEqual([21233, 0, 0]) // a grant at no price
  })
  it('cuts to limit per symbol and calls sec once per symbol; yfinance rows use description and transaction_value', async () => {
    const { ctx, calls } = fakeCtx({ [`${BASE}/equity/ownership/insider_trading?symbol=MU&limit=2&provider=sec`]: fixture('insiders-MU'), [`${BASE}/equity/ownership/insider_trading?symbol=AAPL&limit=2&provider=sec`]: '' })
    const frame = await openbb.queries.insiders!({ symbols: ['MU', 'AAPL'], limit: 2 }, ctx)
    expect(calls).toHaveLength(2)
    expect(frame.rows.map((r) => [r[0], r[1]])).toEqual([
      ['MU', '2026-10-14'],
      ['MU', '2026-10-13'],
    ])
    const yf = { symbol: 'MU', transaction_date: '2026-08-21', owner_name: 'MEHROTRA SANJAY', owner_title: 'Chief Executive Officer', transaction_type: '', securities_transacted: 40000, filing_url: '', transaction_value: 38756162, description: 'Sale at price 959.14 - 989.59 per share.' }
    const alt = fakeCtx({ [`${BASE}/equity/ownership/insider_trading?symbol=MU&limit=5&provider=yfinance`]: { results: [yf] } }, { providers: { insiders: 'yfinance' } })
    const f2 = await openbb.queries.insiders!({ symbols: ['MU'], limit: 5 }, alt.ctx)
    expect(f2.rows).toEqual([['MU', '2026-08-21', 'MEHROTRA SANJAY', 'Chief Executive Officer', 'sell', 40000, 968.9, 38756000, null]])
    await expect(openbb.queries.insiders!({ symbols: ['AAPL'], limit: 2 }, ctx)).rejects.toThrow('sec returned no insider transactions for AAPL')
  })
})

describe('institutions', () => {
  it('nasdaq holders: market_value is thousands of dollars (×1000), change a fraction (percent), sorted by value, cut to limit', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/ownership/institutional?symbol=MU&limit=3&provider=nasdaq`]: fixture('institutions-MU') })
    const frame = await openbb.queries.institutions!({ symbols: ['MU'], limit: 3 }, ctx)
    expect(frame.columns).toEqual(KINDS.institutions.columns)
    expect(frame.rows).toEqual([
      ['MU', '2025-12-31', 'Vanguard Group Inc', 106608094, 1.868, 93691457000],
      ['MU', '2026-06-30', 'Blackrock, Inc.', 104827219, 1.628, 92126353000],
      ['MU', '2026-06-30', 'Vanguard Capital Management Llc', 73659544, 0.714, 64734954000],
    ])
  })
  it('the yfinance provider uses its namespaced route with dollar values; an unknown symbol (400) throws', async () => {
    const yf = { symbol: 'MU', date_reported: '2026-06-30', holder: 'Blackrock Inc.', percent_held: 0.0927, shares: 104827219, value: 92126355961, percent_change: 0.0163 }
    const { ctx } = fakeCtx({ [`${BASE}/yfinance/ownership/institutional?symbol=MU`]: { results: [yf] } }, { providers: { institutions: 'yfinance' } })
    const frame = await openbb.queries.institutions!({ symbols: ['MU'], limit: 5 }, ctx)
    expect(frame.rows).toEqual([['MU', '2026-06-30', 'Blackrock Inc.', 104827219, 1.63, 92126355961]])
    const bad = fakeCtx({ [`${BASE}/equity/ownership/institutional?symbol=ZZZZ&limit=20&provider=nasdaq`]: status(400, '{"detail":"Nasdaq request failed. Symbol not exists."}') })
    await expect(openbb.queries.institutions!({ symbols: ['ZZZZ'], limit: 20 }, bad.ctx)).rejects.toThrow('OpenBB 400')
  })
})

describe('short_interest', () => {
  it('finra: one comma-joined call, full history oldest first becomes newest first per symbol cut to limit, change_pct already percent', async () => {
    const { ctx, calls } = fakeCtx({ [`${BASE}/equity/shorts/short_interest?symbol=MU%2CAAPL&provider=finra`]: fixture('short-interest-MU-AAPL') })
    const frame = await openbb.queries.short_interest!({ symbols: ['MU', 'AAPL'], limit: 2 }, ctx)
    expect(frame.columns).toEqual(KINDS.short_interest.columns)
    expect(calls).toHaveLength(1)
    expect(frame.rows).toEqual([
      ['MU', '2026-09-30', 26023190, -5.83, 24483420, 1.06],
      ['MU', '2026-09-15', 27633780, -6.97, 25064802, 1.1],
      ['AAPL', '2026-09-30', 120763539, -6.21, 39858260, 3.03],
      ['AAPL', '2026-09-15', 128753092, -7.87, 45135477, 2.85],
    ])
  })
  it('nasdaq change_pct is a fraction and is scaled; a 204 throws', async () => {
    const row = { settlement_date: '2026-09-30', symbol: 'MU', current_short_position: 26023190, previous_short_position: 27633780, avg_daily_volume: 24483420, days_to_cover: 1.06289, change_pct: -0.05828337636038211 }
    const { ctx } = fakeCtx({ [`${BASE}/equity/shorts/short_interest?symbol=MU&provider=nasdaq`]: { results: [row] }, [`${BASE}/equity/shorts/short_interest?symbol=ZZZZ&provider=nasdaq`]: '' }, { providers: { short_interest: 'nasdaq' } })
    const frame = await openbb.queries.short_interest!({ symbols: ['MU'], limit: 12 }, ctx)
    expect(frame.rows).toEqual([['MU', '2026-09-30', 26023190, -5.8283, 24483420, 1.06289]])
    await expect(openbb.queries.short_interest!({ symbols: ['ZZZZ'], limit: 12 }, ctx)).rejects.toThrow('nasdaq returned no short interest for ZZZZ')
  })
})

describe('options', () => {
  const chain = `${BASE}/derivatives/options/chains?symbol=AAPL&provider=cboe`
  it('omitted expiration: nearest at least 7 days out; the strike window straddles the underlying; calls before puts; iv is percent', async () => {
    const { ctx } = fakeCtx({ [chain]: fixture('options-AAPL') })
    const frame = await openbb.queries.options!({ symbol: 'AAPL', strikes: 2, type: 'both' }, ctx)
    expect(frame.columns).toEqual(KINDS.options.columns)
    expect(frame.rows).toHaveLength(8)
    expect(frame.rows[0]).toEqual(['AAPL', '2026-10-26', 'call', 340, 6, 8, 6.7, 148, 343, 21.57, 0.6168, 0.0278, -0.266, 0.2176, 342.62, 8])
    expect(frame.rows.map((r) => [r[3], r[2]])).toEqual([
      [340, 'call'],
      [340, 'put'],
      [342.5, 'call'],
      [342.5, 'put'],
      [345, 'call'],
      [345, 'put'],
      [347.5, 'call'],
      [347.5, 'put'],
    ])
    expect(new Set(frame.rows.map((r) => r[1]))).toEqual(new Set(['2026-10-26']))
  })
  it('a given expiration snaps forward to the first listed date on or after it, or is used exactly when listed', async () => {
    const { ctx } = fakeCtx({ [chain]: fixture('options-AAPL') })
    const snapped = await openbb.queries.options!({ symbol: 'AAPL', expiration: '2026-10-24', strikes: 1, type: 'both' }, ctx)
    expect(snapped.rows.map((r) => [r[1], r[3], r[2], r[15]])).toEqual([
      ['2026-10-26', 342.5, 'call', 8],
      ['2026-10-26', 342.5, 'put', 8],
      ['2026-10-26', 345, 'call', 8],
      ['2026-10-26', 345, 'put', 8],
    ])
    const exact = await openbb.queries.options!({ symbol: 'AAPL', expiration: '2026-10-23', strikes: 1, type: 'both' }, ctx)
    expect(exact.rows.map((r) => r[1])).toEqual(['2026-10-23', '2026-10-23', '2026-10-23', '2026-10-23'])
    expect(exact.rows[0]![15]).toBe(5)
    const monthly = await openbb.queries.options!({ symbol: 'AAPL', expiration: '2026-11-01', strikes: 2, type: 'put' }, ctx)
    expect(monthly.rows.map((r) => [r[1], r[3], r[2]])).toEqual([
      ['2026-11-20', 335, 'put'],
      ['2026-11-20', 340, 'put'],
      ['2026-11-20', 345, 'put'],
      ['2026-11-20', 350, 'put'],
    ])
  })
  it('type filters, a wide window returns the whole expiration, and the error paths name the problem', async () => {
    const { ctx } = fakeCtx({ [chain]: fixture('options-AAPL'), [`${BASE}/derivatives/options/chains?symbol=ZZZZ&provider=cboe`]: '', [`${BASE}/derivatives/options/chains?symbol=QQQQ&provider=cboe`]: status(400, '{"detail":"QQQQ was not found in the Cboe options directory."}', `${BASE}/derivatives/options/chains?symbol=QQQQ&provider=cboe`) })
    const calls = await openbb.queries.options!({ symbol: 'AAPL', strikes: 1, type: 'call' }, ctx)
    expect(calls.rows.map((r) => [r[3], r[2]])).toEqual([
      [342.5, 'call'],
      [345, 'call'],
    ])
    const all = await openbb.queries.options!({ symbol: 'AAPL', strikes: 30, type: 'both' }, ctx)
    expect(all.rows).toHaveLength(14)
    await expect(openbb.queries.options!({ symbol: 'AAPL', expiration: '2027-01-01', strikes: 10, type: 'both' }, ctx)).rejects.toThrow('AAPL has no expiration on or after 2027-01-01 (last listed 2026-11-20)')
    await expect(openbb.queries.options!({ symbol: 'ZZZZ', strikes: 10, type: 'both' }, ctx)).rejects.toThrow('cboe returned no option chain for ZZZZ')
    await expect(openbb.queries.options!({ symbol: 'QQQQ', strikes: 10, type: 'both' }, ctx)).rejects.toThrow('OpenBB 400 on /derivatives/options/chains: QQQQ was not found')
  })
})

describe('volatility', () => {
  it('cboe quotes one symbol per call; IV and HV ranges become percent, iv_rank is computed, hv30 spot is null (cboe has no field)', async () => {
    const { ctx, calls } = fakeCtx({ [`${BASE}/equity/price/quote?symbol=MU&provider=cboe`]: fixture('volatility-MU'), [`${BASE}/equity/price/quote?symbol=AAPL&provider=cboe`]: fixture('volatility-AAPL') })
    const frame = await openbb.queries.volatility!({ symbols: ['MU', 'AAPL'] }, ctx)
    expect(frame.columns).toEqual(KINDS.volatility.columns)
    expect(calls).toHaveLength(2)
    expect(frame.rows[0]).toEqual(['MU', 51.645, 107.699, 44.442, 11.3869, null, 125.106, 44.3088, 1255, 192.39999389648438])
    expect(frame.rows[1]![0]).toBe('AAPL')
  })
  it('an unknown symbol (cboe 500) is skipped when others answer and throws when alone', async () => {
    const boom = status(500, '{"detail":"Unexpected Error -> ContentTypeError -> 403"}')
    const { ctx, logs } = fakeCtx({ [`${BASE}/equity/price/quote?symbol=MU&provider=cboe`]: fixture('volatility-MU'), [`${BASE}/equity/price/quote?symbol=ZZZZ&provider=cboe`]: boom })
    const frame = await openbb.queries.volatility!({ symbols: ['MU', 'ZZZZ'] }, ctx)
    expect(frame.rows).toHaveLength(1)
    expect(logs.some((l) => l.startsWith('skipped ZZZZ: OpenBB 500'))).toBe(true)
    await expect(openbb.queries.volatility!({ symbols: ['ZZZZ'] }, ctx)).rejects.toThrow('OpenBB 500')
  })
})

describe('calendar', () => {
  it('maps the country to the route form, parses zone-less stamps as New York wall time, and turns "-" and blank into null', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/economy/calendar?start_date=2026-10-19&end_date=2026-10-23&country=united_states&provider=nasdaq`]: fixture('calendar-US') })
    const frame = await openbb.queries.calendar!({ from: '2026-10-19', to: '2026-10-23', country: 'United States' }, ctx)
    expect(frame.columns).toEqual(KINDS.calendar.columns)
    expect(frame.rows).toHaveLength(6)
    expect(frame.rows[0]).toEqual([Date.UTC(2026, 9, 21, 12, 15), 'United States', 'ADP Employment Change Weekly', null, null, '24.80K'])
    expect(frame.rows[1]).toEqual([Date.UTC(2026, 9, 21, 12, 30), 'United States', 'Building Permits', null, '1.390M', '1.403M'])
    const times = frame.rows.map((r) => r[0] as number)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
  it('an empty window (204) is an empty frame, not an error', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/economy/calendar?start_date=2026-12-25&end_date=2026-12-25&country=germany&provider=nasdaq`]: '' })
    const frame = await openbb.queries.calendar!({ from: '2026-12-25', to: '2026-12-25', country: 'Germany' }, ctx)
    expect(frame.rows).toEqual([])
  })
})

describe('ipos', () => {
  const url = (status: string, from: string, to: string) => `${BASE}/equity/calendar/ipo?start_date=${from}&end_date=${to}&status=${status}&provider=nasdaq`
  it('fetches priced and upcoming, cuts to the window (nasdaq answers whole months), sorts by date then symbol', async () => {
    const { ctx, calls } = fakeCtx({ [url('priced', '2026-09-17', '2026-09-18')]: fixture('ipos-window'), [url('upcoming', '2026-09-17', '2026-09-18')]: '' })
    const frame = await openbb.queries.ipos!({ from: '2026-09-17', to: '2026-09-18' }, ctx)
    expect(frame.columns).toEqual(KINDS.ipos.columns)
    expect(calls).toHaveLength(2)
    expect(frame.rows).toEqual([
      ['HYACU', '2026-09-17', 'Haymaker Acquisition Corp V', 'NYSE', 10, 250000000, 'Priced'],
      ['ETRA', '2026-09-18', 'Electra Therapeutics, Inc.', 'NASDAQ Global Select', 15, 350000010, 'Priced'],
      ['OIG', '2026-09-18', 'Orion180 Insurance Group Inc.', 'NASDAQ Global Select', 12, 240000000, 'Priced'],
    ])
  })
  it('one failing status is logged; both failing throws', async () => {
    const { ctx, logs } = fakeCtx({ [url('priced', '2026-09-01', '2026-09-30')]: status(500, '{"detail":"x"}'), [url('upcoming', '2026-09-01', '2026-09-30')]: fixture('ipos-window') })
    const frame = await openbb.queries.ipos!({ from: '2026-09-01', to: '2026-09-30' }, ctx)
    expect(frame.rows).toHaveLength(5)
    expect(logs.some((l) => l.startsWith('skipped priced IPOs'))).toBe(true)
    const down = fakeCtx({ [url('priced', '2026-09-01', '2026-09-30')]: status(500, '{"detail":"x"}'), [url('upcoming', '2026-09-01', '2026-09-30')]: status(500, '{"detail":"y"}') })
    await expect(openbb.queries.ipos!({ from: '2026-09-01', to: '2026-09-30' }, down.ctx)).rejects.toThrow('OpenBB 500')
  })
})

describe('movers', () => {
  it('maps the list to a nasdaq category, scales change_percent, keeps nasdaq ordering (min_price 0 = the raw list)', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/nasdaq/markets/movers?category=most_advanced&limit=5&provider=nasdaq`]: fixture('movers-advanced'), [`${BASE}/nasdaq/markets/movers?category=most_active_share_volume&limit=2&provider=nasdaq`]: fixture('movers-active') }, { providers: { movers: 'nasdaq' } })
    const gainers = await openbb.queries.movers!({ list: 'gainers', limit: 5, min_price: 0 }, ctx)
    expect(gainers.columns).toEqual(KINDS.movers.columns)
    expect(gainers.rows[0]).toEqual(['XLABW', 'Exascale Labs Holdings Inc. Warrant', 0.195, 176.204, null])
    expect(gainers.rows).toHaveLength(5)
    const active = await openbb.queries.movers!({ list: 'active', limit: 2, min_price: 0 }, ctx)
    expect(active.rows).toEqual([
      ['HODO', 'House of Doge Inc. Common Stock', 0.0928, 37.4815, 561137454.657995],
      ['NWGL', 'Nature Wood Group Limited', 0.234, 5.8824, 325038361.496217],
    ])
  })
  it('yfinance (the default) runs the day_gainers screener preset with price_min', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/equity/screener?preset=day_gainers&limit=5&price_min=5&provider=yfinance`]: fixture('movers-yfinance-gainers') }, { providers: { movers: 'yfinance' } })
    const gainers = await openbb.queries.movers!({ list: 'gainers', limit: 5, min_price: 5 }, ctx)
    expect(gainers.columns).toEqual(KINDS.movers.columns)
    expect(gainers.rows[0]).toEqual(['CRGY', 'Crescent Energy Company', 13.77, 10.0719, 22337914])
    expect(gainers.rows).toHaveLength(5)
  })
  it('nasdaq: min_price drops sub-dollar names and asks the provider for a deeper list', async () => {
    const { ctx, calls } = fakeCtx({ [`${BASE}/nasdaq/markets/movers?category=most_advanced&limit=25&provider=nasdaq`]: fixture('movers-advanced') }, { providers: { movers: 'nasdaq' } })
    const gainers = await openbb.queries.movers!({ list: 'gainers', limit: 5, min_price: 1 }, ctx)
    expect(calls).toHaveLength(1)
    expect(gainers.rows.map((r) => r[0])).toEqual(['XLAB'])
    await expect(openbb.queries.movers!({ list: 'gainers', limit: 5, min_price: 5 }, ctx)).rejects.toThrow('nasdaq returned no gainers list')
  })
  it('losers is most_declined; an empty list throws', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/nasdaq/markets/movers?category=most_declined&limit=20&provider=nasdaq`]: '' }, { providers: { movers: 'nasdaq' } })
    await expect(openbb.queries.movers!({ list: 'losers', limit: 20, min_price: 0 }, ctx)).rejects.toThrow('nasdaq returned no losers list')
  })
})

describe('holdings', () => {
  it('stamps the ETF, scales weight to percent, sorts by weight', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/etf/holdings?symbol=SMH&provider=nasdaq`]: fixture('holdings-SMH') })
    const frame = await openbb.queries.holdings!({ symbol: 'SMH' }, ctx)
    expect(frame.columns).toEqual(KINDS.holdings.columns)
    expect(frame.rows).toHaveLength(10)
    expect(frame.rows[0]).toEqual(['SMH', 'NVDA', 'NVIDIA Corporation Common Stock', 19.59])
    expect(frame.rows[4]).toEqual(['SMH', 'MU', 'Micron Technology, Inc. Common Stock', 4.88])
    const weights = frame.rows.map((r) => r[3] as number)
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })
  it('an unknown ETF (400) and an empty answer both throw', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/etf/holdings?symbol=ZZZZ&provider=nasdaq`]: status(400, '{"detail":"Symbol not exists."}'), [`${BASE}/etf/holdings?symbol=EMPT&provider=nasdaq`]: '' })
    await expect(openbb.queries.holdings!({ symbol: 'ZZZZ' }, ctx)).rejects.toThrow('OpenBB 400')
    await expect(openbb.queries.holdings!({ symbol: 'EMPT' }, ctx)).rejects.toThrow('nasdaq returned no holdings for EMPT')
  })
})

describe('macro', () => {
  const fed = (path: string) => `${BASE}${path}?start_date=2026-04-16&provider=federal_reserve`
  const routes = {
    [fed('/fixedincome/government/treasury_rates')]: fixture('macro-treasury'),
    [fed('/fixedincome/rate/effr')]: fixture('macro-effr'),
    [fed('/fixedincome/rate/sofr')]: fixture('macro-sofr'),
    [fed('/economy/money_measures')]: fixture('macro-m2'),
    [`${BASE}/economy/cpi?country=united_states&transform=yoy&frequency=monthly&start_date=2026-04-16&provider=oecd`]: fixture('macro-cpi'),
    [`${BASE}/economy/unemployment?country=united_states&frequency=monthly&start_date=2026-04-16&provider=oecd`]: fixture('macro-unemployment'),
  }
  it('calls only the routes the series need (one treasury call for four yields and the spread), scales to percent, sorts by series then time', async () => {
    const { ctx, calls } = fakeCtx(routes)
    const frame = await openbb.queries.macro!({ series: ['treasury_10y', 'spread_10y_2y', 'fed_funds', 'cpi_yoy', 'm2'], range: '6mo' }, ctx)
    expect(frame.columns).toEqual(KINDS.macro.columns)
    expect(calls).toHaveLength(4)
    expect(calls.some((c) => c.includes('/sofr'))).toBe(false)
    const oct1 = Date.UTC(2026, 9, 1, 4)
    expect(frame.rows).toEqual([
      ['cpi_yoy', Date.UTC(2026, 0, 1, 5), 2.3864],
      ['cpi_yoy', Date.UTC(2026, 1, 1, 5), 2.4141],
      ['fed_funds', oct1, 3.88],
      ['fed_funds', Date.UTC(2026, 9, 2, 4), 3.88],
      ['m2', Date.UTC(2026, 0, 1, 5), 22459500000000],
      ['m2', Date.UTC(2026, 1, 1, 5), 22510600000000],
      ['spread_10y_2y', oct1, 0.46],
      ['spread_10y_2y', Date.UTC(2026, 9, 2, 4), 0.45],
      ['spread_10y_2y', Date.UTC(2026, 9, 5, 4), 0.47],
      ['treasury_10y', oct1, 5.24],
      ['treasury_10y', Date.UTC(2026, 9, 2, 4), 5.28],
      ['treasury_10y', Date.UTC(2026, 9, 5, 4), 5.31],
    ])
  })
  it('every treasury series comes from the same call; sofr and unemployment have their own', async () => {
    const { ctx, calls } = fakeCtx(routes)
    const frame = await openbb.queries.macro!({ series: ['treasury_3m', 'treasury_2y', 'treasury_30y', 'sofr', 'unemployment'], range: '6mo' }, ctx)
    expect(calls).toHaveLength(3)
    expect(frame.rows.filter((r) => r[0] === 'treasury_3m').map((r) => r[2])).toEqual([4.17, 4.19, 4.22])
    expect(frame.rows.filter((r) => r[0] === 'treasury_30y').map((r) => r[2])).toEqual([5.61, 5.63, 5.66])
    expect(frame.rows.filter((r) => r[0] === 'sofr').map((r) => r[2])).toEqual([3.87, 3.88])
    expect(frame.rows.filter((r) => r[0] === 'unemployment').map((r) => r[2])).toEqual([4.7, 4.7])
  })
  it('a failing route is skipped with a log; every route failing throws; the range sets start_date', async () => {
    const { ctx, logs, calls } = fakeCtx({ ...routes, [fed('/fixedincome/rate/effr')]: status(500, '{"detail":"fed down"}', fed('/fixedincome/rate/effr')) })
    const frame = await openbb.queries.macro!({ series: ['fed_funds', 'treasury_2y'], range: '6mo' }, ctx)
    expect(frame.rows.map((r) => r[0])).toEqual(['treasury_2y', 'treasury_2y', 'treasury_2y'])
    expect(logs.some((l) => l.startsWith('skipped effr: OpenBB 500'))).toBe(true)
    await expect(openbb.queries.macro!({ series: ['fed_funds'], range: '6mo' }, ctx)).rejects.toThrow('OpenBB 500 on /fixedincome/rate/effr: fed down')
    const year = fakeCtx({ [`${BASE}/fixedincome/rate/sofr?start_date=2025-10-16&provider=federal_reserve`]: { results: [] } })
    await expect(openbb.queries.macro!({ series: ['sofr'], range: '1y' }, year.ctx)).rejects.toThrow('federal_reserve returned no data for sofr since 2025-10-16')
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('yield_curve', () => {
  it('latest curve: labels from the maturity keys, rates percent, shortest first', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/fixedincome/government/yield_curve?provider=federal_reserve`]: fixture('yield-curve') })
    const frame = await openbb.queries.yield_curve!({}, ctx)
    expect(frame.columns).toEqual(KINDS.yield_curve.columns)
    expect(frame.rows).toHaveLength(11)
    expect(frame.rows[0]).toEqual(['2026-10-15', '1M', 0.08333333333333333, 4.17])
    expect(frame.rows.map((r) => r[1])).toEqual(['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'])
    expect(frame.rows[10]).toEqual(['2026-10-15', '30Y', 30, 5.43])
  })
  it('a date is passed through and the row date is the one the provider answered; a 204 throws', async () => {
    const { ctx } = fakeCtx({ [`${BASE}/fixedincome/government/yield_curve?date=2026-06-15&provider=federal_reserve`]: fixture('yield-curve-2026-06-15'), [`${BASE}/fixedincome/government/yield_curve?date=1990-01-01&provider=federal_reserve`]: '' })
    const frame = await openbb.queries.yield_curve!({ date: '2026-06-15' }, ctx)
    expect(frame.rows[0]).toEqual(['2026-06-15', '1M', 0.08333333333333333, 3.69])
    await expect(openbb.queries.yield_curve!({ date: '1990-01-01' }, ctx)).rejects.toThrow('federal_reserve returned no yield curve for 1990-01-01')
  })
})
