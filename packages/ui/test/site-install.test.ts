/// <reference types="node" />
/**
 * The installers and downloads the landing page serves (site/install for macOS and Linux, site/install.ps1 for
 * Windows, the per-system download links; see site/README.md). They are one half of a contract with the release
 * workflow, so these checks pin it: the asset names, the release URLs, the shared environment variables, the commands
 * and links on the page, and the headers that make Vercel serve both installers as text. The sh installer also runs
 * for real against fake releases in a temporary HOME: the Linux branch as is, and the macOS branch through stand-ins
 * for uname, sysctl, ditto, pgrep, osascript, pkill and open, into a temporary Applications folder. PowerShell is not
 * run here.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const site = join(dirname(fileURLToPath(import.meta.url)), '../../../site')
const installer = join(site, 'install')
const sh = readFileSync(installer, 'utf8')
const ps1Bytes = readFileSync(join(site, 'install.ps1'))
const ps1 = ps1Bytes.toString('utf8')
const html = readFileSync(join(site, 'index.html'), 'utf8')
const readme = readFileSync(join(site, 'README.md'), 'utf8')

/** The release assets of the contract (electron-builder output), under stable names so releases/latest/download/<asset> works. */
const ASSETS = [
  'OpenTerminal-mac-arm64.dmg',
  'OpenTerminal-mac-x64.dmg',
  'OpenTerminal-mac-arm64.zip',
  'OpenTerminal-mac-x64.zip',
  'OpenTerminal-win-x64-setup.exe',
  'OpenTerminal-linux-x86_64.AppImage',
  'OpenTerminal-linux-arm64.AppImage',
  'OpenTerminal-linux-amd64.deb',
  'OpenTerminal-linux-arm64.deb',
]
const REPO = 'https://github.com/spovalova/openterminal'
const DOWNLOAD = `${REPO}/releases/latest/download/`
const UNIX_COMMAND = 'curl -fsSL https://terminal.spova.ai/install | sh'
const WINDOWS_COMMAND = 'irm https://terminal.spova.ai/install.ps1 | iex'

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
const assetNames = (text: string) => [...text.matchAll(/OpenTerminal-[A-Za-z0-9_-]+\.(?:dmg|zip|exe|AppImage|deb)/g)].map((m) => m[0])

