import { describe, expect, it } from 'vitest'
import { buildUrl, createLimiter } from '../src/finnhub-api.js'

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
