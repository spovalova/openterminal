import { describe, expect, it } from 'vitest'
import { RETRY_DELAY_MS, isRateLimited, retryOn429, wrapClient, type YahooClient } from '../src/client.js'

function http429(): Error {
  const e = new Error('Too Many Requests')
  e.name = 'HTTPError'
  ;(e as { code?: number }).code = 429
  return e
}

describe('429 retry', () => {
  it('recognises yahoo-finance2 HTTPError 429 by code or message', () => {
    expect(isRateLimited(http429())).toBe(true)
    expect(isRateLimited(new Error('Request failed with status 429'))).toBe(true)
    expect(isRateLimited(new Error('Not Found'))).toBe(false)
    expect(isRateLimited('429')).toBe(false)
  })

  it('retries exactly once after the delay and then succeeds', async () => {
    let calls = 0
    const slept: number[] = []
    const result = await retryOn429(
      async () => {
        calls++
        if (calls === 1) throw http429()
        return 'ok'
      },
      { sleep: async (ms) => { slept.push(ms) } },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(slept).toEqual([RETRY_DELAY_MS])
  })

  it('gives up after a second 429 and never retries other errors', async () => {
    let calls = 0
    await expect(retryOn429(async () => { calls++; throw http429() }, { sleep: async () => {} })).rejects.toThrow('Too Many Requests')
    expect(calls).toBe(2)

    calls = 0
    await expect(retryOn429(async () => { calls++; throw new Error('Not Found') }, { sleep: async () => {} })).rejects.toThrow('Not Found')
    expect(calls).toBe(1)
  })

  it('wrapClient applies the retry to every method', async () => {
    const seen = { search: 0, quote: 0, chart: 0, quoteSummary: 0 }
    const once = <T>(name: keyof typeof seen, value: T) => async () => {
      seen[name] += 1
      if (seen[name] === 1) throw http429()
      return value
    }
    const raw = {
      search: once('search', { quotes: [] }),
      quote: once('quote', []),
      chart: once('chart', { meta: {}, quotes: [] }),
      quoteSummary: once('quoteSummary', {}),
    } as unknown as YahooClient
    const client = wrapClient(raw, { sleep: async () => {} })
    await client.search('x', {})
    await client.quote(['X'])
    await client.chart('X', { period1: 0 })
    await client.quoteSummary('X', { modules: ['calendarEvents'] })
    expect(seen).toEqual({ search: 2, quote: 2, chart: 2, quoteSummary: 2 })
  })
})
