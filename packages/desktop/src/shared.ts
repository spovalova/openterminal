// The desktop app's pure parts: arguments, where the bundle is, the port, the health wait, the update strategy and
// the tray menu. Nothing here imports electron, so the tests run under plain Node.
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

/** The port the app asks for first; production instances and the CLI default to it too. */
export const PREFERRED_PORT = 4242
export const RELEASES_PAGE = 'https://github.com/spovalova/openterminal/releases/latest'
export const INSTALL_SCRIPT = 'curl -fsSL https://terminal.spova.ai/install | sh'

export type DesktopArgs = {
  /** Start the server and print its URL, with no window, tray or update check (smoke tests, CI). */
  noWindow: boolean
  /** A fixed port instead of 4242-or-the-next-free-one. */
  port?: number
}

/**
 * The app's own flags among whatever else is on the command line (Chromium switches, macOS's -psn_ argument, the
 * app path in development): `--no-window`, `--port <n>` or `--port=<n>`. Everything else is ignored.
 */
export function parseDesktopArgs(argv: readonly string[]): DesktopArgs {
  const out: DesktopArgs = { noWindow: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    let port: string | undefined
    if (a === '--no-window') out.noWindow = true
    else if (a === '--port') port = argv[++i]
    else if (a.startsWith('--port=')) port = a.slice('--port='.length)
    if (port !== undefined) {
      const n = Number(port)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port ${port}`)
      out.port = n
    }
  }
  return out
}

/**
 * The release bundle's directory (scripts/release/bundle.mjs): `<resources>/lib` in a packaged app, where
 * electron-builder's extraResources puts it, outside the asar archive (Pyodide reads its files with fs, and the server
 * runs from it); the monorepo's dist/release/lib when running from source.
 */
export function libDir(o: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.packaged ? join(o.resourcesPath, 'lib') : resolve(o.appPath, '../../dist/release/lib')
}

/** True when nothing listens on `port` at `host` (a listen there succeeds). */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer()
    s.once('error', () => ok(false))
    s.listen({ port, host, exclusive: true }, () => s.close(() => ok(true)))
  })
}

/** `preferred` when it is free, else the next free port within `tries`. */
export async function pickPort(preferred = PREFERRED_PORT, tries = 50, free: (port: number) => Promise<boolean> = portFree): Promise<number> {
  for (let p = preferred; p < preferred + tries && p <= 65535; p++) if (await free(p)) return p
  throw new Error(`no free port from ${preferred} to ${preferred + tries - 1}`)
}

/** Poll `<base>/api/health` until it answers ok; throws past the timeout or once `alive()` turns false. */
export async function waitForHealth(base: string, o: { timeoutMs?: number; alive?: () => boolean; fetch?: typeof fetch; intervalMs?: number } = {}): Promise<void> {
  const f = o.fetch ?? fetch
  const until = Date.now() + (o.timeoutMs ?? 60_000)
  for (;;) {
    if (o.alive && !o.alive()) throw new Error('the server stopped before it was ready')
    try {
      const res = await f(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok && ((await res.json()) as { ok?: unknown }).ok === true) return
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error(`the server did not answer ${base}/api/health in time`)
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 150))
  }
}

/**
 * How this copy updates. Windows (NSIS) and the AppImage update in place through electron-updater from GitHub
 * Releases. An unsigned macOS app cannot use Squirrel.Mac, so it runs the install script, which replaces the app
 * without the quarantine flag. A deb (any other Linux copy) is updated by the package manager: a notice only.
 */
export type UpdateStrategy = 'electron-updater' | 'install-script' | 'notice' | 'none'

export function updateStrategy(o: { platform: NodeJS.Platform; packaged: boolean; env: NodeJS.ProcessEnv }): UpdateStrategy {
  if (!o.packaged) return 'none'
  const off = o.env.OPENTERMINAL_NO_UPDATE_CHECK?.trim().toLowerCase()
  if (off && off !== '0' && off !== 'false' && off !== 'no') return 'none'
  if (o.platform === 'win32') return 'electron-updater'
  if (o.platform === 'darwin') return 'install-script'
  if (o.platform === 'linux') return o.env.APPIMAGE ? 'electron-updater' : 'notice'
  return 'none'
}

/** `/Applications/Open Terminal.app/Contents/MacOS/Open Terminal` → `/Applications`; undefined outside an .app bundle. */
export function installDirOfMacApp(execPath: string): string | undefined {
  const m = /^(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1] || '/' : undefined
}

/** The deb a Linux user downloads by hand (the release asset contract). */
export function debAssetUrl(arch: string): string {
  return `https://github.com/spovalova/openterminal/releases/latest/download/OpenTerminal-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`
}

export type TrayItem = { label?: string; enabled?: boolean; type?: 'separator'; action?: 'open' | 'browser' | 'update' | 'quit' }

/** The tray (or menu bar) menu: the name and version, Open, Open in browser, Check for updates (or the update), Quit. */
export function trayMenu(o: { version: string; available?: string }): TrayItem[] {
  return [
    { label: `Open Terminal ${o.version}`, enabled: false },
    { type: 'separator' },
    { label: 'Open', action: 'open' },
    { label: 'Open in browser', action: 'browser' },
    { label: o.available ? `Update to ${o.available}…` : 'Check for updates', action: 'update' },
    { type: 'separator' },
    { label: 'Quit', action: 'quit' },
  ]
}

/** Links the window opens in the system browser instead of in itself: anything off the app's own origin. */
export function isExternal(target: string, appOrigin: string): boolean {
  try {
    const u = new URL(target)
    return u.origin !== appOrigin && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:')
  } catch {
    return false
  }
}
