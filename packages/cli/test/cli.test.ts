import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseArgs, USAGE } from '../src/index.js'

const bin = (name: string) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url))

describe('openterminal cli', () => {
  it('parses flags', () => {
    expect(parseArgs(['--port', '4300', '--no-open'], {})).toEqual({ port: 4300, open: false, help: false })
    expect(parseArgs(['--port=0'], { PORT: '5000' }).port).toBe(0)
    expect(parseArgs([], { PORT: '5000' })).toEqual({ port: 5000, open: true, help: false })
    expect(() => parseArgs(['--nope'], {})).toThrow(/unknown argument --nope/)
  })

  it('names the product, the command and the config directory in the help', () => {
    expect(USAGE).toMatch(/^Open Terminal: /)
    expect(USAGE).toContain('usage: openterminal ')
    expect(USAGE).toContain('~/.openterminal')
    expect(USAGE).toContain('OPENTERMINAL_HOME')
  })

  // bin/terminal.js is the path the pre-rename systemd unit runs; it must keep starting the same CLI.
  it.each(['openterminal.js', 'terminal.js'])(
    'bin/%s prints the help',
    (name) => {
      const out = execFileSync(process.execPath, [bin(name), '--help'], { encoding: 'utf8', timeout: 60_000 })
      expect(out.trim()).toBe(USAGE)
    },
    60_000,
  )
})
