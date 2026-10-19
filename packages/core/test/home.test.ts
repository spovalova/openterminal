import { describe, expect, it } from 'vitest'
import { HOME_DIR, LEGACY_HOME_DIR, homeOverride, openterminalHome } from '../src/node.js'

describe('openterminalHome', () => {
  it('defaults to ~/.openterminal', () => {
    expect(HOME_DIR).toBe('.openterminal')
    expect(LEGACY_HOME_DIR).toBe('.terminal')
    expect(openterminalHome({}, '/home/u')).toBe('/home/u/.openterminal')
    expect(openterminalHome({ OPENTERMINAL_HOME: '  ', TERMINAL_HOME: '' }, '/home/u')).toBe('/home/u/.openterminal')
    expect(homeOverride({})).toBeUndefined()
  })

  it('honours OPENTERMINAL_HOME, and TERMINAL_HOME as the deprecated fallback', () => {
    expect(openterminalHome({ OPENTERMINAL_HOME: '/x/new' }, '/home/u')).toBe('/x/new')
    expect(openterminalHome({ TERMINAL_HOME: '/x/old' }, '/home/u')).toBe('/x/old')
    expect(openterminalHome({ OPENTERMINAL_HOME: '/x/new', TERMINAL_HOME: '/x/old' }, '/home/u')).toBe('/x/new')
    expect(homeOverride({ TERMINAL_HOME: ' /x/old ' })).toEqual({ path: '/x/old', variable: 'TERMINAL_HOME' })
    expect(homeOverride({ OPENTERMINAL_HOME: '/x/new', TERMINAL_HOME: '/x/old' })).toEqual({ path: '/x/new', variable: 'OPENTERMINAL_HOME' })
  })
})
