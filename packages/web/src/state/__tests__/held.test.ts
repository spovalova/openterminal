import { describe, expect, it } from 'vitest'
import type { Frame } from '@openterminal/core'
import { asOfLabel, workspaceHeldAt } from '../frames'

const frame = (heldAt?: number): Frame => ({ columns: [], rows: [], meta: { connector: 'x', fetchedAt: 0, ttl: 0, ...(heldAt !== undefined ? { heldAt } : {}) } })
const MON_1429 = Date.UTC(2026, 9, 19, 18, 29) // 14:29 ET on Monday 2026-10-19

describe('the reply snapshot in the web state (taste round 2, change 5)', () => {
  it('reports when a workspace shows the reply\'s held frames, and not when they are live or another workspace\'s', () => {
    const store = { 'ws1/w1/main': frame(MON_1429), 'ws1/w2/main': frame(), 'ws2/w1/main': frame(MON_1429 + 1) }
    expect(workspaceHeldAt(store, 'ws1')).toBe(MON_1429)
    expect(workspaceHeldAt({ 'ws1/w2/main': frame() }, 'ws1')).toBeUndefined()
  })
  it('labels the time in New York, with the date when it is not today', () => {
    expect(asOfLabel(MON_1429, MON_1429 + 3_600_000)).toBe('14:29 ET')
    expect(asOfLabel(MON_1429, MON_1429 + 48 * 3_600_000)).toBe('Oct 19, 14:29 ET')
  })
})
