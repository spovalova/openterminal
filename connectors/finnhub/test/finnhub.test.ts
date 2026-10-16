import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KINDS, frameToObjects, type Kind } from '@terminal/core'
import finnhub from '../src/index.js'
import { fakeCtx, fixture, NOW, status, TOKEN } from './helpers.js'

const base = 'https://finnhub.io/api/v1'
const run = <K extends Kind>(kind: K, params: unknown, ctx: Parameters<NonNullable<(typeof finnhub.queries)[K]>>[1]) => finnhub.queries[kind]!(params as never, ctx)

beforeEach(() => vi.useFakeTimers({ now: NOW }))
afterEach(() => vi.useRealTimers())

describe('connector definition', () => {
  it('is named finnhub, answers quote/news/earnings, and requires an apiKey', () => {
    expect(finnhub.name).toBe('finnhub')
    expect(finnhub.kinds).toEqual(['quote', 'news', 'earnings'])
    expect(finnhub.config.safeParse({}).success).toBe(false)
    expect(finnhub.config.safeParse({ apiKey: '' }).success).toBe(false)
    expect(finnhub.config.safeParse({ apiKey: 'k' }).success).toBe(true)
  })
})

describe('quote', () => {
  it('fetches each symbol with the token and maps c/dp into the quote columns', async () => {
    const { ctx, calls } = fakeCtx({
      [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: fixture('quote-AAPL'),
      [`${base}/quote?symbol=MSFT&token=${TOKEN}`]: fixture('quote-MSFT'),
    })
    const frame = await run('quote', { symbols: ['AAPL', 'MSFT'] }, ctx)
    expect(calls).toEqual([`${base}/quote?symbol=AAPL&token=${TOKEN}`, `${base}/quote?symbol=MSFT&token=${TOKEN}`])
    expect(frame.columns).toEqual(KINDS.quote.columns)
    expect(frame.meta.connector).toBe('finnhub')
    expect(frame.meta.ttl).toBe(KINDS.quote.ttl)
    expect(frame.rows).toEqual([
      ['AAPL', 247.77, 0.8711, null, null, null, null],
      ['MSFT', 512.09, -0.6634, null, null, null, null],
    ])
  })

  it('skips unknown symbols (c === 0) with a log line', async () => {
    const { ctx, logs } = fakeCtx({
      [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: fixture('quote-AAPL'),
      [`${base}/quote?symbol=NOPE&token=${TOKEN}`]: fixture('quote-unknown'),
    })
    const frame = await run('quote', { symbols: ['AAPL', 'NOPE'] }, ctx)
    expect(frame.rows.map((r) => r[0])).toEqual(['AAPL'])
    expect(logs).toContain('no quote for NOPE, skipping')
  })

  it('keeps the others when one symbol errors, and fails only when all do', async () => {
    const { ctx, logs } = fakeCtx({
      [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: fixture('quote-AAPL'),
      [`${base}/quote?symbol=BAD&token=${TOKEN}`]: status(500),
    })
    const frame = await run('quote', { symbols: ['AAPL', 'BAD'] }, ctx)
    expect(frame.rows.map((r) => r[0])).toEqual(['AAPL'])
    expect(logs.some((l) => l.startsWith('skipped BAD: HTTP 500'))).toBe(true)

    const all = fakeCtx({ [`${base}/quote?symbol=BAD&token=${TOKEN}`]: status(500) })
    await expect(run('quote', { symbols: ['BAD'] }, all.ctx)).rejects.toThrow(/every symbol failed.*BAD: HTTP 500/)
  })

  it('retries once after a 429', async () => {
    let n = 0
    const { ctx, calls, logs } = fakeCtx({
      [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: () => {
        if (n++ === 0) throw status(429)
        return fixture('quote-AAPL')
      },
    })
    const pending = run('quote', { symbols: ['AAPL'] }, ctx)
    await vi.advanceTimersByTimeAsync(1_000)
    const frame = await pending
    expect(calls).toHaveLength(2)
    expect(frame.rows).toHaveLength(1)
    expect(logs).toContain('429 on /quote, retrying in 1000ms')
  })

  it('does not retry a second 429', async () => {
    const { ctx, calls } = fakeCtx({ [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: status(429) })
    const pending = run('quote', { symbols: ['AAPL'] }, ctx)
    pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).rejects.toThrow(/HTTP 429/)
    expect(calls).toHaveLength(2)
  })
})

describe('news', () => {
  const window = `from=2026-10-09&to=2026-10-16`

  it('uses a 7-day window ending today, merges symbols newest first, dedupes by url, and cuts to limit', async () => {
    const { ctx, calls } = fakeCtx({
      [`${base}/company-news?symbol=AAPL&${window}&token=${TOKEN}`]: fixture('company-news-AAPL'),
      [`${base}/company-news?symbol=MSFT&${window}&token=${TOKEN}`]: fixture('company-news-MSFT'),
    })
    const frame = await run('news', { symbols: ['AAPL', 'MSFT'], limit: 20 }, ctx)
    expect(calls).toEqual([`${base}/company-news?symbol=AAPL&${window}&token=${TOKEN}`, `${base}/company-news?symbol=MSFT&${window}&token=${TOKEN}`])
    expect(frame.columns).toEqual(KINDS.news.columns)
    const rows = frameToObjects(frame)
    expect(rows.map((r) => r.url)).toEqual([
      'https://example.com/news/msft-azure',
      'https://example.com/news/apple-macbook-pro',
      'https://example.com/news/big-tech-preview',
      'https://example.com/news/msft-xbox',
      'https://example.com/news/apple-suppliers',
    ])
    expect(rows[0]).toEqual({ time: 1792143000 * 1000, headline: 'Microsoft expands Azure AI capacity', source: 'Reuters', url: 'https://example.com/news/msft-azure', symbol: 'MSFT' })
    // The shared story is attributed to the first symbol that carried it after sorting (AAPL and MSFT tie on time; AAPL came first).
    expect(rows[2]!.symbol).toBe('AAPL')

    const limited = await run('news', { symbols: ['AAPL', 'MSFT'], limit: 2 }, ctx)
    expect(limited.rows).toHaveLength(2)
  })

  it('returns an empty frame when a symbol has no news', async () => {
    const { ctx } = fakeCtx({ [`${base}/company-news?symbol=AAPL&${window}&token=${TOKEN}`]: [] })
    const frame = await run('news', { symbols: ['AAPL'], limit: 20 }, ctx)
    expect(frame.rows).toEqual([])
  })
})

describe('earnings', () => {
  const params = { symbols: ['AAPL', 'MSFT', 'TSLA'], from: '2026-10-16', to: '2026-11-15' }
  const url = (s: string) => `${base}/calendar/earnings?from=2026-10-16&to=2026-11-15&symbol=${s}&token=${TOKEN}`

  it('fans out per symbol and maps hour to session and epsEstimate to eps_estimate', async () => {
    const { ctx, calls } = fakeCtx({ [url('AAPL')]: fixture('earnings-AAPL'), [url('MSFT')]: fixture('earnings-MSFT'), [url('TSLA')]: fixture('earnings-TSLA') })
    const frame = await run('earnings', params, ctx)
    expect(calls).toEqual([url('AAPL'), url('MSFT'), url('TSLA')])
    expect(frame.columns).toEqual(KINDS.earnings.columns)
    expect(frame.rows).toEqual([
      ['AAPL', '2026-10-29', 'amc', 1.77],
      ['MSFT', '2026-10-28', 'amc', 3.65],
      ['TSLA', '2026-10-21', null, null],
    ])
  })

  it('maps bmo and dmh', async () => {
    const row = (hour: string) => ({ earningsCalendar: [{ ...(fixture('earnings-AAPL') as any).earningsCalendar[0], hour }] })
    const { ctx } = fakeCtx({ [url('AAPL')]: row('bmo'), [url('MSFT')]: row('dmh'), [url('TSLA')]: fixture('earnings-empty') })
    const frame = await run('earnings', params, ctx)
    expect(frame.rows.map((r) => r[2])).toEqual(['bmo', null])
  })
})
