import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkForUpdate, compareVersions, LATEST_RELEASE_API, UPDATE_CHECK_INTERVAL_MS, updateCheckDisabled } from '../src/update-check.js'

const DAY = UPDATE_CHECK_INTERVAL_MS

function fakeFetch(tag: string | undefined, calls: { url: string; init?: RequestInit }[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (tag === undefined) throw new Error('offline')
    return new Response(JSON.stringify({ tag_name: tag }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

describe('update check', () => {
  let dir: string
  let stateFile: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ot-update-'))
    stateFile = join(dir, 'cli-state.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('compares versions', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('nightly', '1.0.0')).toBe(0)
  })

  it('is off with OPENTERMINAL_NO_UPDATE_CHECK', () => {
    expect(updateCheckDisabled({ OPENTERMINAL_NO_UPDATE_CHECK: '1' })).toBe(true)
    expect(updateCheckDisabled({ OPENTERMINAL_NO_UPDATE_CHECK: 'true' })).toBe(true)
    expect(updateCheckDisabled({ OPENTERMINAL_NO_UPDATE_CHECK: '0' })).toBe(false)
    expect(updateCheckDisabled({})).toBe(false)
  })

  it('asks GitHub at most once a day and remembers the answer in between', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const t0 = Date.UTC(2026, 9, 20, 9)
    const first = await checkForUpdate({ current: '0.1.0', stateFile, now: () => t0, fetch: fakeFetch('v0.2.0', calls) })
    expect(first).toEqual({ latest: '0.2.0', newer: true, asked: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(LATEST_RELEASE_API)
    // No identifiers: no token, no version, only the product name as the User-Agent GitHub requires.
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(Object.keys(headers).sort()).toEqual(['accept', 'user-agent'])
    expect(headers['user-agent']).toBe('openterminal')

    const later = await checkForUpdate({ current: '0.1.0', stateFile, now: () => t0 + DAY - 1, fetch: fakeFetch('v0.3.0', calls) })
    expect(later).toEqual({ latest: '0.2.0', newer: true, asked: false })
    expect(calls).toHaveLength(1)

    const nextDay = await checkForUpdate({ current: '0.1.0', stateFile, now: () => t0 + DAY, fetch: fakeFetch('v0.3.0', calls) })
    expect(nextDay).toEqual({ latest: '0.3.0', newer: true, asked: true })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ updateCheck: { checkedAt: t0 + DAY, latest: '0.3.0' } })
  })

  it('counts a failed request as the day’s check and keeps the last answer', async () => {
    const calls: { url: string }[] = []
    const t0 = Date.UTC(2026, 9, 20, 9)
    writeFileSync(stateFile, JSON.stringify({ updateCheck: { checkedAt: t0 - 2 * DAY, latest: '0.1.0' }, keyPrompt: { skippedAt: 'x' } }))
    const r = await checkForUpdate({ current: '0.1.0', stateFile, now: () => t0, fetch: fakeFetch(undefined, calls) })
    expect(r).toEqual({ latest: '0.1.0', newer: false, asked: true })
    const again = await checkForUpdate({ current: '0.1.0', stateFile, now: () => t0 + 60_000, fetch: fakeFetch(undefined, calls) })
    expect(again.asked).toBe(false)
    expect(calls).toHaveLength(1)
    // The rest of the state file is kept.
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).keyPrompt).toEqual({ skippedAt: 'x' })
  })

  it('asks again when the clock went backwards', async () => {
    const calls: { url: string }[] = []
    writeFileSync(stateFile, JSON.stringify({ updateCheck: { checkedAt: Date.UTC(2030, 0, 1) } }))
    const r = await checkForUpdate({ current: '0.1.0', stateFile, now: () => Date.UTC(2026, 9, 20), fetch: fakeFetch('v0.1.0', calls) })
    expect(r).toEqual({ latest: '0.1.0', newer: false, asked: true })
  })

  it('ignores a release tag that is not a version', async () => {
    const r = await checkForUpdate({ current: '0.1.0', stateFile, now: () => 1, fetch: fakeFetch('nightly', []) })
    expect(r).toEqual({ newer: false, asked: true })
  })
})
