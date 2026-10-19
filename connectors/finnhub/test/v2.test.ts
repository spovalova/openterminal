// v2 (PLAN.md section 17): quote, company-news and calendar/earnings as routes, answered from the recorded
// fixtures through inferFrame. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DescriptorSchema, frameToObjects, parseParams, type Descriptor } from '@terminal/core'
import finnhub from '../src/index.js'
import { callFinnhub, finnhubDescriptors, secondsToMs, FINNHUB_ROUTES } from '../src/call.js'
import { fakeCtx, fixture, NOW, status, TOKEN } from './helpers.js'

const base = 'https://finnhub.io/api/v1'
const descriptors = finnhubDescriptors()
const by = (route: string): Descriptor => descriptors.find((d) => d.route === route)!

beforeEach(() => vi.useFakeTimers({ now: NOW }))
afterEach(() => vi.useRealTimers())

describe('descriptors.json', () => {
  it('holds the three REST paths the recipes name, valid, with the time fields typed time', async () => {
    expect(descriptors.map((d) => d.route)).toEqual([...FINNHUB_ROUTES])
    expect(descriptors.every((d) => DescriptorSchema.safeParse(d).success && d.connector === 'finnhub' && d.providers.length === 0)).toBe(true)
    expect(by('company-news').params.map((p) => `${p.name}:${p.type}${p.required ? '!' : ''}`)).toEqual(['symbol:string!', 'from:date!', 'to:date!'])
    expect(by('calendar/earnings').params.find((p) => p.name === 'symbol')).toMatchObject({ required: false })
    expect(by('company-news').fields.find((f) => f.name === 'datetime')).toMatchObject({ type: 'time' })
    expect(by('quote').fields.find((f) => f.name === 't')).toMatchObject({ type: 'time' })
    expect(finnhub.mode).toBe('both')
    const all = await finnhub.descriptors()
    expect(all.map((d) => d.route)).toEqual(['quote', 'company-news', 'calendar/earnings', 'news', 'earnings']) // `quote` the route wins over the kind
  })
})

describe('call', () => {
  it('quote: one row with Finnhub’s letters as columns, t in ms, dp untouched', async () => {
    const { ctx, calls } = fakeCtx({ [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: fixture('quote-AAPL') })
    const f = await callFinnhub('quote', parseParams(by('quote'), { symbol: 'aapl' }), ctx)
    expect(calls).toEqual([`${base}/quote?symbol=AAPL&token=${TOKEN}`])
    expect(f.meta.connector).toBe('finnhub')
    expect(f.columns).toEqual([
      { name: 'symbol', type: 'string' },
      { name: 'c', type: 'number' },
      { name: 'd', type: 'number' },
      { name: 'dp', type: 'number' },
      { name: 'h', type: 'number' },
      { name: 'l', type: 'number' },
      { name: 'o', type: 'number' },
      { name: 'pc', type: 'number' },
      { name: 't', type: 'time' },
    ])
    expect(frameToObjects(f)[0]).toEqual({ symbol: 'AAPL', c: 247.77, d: 2.14, dp: 0.8711, h: 249.2, l: 244.51, o: 245.3, pc: 245.63, t: 1792094400 * 1000 })
  })
  it('quote: an unknown symbol (c === 0) is an error so the registry can fall back', async () => {
    const { ctx } = fakeCtx({ [`${base}/quote?symbol=NOPE&token=${TOKEN}`]: fixture('quote-unknown') })
    await expect(callFinnhub('quote', { symbol: 'NOPE' }, ctx)).rejects.toThrow(/no quote for NOPE/)
  })
  it('company-news: the window goes through as dates, datetime becomes ms, rows newest first with the symbol', async () => {
    const url = `${base}/company-news?symbol=AAPL&from=2026-10-09&to=2026-10-16&token=${TOKEN}`
    const { ctx, calls } = fakeCtx({ [url]: fixture('company-news-AAPL') })
    const f = await callFinnhub('company-news', parseParams(by('company-news'), { symbol: 'AAPL', from: '2026-10-09', to: '2026-10-16' }), ctx)
    expect(calls).toEqual([url])
    expect(f.columns.slice(0, 3)).toEqual([{ name: 'symbol', type: 'string' }, { name: 'datetime', type: 'time' }, { name: 'headline', type: 'string' }])
    const rows = frameToObjects(f)
    expect(rows.map((r) => r.datetime)).toEqual([1792076400000, 1791979200000, 1791792000000])
    expect(rows[0]).toMatchObject({ symbol: 'AAPL', headline: 'Apple unveils new MacBook Pro lineup', source: 'Reuters', url: 'https://example.com/news/apple-macbook-pro' })
  })
  it('calendar/earnings: rows from earningsCalendar with the date typed time; symbol optional', async () => {
    const withSymbol = `${base}/calendar/earnings?from=2026-10-19&to=2026-11-19&symbol=AAPL&token=${TOKEN}`
    const market = `${base}/calendar/earnings?from=2026-10-19&to=2026-11-19&token=${TOKEN}`
    const { ctx, calls } = fakeCtx({ [withSymbol]: fixture('earnings-AAPL'), [market]: fixture('earnings-empty') })
    const f = await callFinnhub('calendar/earnings', parseParams(by('calendar/earnings'), { from: '2026-10-19', to: '2026-11-19', symbol: 'AAPL' }), ctx)
    expect(calls).toEqual([withSymbol])
    expect(f.columns.find((c) => c.name === 'date')!.type).toBe('time')
    expect(frameToObjects(f)[0]).toMatchObject({ symbol: 'AAPL', date: Date.UTC(2026, 9, 29, 4), hour: 'amc', epsEstimate: 1.77, quarter: 4, revenueEstimate: 101500000000 })
    const empty = await callFinnhub('calendar/earnings', parseParams(by('calendar/earnings'), { from: '2026-10-19', to: '2026-11-19' }), ctx)
    expect(empty.rows).toEqual([])
    expect(empty.columns.map((c) => c.name)).toContain('epsEstimate') // descriptor columns on an empty result
  })
  it('propagates HTTP errors and refuses unknown routes; the connector routes kinds and routes apart', async () => {
    const { ctx } = fakeCtx({ [`${base}/quote?symbol=AAPL&token=${TOKEN}`]: status(500), [`${base}/quote?symbol=MSFT&token=${TOKEN}`]: fixture('quote-MSFT') })
    await expect(callFinnhub('quote', { symbol: 'AAPL' }, ctx)).rejects.toThrow(/HTTP 500/)
    await expect(callFinnhub('nope', {}, ctx)).rejects.toThrow(/does not answer route "nope"/)
    const v2 = await finnhub.call('quote', { symbol: 'MSFT' }, ctx)
    expect(v2.columns.map((c) => c.name)).toContain('dp')
    const v1 = await finnhub.call('news', { symbols: ['MSFT'], limit: 5 }, fakeCtx({ [`${base}/company-news?symbol=MSFT&from=2026-10-09&to=2026-10-16&token=${TOKEN}`]: fixture('company-news-MSFT') }).ctx)
    expect(v1.columns.map((c) => c.name)).toEqual(['time', 'headline', 'source', 'url', 'symbol'])
    expect(secondsToMs(1.5)).toBe(1500)
    expect(secondsToMs(null)).toBeNull()
  })
})
