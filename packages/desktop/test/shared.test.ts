import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { debAssetUrl, installDirOfMacApp, isExternal, libDir, parseDesktopArgs, pickPort, portFree, trayMenu, updateStrategy, waitForHealth } from '../src/shared.js'

const pkg = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as { version: string; productName?: string }

describe('desktop app', () => {
  it('has one version with the CLI, and the product name the installers look for', () => {
    expect(pkg('../package.json').version).toBe(pkg('../../cli/package.json').version)
    expect(pkg('../package.json').productName).toBe('Open Terminal')
  })

  it('reads its own flags and ignores Chromium switches, the app path and macOS’s -psn_', () => {
    expect(parseDesktopArgs([])).toEqual({ noWindow: false })
    expect(parseDesktopArgs(['.', '--no-sandbox', '--no-window', '-psn_0_123'])).toEqual({ noWindow: true })
    expect(parseDesktopArgs(['--port', '4340'])).toEqual({ noWindow: false, port: 4340 })
    expect(parseDesktopArgs(['--port=4341', '--enable-logging'])).toEqual({ noWindow: false, port: 4341 })
    expect(() => parseDesktopArgs(['--port', 'x'])).toThrow(/invalid --port x/)
  })

  it('finds the release bundle outside the asar archive when packaged, in dist/release from source', () => {
    expect(libDir({ packaged: true, resourcesPath: '/opt/Open Terminal/resources', appPath: '/opt/Open Terminal/resources/app.asar' })).toBe(join('/opt/Open Terminal/resources', 'lib'))
    expect(libDir({ packaged: false, resourcesPath: '/x', appPath: '/repo/packages/desktop' })).toBe(join('/repo', 'dist/release/lib'))
  })

  describe('ports', () => {
    let held: Server | undefined
    afterEach(() => held?.close())

    it('takes the preferred port when free and the next free one when it is taken', async () => {
      held = createServer()
      await new Promise<void>((ok) => held!.listen(0, '127.0.0.1', ok))
      const taken = (held.address() as { port: number }).port
      expect(await portFree(taken)).toBe(false)
      const got = await pickPort(taken, 20)
      expect(got).toBeGreaterThan(taken)
      expect(await pickPort(4242, 3, async (p) => p === 4243)).toBe(4243)
      expect(await pickPort(4242, 3, async (p) => p === 4242)).toBe(4242)
      await expect(pickPort(4242, 3, async () => false)).rejects.toThrow(/no free port from 4242 to 4244/)
    })
  })

  it('waits for /api/health and gives up when the server stops', async () => {
    let calls = 0
    const fake = (async () => {
      calls++
      if (calls < 3) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await waitForHealth('http://127.0.0.1:1', { fetch: fake, intervalMs: 1 })
    expect(calls).toBe(3)
    const never = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await expect(waitForHealth('http://127.0.0.1:1', { fetch: never, intervalMs: 1, alive: () => false })).rejects.toThrow(/stopped before it was ready/)
    await expect(waitForHealth('http://127.0.0.1:1', { fetch: never, intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(/did not answer/)
  })

  it('updates Windows and the AppImage in place, macOS through the install script, a deb by notice', () => {
    const s = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, packaged = true) => updateStrategy({ platform, packaged, env })
    expect(s('win32')).toBe('electron-updater')
    expect(s('linux', { APPIMAGE: '/home/me/Apps/OpenTerminal-linux-x86_64.AppImage' })).toBe('electron-updater')
    expect(s('linux')).toBe('notice')
    expect(s('darwin')).toBe('install-script')
    expect(s('darwin', {}, false)).toBe('none')
    expect(s('win32', { OPENTERMINAL_NO_UPDATE_CHECK: '1' })).toBe('none')
    expect(s('win32', { OPENTERMINAL_NO_UPDATE_CHECK: '0' })).toBe('electron-updater')
    expect(debAssetUrl('x64')).toBe('https://github.com/spovalova/openterminal/releases/latest/download/OpenTerminal-linux-amd64.deb')
    expect(debAssetUrl('arm64')).toMatch(/OpenTerminal-linux-arm64\.deb$/)
  })

  it('tells the install script which folder holds this Open Terminal.app', () => {
    expect(installDirOfMacApp('/Applications/Open Terminal.app/Contents/MacOS/Open Terminal')).toBe('/Applications')
    expect(installDirOfMacApp('/Users/me/Applications/Open Terminal.app/Contents/MacOS/Open Terminal')).toBe('/Users/me/Applications')
    expect(installDirOfMacApp('/opt/Open Terminal/openterminal-app')).toBeUndefined()
  })

  it('builds the tray menu, with the update in place of the check when one is known', () => {
    const labels = (o: Parameters<typeof trayMenu>[0]) => trayMenu(o).map((i) => i.label ?? '—')
    expect(labels({ version: '0.1.0' })).toEqual(['Open Terminal 0.1.0', '—', 'Open', 'Open in browser', 'Check for updates', '—', 'Quit'])
    expect(labels({ version: '0.1.0', available: '0.2.0' })).toContain('Update to 0.2.0…')
    expect(trayMenu({ version: '0.1.0' })[0]!.enabled).toBe(false)
  })

  it('sends links off the app’s origin to the system browser', () => {
    const app = 'http://127.0.0.1:4242'
    expect(isExternal('https://finnhub.io/register', app)).toBe(true)
    expect(isExternal('http://127.0.0.1:4242/#data', app)).toBe(false)
    expect(isExternal('http://127.0.0.1:5000/', app)).toBe(true)
    expect(isExternal('file:///etc/passwd', app)).toBe(false)
    expect(isExternal('javascript:alert(1)', app)).toBe(false)
  })
})
