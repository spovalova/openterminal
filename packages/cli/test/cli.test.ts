import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bannerLines, parseArgs, tilde, updateNotice, USAGE, VERSION } from '../src/index.js'
import { foldKeys } from '../src/prompt.js'

const bin = (name: string) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url))

describe('openterminal cli', () => {
  it('parses the flags', () => {
    expect(parseArgs(['--port', '4300', '--no-open'], {})).toEqual({ command: 'start', port: 4300, open: false, verbose: false })
    expect(parseArgs(['--port=0'], { PORT: '5000' })).toMatchObject({ command: 'start', port: 0 })
    expect(parseArgs([], { PORT: '5000' })).toEqual({ command: 'start', port: 5000, open: true, verbose: false })
    expect(parseArgs(['--verbose'], {})).toEqual({ command: 'start', port: 4242, open: true, verbose: true })
    expect(() => parseArgs(['--nope'], {})).toThrow(/unknown argument --nope/)
    expect(() => parseArgs(['update'], {})).toThrow(/unknown argument update/)
    expect(() => parseArgs(['--port'], {})).toThrow(/invalid --port/)
    expect(() => parseArgs(['--port', '70000'], {})).toThrow(/invalid --port 70000/)
  })

  it('parses --version and --help anywhere on the line', () => {
    for (const a of [['--version'], ['-v'], ['-V'], ['--no-open', '--version']]) expect(parseArgs(a, {})).toEqual({ command: 'version' })
    for (const a of [['--help'], ['-h'], ['--port', '1', '--help']]) expect(parseArgs(a, {})).toEqual({ command: 'help' })
  })

  it('names the product, the flags and the config directory in the help', () => {
    expect(USAGE).toMatch(/^Open Terminal: /)
    expect(USAGE).toContain('usage: openterminal ')
    expect(USAGE).toContain('--version')
    expect(USAGE).toContain('~/.openterminal')
    expect(USAGE).toContain('OPENTERMINAL_HOME')
    expect(USAGE).toContain('OPENTERMINAL_NO_UPDATE_CHECK=1')
  })

  it('takes its version from package.json', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('prints a banner with the URL, connectors, agent and data directory, and how to add a key without one', () => {
    const base = { version: '0.1.0', url: 'http://127.0.0.1:4320', home: '/home/me/.openterminal', config: '/home/me/.openterminal/config.yml' }
    const connectors = [
      { name: 'openbb', state: 'unreachable' as const },
      { name: 'yahoo', state: 'ok' as const },
      { name: 'finnhub', state: 'off' as const },
    ]
    const withKey = bannerLines({ ...base, connectors, llm: { provider: 'anthropic', model: 'claude-opus-5-5' }, logFile: '/home/me/.openterminal/openterminal.log' }, '/home/me').join('\n')
    expect(withKey).toContain('Open Terminal 0.1.0  http://127.0.0.1:4320')
    expect(withKey).toContain('connectors  openbb (not running), yahoo, finnhub (off: add it on the Data page)')
    expect(withKey).toContain('agent       claude-opus-5-5 (anthropic)')
    expect(withKey).toContain('data        ~/.openterminal')
    expect(withKey).toContain('log         ~/.openterminal/openterminal.log')
    const noKey = bannerLines({ ...base, connectors }, '/home/me').join('\n')
    expect(noKey).toContain('no LLM key')
    expect(noKey).toContain('set ANTHROPIC_API_KEY, or fill in llm: in ~/.openterminal/config.yml')
    expect(noKey).not.toContain('log ')
  })

  it('shortens paths under the home directory only', () => {
    expect(tilde('/home/me/.openterminal', '/home/me')).toBe('~/.openterminal')
    expect(tilde('/home/meow/x', '/home/me')).toBe('/home/meow/x')
  })

  it('says how to update in one line', () => {
    expect(updateNotice('0.2.0', '0.1.0')).toBe('  update      Open Terminal 0.2.0 is out (this is 0.1.0): run `npx openterminal@latest`, or `npm install -g openterminal@latest`')
  })

  // bin/terminal.js is the path the pre-rename systemd unit runs; it must keep starting the same CLI.
  it.each(['openterminal.js', 'terminal.js'])(
    'bin/%s prints the help and the version',
    (name) => {
      const out = execFileSync(process.execPath, [bin(name), '--help'], { encoding: 'utf8', timeout: 60_000 })
      expect(out.trim()).toBe(USAGE)
      const version = execFileSync(process.execPath, [bin(name), '--version'], { encoding: 'utf8', timeout: 60_000 })
      expect(version.trim()).toBe(VERSION)
    },
    60_000,
  )
})

describe('hidden key input', () => {
  it('collects typed and pasted text until Enter, with backspace, and never keeps escape sequences', () => {
    let s = foldKeys({ text: '' }, 'sk-ant-')
    s = foldKeys(s, 'abcx\u007f')
    expect(s).toEqual({ text: 'sk-ant-abc' })
    expect(foldKeys(s, '\x1b[200~123\x1b[201~\r')).toEqual({ text: 'sk-ant-abc123', done: 'enter' })
    expect(foldKeys({ text: '' }, '\r')).toEqual({ text: '', done: 'enter' })
    expect(foldKeys({ text: 'abc' }, '\u0003')).toEqual({ text: 'abc', done: 'cancel' })
    expect(foldKeys({ text: 'abc' }, '\u0015xyz\n')).toEqual({ text: 'xyz', done: 'enter' })
    expect(foldKeys({ text: '' }, '\x1b[A\x1b[Bk')).toEqual({ text: 'k' })
  })
})
