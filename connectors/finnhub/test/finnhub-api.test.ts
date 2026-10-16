import { describe, expect, it } from 'vitest'
import { buildUrl, createLimiter, isoDay, perSymbol, toSession } from '../src/finnhub-api.js'
import { fakeCtx } from './helpers.js'

describe('buildUrl', () => {
  it('appends the token last and encodes params', () => {
    expect(buildUrl('/quote', { symbol: 'BRK.B' }, 'k')).toBe('https://finnhub.io/api/v1/quote?symbol=BRK.B&token=k')
    expect(buildUrl('/company-news', { symbol: 'A B', from: '2026-10-09', to: '2026-10-16' }, 'k')).toBe('https://finnhub.io/api/v1/company-news?symbol=A+B&from=2026-10-09&to=2026-10-16&token=k')
  })
})

describe('createLimiter', () => {
  it('lets at most `max` requests start per window and waits for the oldest to age out', async () => {
    let t = 0
    const waits: number[] = []
    const limiter = createLimiter(3, 1_000, {
      now: () => t,
      wait: async (ms) => {
        waits.push(ms)
        t += ms
      },
    })
    await limiter.acquire()
    t = 100
    await limiter.acquire()
    t = 200
    await limiter.acquire()
    expect(waits).toEqual([])
    await limiter.acquire() // fourth: window full, must wait until the first slot (t=0) ages out
    expect(waits).toEqual([800])
    expect(t).toBe(1000)
    limiter.reset()
    await limiter.acquire()
    expect(waits).toEqual([800])
  })
})

describe('perSymbol', () => {
  it('concatenates rows in symbol order, logs failures, throws only when all fail', async () => {
    const { ctx, logs } = fakeCtx({})
    const rows = await perSymbol(ctx, ['A', 'B', 'C'], async (s) => {
      if (s === 'B') throw new Error('boom')
      return [s.toLowerCase()]
    })
    expect(rows).toEqual(['a', 'c'])
    expect(logs).toEqual(['skipped B: boom'])
    await expect(perSymbol(ctx, ['A'], async () => Promise.reject(new Error('boom')))).rejects.toThrow('finnhub: every symbol failed (A: boom)')
  })
})

describe('small mappers', () => {
  it('isoDay is UTC YYYY-MM-DD', () => expect(isoDay(Date.UTC(2026, 9, 16, 23, 59))).toBe('2026-10-16'))
  it('toSession keeps bmo/amc only', () => {
    expect(toSession('bmo')).toBe('bmo')
    expect(toSession('amc')).toBe('amc')
    expect(toSession('dmh')).toBeNull()
    expect(toSession('')).toBeNull()
    expect(toSession(undefined)).toBeNull()
  })
})