describe('the installers and downloads', () => {
  it('both installers exist, and the page shows exactly their two commands', () => {
    expect(existsSync(installer)).toBe(true)
    expect(existsSync(join(site, 'install.ps1'))).toBe(true)
    // The text a copy button copies: the command element without its <wbr> line-break hints.
    const commands = [...html.matchAll(/<code id="cmd-(hero|install)-(mac|windows|linux|unix)">(.*?)<\/code>/g)].map((m) => [`${m[1]}-${m[2]}`, m[2], m[3]!.replace(/<wbr\s*\/?>/g, '')])
    // The download card has a tab per system; the install section shows the two commands without tabs.
    expect(commands.map(([id]) => id)).toEqual(['hero-mac', 'hero-windows', 'hero-linux', 'install-unix', 'install-windows'])
    for (const [, os, text] of commands) expect(text).toBe(os === 'windows' ? WINDOWS_COMMAND : UNIX_COMMAND)
    const urls = new Set([...html.replace(/<wbr\s*\/?>/g, '').matchAll(/https:\/\/terminal\.spova\.ai\/[^\s"<|]*/g)].map((m) => m[0]))
    expect([...urls].sort()).toEqual(['https://terminal.spova.ai/install', 'https://terminal.spova.ai/install.ps1'])
    // Each installer points at the other for the wrong system.
    expect(sh).toContain('irm $OT_SITE/install.ps1 | iex')
    expect(sh).toContain('OT_SITE="https://terminal.spova.ai"')
    expect(ps1).toContain("$site = 'https://terminal.spova.ai'")
    expect(ps1).toContain('curl -fsSL $site/install | sh')
  })

  it('name exactly the release assets of the contract: the installers and the page links together cover all of them', () => {
    // The sh installer: the macOS zip by arch, the Linux AppImage (and the .deb it suggests) by arch.
    const macArch = [...new Set([...sh.matchAll(/\bARCH=(\w+)/g)].map((m) => m[1]!))].sort()
    expect(macArch).toEqual(['arm64', 'x64'])
    expect(sh).toContain('ASSET="OpenTerminal-mac-$ARCH.zip"')
    const fromSh = [...macArch.map((a) => `OpenTerminal-mac-${a}.zip`), ...assetNames(sh)]
    const fromPs1 = [...ps1.matchAll(/\$asset = '([^']+)'/g)].map((m) => m[1]!)
    expect(fromPs1).toEqual(['OpenTerminal-win-x64-setup.exe'])
    // The page: every download is a releases/latest/download link to one of them.
    const links = [...html.matchAll(/href="([^"]*\/releases\/[^"]*)"/g)].map((m) => m[1]!)
    const downloads = links.filter((l) => l.includes('/download/'))
    for (const l of downloads) expect(l.startsWith(DOWNLOAD), l).toBe(true)
    const fromPage = downloads.map((l) => l.slice(DOWNLOAD.length))
    expect(new Set(fromPage)).toEqual(new Set(['OpenTerminal-mac-arm64.dmg', 'OpenTerminal-mac-x64.dmg', 'OpenTerminal-win-x64-setup.exe', 'OpenTerminal-linux-x86_64.AppImage', 'OpenTerminal-linux-arm64.AppImage', 'OpenTerminal-linux-amd64.deb', 'OpenTerminal-linux-arm64.deb']))
    expect(new Set([...fromSh, ...fromPs1, ...fromPage])).toEqual(new Set(ASSETS))
    // No other asset name anywhere in site/.
    for (const name of [...assetNames(sh), ...assetNames(ps1), ...assetNames(html), ...assetNames(readme)]) expect(ASSETS).toContain(name)
    for (const script of [sh, ps1]) {
      expect(script).toContain('SHA256SUMS')
      expect(script).toMatch(/\/releases\/latest\/download"/)
      expect(script).toMatch(/\/releases\/download\/v\$(WANT|want|VERSION|version)"/)
      expect(script).toContain('/releases/latest')
    }
  })

  it('honour the shared environment, never run sudo or elevate, and run nothing until the whole file has arrived', () => {
    for (const script of [sh, ps1]) {
      for (const name of ['OPENTERMINAL_VERSION', 'OPENTERMINAL_INSTALL_BASE', 'OPENTERMINAL_NO_LAUNCH', 'NO_COLOR']) expect(script, name).toContain(name)
    }
    expect(sh).toContain('OPENTERMINAL_APP_DIR')
    expect(sh).toContain('--no-modify-path)')
    // sh: sudo appears only in the FUSE fix it prints, never as a command.
    for (const line of code(sh).split('\n').filter((l) => /\bsudo\b/.test(l))) expect(line).toMatch(/ot_fix="sudo [^"]*"/)
    // PowerShell: the setup runs per user and silently; no elevation, no PATH changes.
    expect(ps1).toContain("Start-Process -FilePath $setup -ArgumentList '/S'")
    expect(ps1).toContain('Invoke-WebRequest') // no Mark of the Web
    expect(code(ps1)).not.toMatch(/RunAs|SetEnvironmentVariable\('Path'|HKCU:\\Environment|Start-BitsTransfer/)
    // sh: everything is in functions; the last line calls the main one.
    expect(sh.trimEnd().split('\n').at(-1)).toBe('ot_main "$@"')
    // PowerShell: one function, called only after its closing brace, and never `exit` inside it (under irm | iex
    // that would close the user's window).
    const psLines = ps1.split(/\r?\n/)
    const open = psLines.findIndex((l) => l.startsWith('function Install-OpenTerminal'))
    const close = psLines.findIndex((l, i) => i > open && l === '}')
    const call = psLines.findIndex((l) => /\(Install-OpenTerminal\)/.test(l))
    expect(open).toBeGreaterThanOrEqual(0)
    expect(close).toBeGreaterThan(open)
    expect(call).toBeGreaterThan(close)
    expect(code(psLines.slice(open, close).join('\n'))).not.toMatch(/(^|[{;])\s*exit\b/m)
    expect(code(psLines.slice(close).join('\n'))).toMatch(/\{ exit 1 \}/) // only when run as a file
  })

  it('install.ps1 is ASCII with no byte order mark (Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI)', () => {
    expect([...ps1Bytes].filter((b) => b > 127)).toEqual([])
  })

  it('the sh installer parses (sh -n, and dash -n and shellcheck where installed)', () => {
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' })
    const plain = run('sh', ['-n', installer])
    expect(plain.stderr).toBe('')
    expect(plain.status).toBe(0)
    if (has('dash')) expect(run('dash', ['-n', installer]).status).toBe(0)
    if (has('bash')) expect(run('bash', ['-n', installer]).status).toBe(0)
    if (has('shellcheck')) {
      const lint = run('shellcheck', ['-s', 'sh', installer])
      expect(lint.stdout).toBe('')
      expect(lint.status).toBe(0)
    }
  })

  it('vercel.json serves both installers as UTF-8 text with a short cache, and changes nothing else', () => {
    const vercel = JSON.parse(readFileSync(join(site, 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] }
    expect(Object.keys(vercel).filter((k) => k !== '$schema')).toEqual(['headers'])
    for (const path of ['/install', '/install.ps1']) {
      const rule = vercel.headers.find((h) => h.source === path)
      expect(rule, path).toBeDefined()
      const header = (key: string) => rule!.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value
      expect(header('Content-Type')).toBe('text/plain; charset=utf-8')
      expect(header('Cache-Control')).toMatch(/max-age=\d+/)
    }
    expect(vercel.headers.map((h) => h.source).sort()).toEqual(['/install', '/install.ps1'])
  })
})

// ---------- the sh installer, run for real ----------

const posix = process.platform === 'linux' || process.platform === 'darwin'
const tools = posix && (has('sha256sum') || has('shasum'))
const scratch = posix ? mkdtempSync(join(tmpdir(), 'openterminal-install-test-')) : ''
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

function writeSums(dir: string, names: string[], tamper?: string) {
  const lines = names.map((n) => {
    let hash = createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')
    if (n === tamper) hash = (hash[0] === 'f' ? '0' : 'f') + hash.slice(1)
    return `${hash}  ${n}`
  })
  writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n')
}

/** A fake Linux release: AppImages that print their version. */
function linuxRelease(version: string, { tamper = false } = {}): string {
  const dir = join(scratch, `linux-${version}${tamper ? '-tampered' : ''}`)
  mkdirSync(dir, { recursive: true })
  const names = ['OpenTerminal-linux-x86_64.AppImage', 'OpenTerminal-linux-arm64.AppImage']
  for (const n of names) writeFileSync(join(dir, n), `#!/bin/sh\necho "Open Terminal ${version}"\n`)
  writeSums(dir, names, tamper ? (process.arch === 'arm64' ? names[1] : names[0]) : undefined)
  return dir
}

function newDir(name: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function install(home: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync('sh', [installer, ...args], {
    encoding: 'utf8',
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: '/bin/bash', LANG: 'C.UTF-8', ...env },
  })
}

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) && tools)('site/install on Linux, against a fake release', () => {
  it('installs the AppImage, the command, the menu entry and PATH once; re-installs and upgrades in place', () => {
    const home = newDir('home-linux')
    const appImage = join(home, '.local/share/openterminal/OpenTerminal.AppImage')
    const link = join(home, '.local/bin/openterminal')
    const desktop = join(home, '.local/share/applications/openterminal.desktop')
    const pathLines = () => readFileSync(join(home, '.bashrc'), 'utf8').split('\n').filter((l) => l.includes('.local/bin')).length

    const first = install(home, { OPENTERMINAL_INSTALL_BASE: linuxRelease('0.1.0') })
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('~/.local/share/openterminal/OpenTerminal.AppImage')
    expect(first.stdout).toContain('.deb')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(appImage)
    expect(spawnSync(link, { encoding: 'utf8' }).stdout.trim()).toBe('Open Terminal 0.1.0')
    const entry = readFileSync(desktop, 'utf8')
    expect(entry).toContain(`Exec="${appImage}" %U`)
    expect(existsSync(/^Icon=(.*)$/m.exec(entry)![1]!)).toBe(true)
    expect(pathLines()).toBe(1)

    expect(install(home, { OPENTERMINAL_INSTALL_BASE: linuxRelease('0.1.0') }).status).toBe(0)
    expect(pathLines()).toBe(1)
    expect(install(home, { OPENTERMINAL_INSTALL_BASE: linuxRelease('0.2.0') }).status).toBe(0)
    expect(spawnSync(link, { encoding: 'utf8' }).stdout.trim()).toBe('Open Terminal 0.2.0')
    expect(pathLines()).toBe(1)
    expect(readdirSync(join(home, '.local/share/openterminal'))).toEqual(['OpenTerminal.AppImage'])
  }, 60_000)

  it('leaves startup files alone with --no-modify-path', () => {
    const home = newDir('home-linux-no-path')
    const run = install(home, { OPENTERMINAL_INSTALL_BASE: linuxRelease('0.1.0') }, ['--no-modify-path'])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('~/.local/bin/openterminal')
    expect(existsSync(join(home, '.bashrc'))).toBe(false)
    expect(existsSync(join(home, '.profile'))).toBe(false)
  }, 30_000)

  it('aborts on a checksum mismatch and installs nothing', () => {
    const home = newDir('home-linux-tampered')
    const run = install(home, { OPENTERMINAL_INSTALL_BASE: linuxRelease('0.1.0', { tamper: true }) })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('sha256 mismatch')
    expect(readdirSync(home)).toEqual([])
  }, 30_000)
})

// macOS, simulated: a Rosetta shell on Apple silicon (so the arm64 app), and a fake Open Terminal that is "running"
// while $SHIM_STATE/running exists.
const SHIMS: Record<string, string> = {
  uname: 'case $1 in -m) echo x86_64 ;; *) echo Darwin ;; esac',
  sysctl: 'case $2 in sysctl.proc_translated | hw.optional.arm64) echo 1 ;; *) exit 1 ;; esac',
  ditto: `python3 -I -c 'import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    p = z.extract(i, sys.argv[2])
    if (i.external_attr >> 16) & 0o777: os.chmod(p, (i.external_attr >> 16) & 0o777)' "$3" "$4"`,
  pgrep: '[ -f "$SHIM_STATE/running" ]',
  osascript: 'echo osascript >>"$SHIM_STATE/log"; rm -f "$SHIM_STATE/running"',
  pkill: 'echo pkill >>"$SHIM_STATE/log"; rm -f "$SHIM_STATE/running"',
  open: 'echo "open $1" >>"$SHIM_STATE/log"',
}

function macRelease(version: string): string {
  const dir = join(scratch, `mac-${version}`)
  mkdirSync(dir, { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`
  const made = spawnSync('python3', ['-I', '-c', `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('Open Terminal.app/Contents/Info.plist', sys.argv[2])
i = zipfile.ZipInfo('Open Terminal.app/Contents/MacOS/Open Terminal'); i.external_attr = 0o100755 << 16
z.writestr(i, '#!/bin/sh\\necho ' + sys.argv[3] + '\\n')
z.close()`, join(dir, 'OpenTerminal-mac-arm64.zip'), plist, version])
  expect(made.status, made.stderr?.toString()).toBe(0)
  writeSums(dir, ['OpenTerminal-mac-arm64.zip'])
  return dir
}

describe.runIf(posix && tools && has('python3'))('site/install on macOS (simulated), against a fake release', () => {
  it('puts the arm64 app in the Applications folder and opens it; an update quits the running app first', () => {
    const shims = newDir('mac-shims')
    for (const [name, body] of Object.entries(SHIMS)) writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    const home = newDir('home-mac')
    const apps = newDir('Applications')
    const state = newDir('mac-state')
    const env = (version: string, extra: Record<string, string> = {}) => ({
      PATH: `${shims}:${process.env.PATH}`,
      SHIM_STATE: state,
      OPENTERMINAL_APP_DIR: apps,
      OPENTERMINAL_INSTALL_BASE: macRelease(version),
      ...extra,
    })
    const plist = join(apps, 'Open Terminal.app/Contents/Info.plist')
    const log = () => readFileSync(join(state, 'log'), 'utf8').trim().split('\n')

    const first = install(home, env('0.1.0'))
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('macOS arm64')
    expect(first.stdout).toContain('Open Terminal 0.1.0')
    expect(readFileSync(plist, 'utf8')).toContain('<string>0.1.0</string>')
    expect(log()).toEqual([`open ${join(apps, 'Open Terminal.app')}`])

    writeFileSync(join(state, 'running'), '')
    writeFileSync(join(state, 'log'), '')
    const update = install(home, env('0.2.0'))
    expect(update.status, update.stderr).toBe(0)
    expect(readFileSync(plist, 'utf8')).toContain('<string>0.2.0</string>')
    expect(log()).toEqual(['osascript', `open ${join(apps, 'Open Terminal.app')}`])
    expect(readdirSync(apps)).toEqual(['Open Terminal.app'])

    writeFileSync(join(state, 'log'), '')
    expect(install(home, env('0.2.0', { OPENTERMINAL_NO_LAUNCH: '1' })).status).toBe(0)
    expect(readFileSync(join(state, 'log'), 'utf8')).toBe('')
    expect(readdirSync(home)).toEqual([]) // nothing in the home folder: no PATH lines, no ~/Applications
  }, 60_000)
})
