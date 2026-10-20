// Open Terminal's Electron main process. It runs the release bundle's server (lib/openterminal.mjs, the same files
// `npx openterminal` runs) in an Electron utility process on 127.0.0.1, port 4242 when free or the next free one,
// waits for /api/health, and opens a window on it. One instance per user; closing the window keeps the app in the
// tray (menu bar on macOS); Quit stops the server. Data stays in ~/.openterminal, shared with the CLI.
//
// `--no-window` starts the server only and prints `OPENTERMINAL_URL=<url>` (the release smoke test); `--port <n>`
// pins the port.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron'
import { autoUpdater } from 'electron-updater'
import { compareVersions, fetchLatestVersion } from 'openterminal/update-check'
import { debAssetUrl, INSTALL_SCRIPT, installDirOfMacApp, isExternal, libDir, parseDesktopArgs, pickPort, RELEASES_PAGE, trayMenu, updateStrategy, waitForHealth, type TrayItem } from './shared.js'

const VERSION = app.getVersion()
const args = parseDesktopArgs(process.argv.slice(1))
const strategy = args.noWindow ? 'none' : updateStrategy({ platform: process.platform, packaged: app.isPackaged, env: process.env })
const dataDir = process.env.OPENTERMINAL_HOME?.trim() || join(homedir(), '.openterminal')

let server: UtilityProcess | undefined
let serverExited = false
let quitting = false
let url = ''
let win: BrowserWindow | undefined
let tray: Tray | undefined
let available: string | undefined
let log: WriteStream | undefined

function note(line: string) {
  log?.write(`${new Date().toISOString()} [desktop] ${line}\n`)
  if (args.noWindow) console.log(`[desktop] ${line}`)
}

function asset(name: string): string {
  return join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build'), name)
}

// ---- the server ----

async function startServer(): Promise<string> {
  mkdirSync(dataDir, { recursive: true })
  log = createWriteStream(join(dataDir, 'desktop.log'), { flags: 'w', mode: 0o600 })
  const port = args.port ?? (await pickPort())
  const lib = libDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  note(`Open Terminal ${VERSION}: server from ${lib} on port ${port}`)
  server = utilityProcess.fork(join(lib, 'openterminal.mjs'), ['--no-open', '--port', String(port)], {
    serviceName: 'Open Terminal server',
    stdio: 'pipe',
    // The app checks for updates itself; the CLI's daily check would only print to this log.
    env: { ...process.env, OPENTERMINAL_NO_UPDATE_CHECK: '1' },
  })
  for (const stream of [server.stdout, server.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      log?.write(chunk)
      if (args.noWindow) process.stdout.write(chunk)
    })
  }
  server.on('exit', (code) => {
    serverExited = true
    note(`server exited (${code})`)
    if (quitting) return
    if (!args.noWindow) dialog.showErrorBox('Open Terminal stopped', `The server exited (code ${code}). The log is ${join(dataDir, 'desktop.log')}.`)
    app.exit(1)
  })
  const base = `http://127.0.0.1:${port}`
  await waitForHealth(base, { timeoutMs: 90_000, alive: () => !serverExited })
  note(`ready at ${base}`)
  return base
}

// ---- the window ----

function showWindow() {
  if (!url) return
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Open Terminal',
    backgroundColor: '#0c0c0c',
    show: false,
    autoHideMenuBar: true,
    icon: asset('icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const origin = new URL(url).origin
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternal(target, origin)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin === origin) return
    e.preventDefault()
    if (isExternal(target, origin)) void shell.openExternal(target)
  })
  win.once('ready-to-show', () => win?.show())
  // Closing the window keeps the app (and the server) running in the tray; Quit ends both.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })
  void win.loadURL(url)
}

// ---- the tray ----

function refreshTray() {
  if (!tray) return
  const act: Record<NonNullable<TrayItem['action']>, () => void> = {
    open: showWindow,
    browser: () => void shell.openExternal(url),
    update: () => void checkForUpdates(true),
    quit: () => app.quit(),
  }
  const template: MenuItemConstructorOptions[] = trayMenu({ version: VERSION, ...(available ? { available } : {}) }).map((item) =>
    item.type === 'separator' ? { type: 'separator' } : { label: item.label!, enabled: item.enabled ?? true, ...(item.action ? { click: act[item.action] } : {}) },
  )
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  const icon = process.platform === 'darwin' ? nativeImage.createFromPath(asset('trayTemplate.png')) : nativeImage.createFromPath(asset('tray.png'))
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Open Terminal')
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow()
  })
  refreshTray()
}

// ---- updates ----

async function latestNewer(): Promise<string | undefined> {
  if (strategy === 'electron-updater') {
    const r = await autoUpdater.checkForUpdates()
    const v = r?.updateInfo.version
    return v && compareVersions(v, VERSION) > 0 ? v : undefined
  }
  const v = await fetchLatestVersion({ timeoutMs: 8000 })
  return v && compareVersions(v, VERSION) > 0 ? v : undefined
}

/**
 * macOS: start the install script for `version`, detached so it outlives this process: it quits the running app,
 * swaps the bundle in place (no quarantine flag, since curl sets none) and opens the new one. Its output goes to
 * `~/.openterminal/update.log`.
 */
function startInstallScript(version: string): void {
  const updateLog = join(dataDir, 'update.log')
  // The directory holding this Open Terminal.app (…/Open Terminal.app/Contents/MacOS/Open Terminal), so the script
  // replaces this copy wherever it was put.
  const appDir = installDirOfMacApp(process.execPath)
  const env = { ...process.env, OPENTERMINAL_VERSION: version, OPENTERMINAL_UPDATE_LOG: updateLog, ...(appDir ? { OPENTERMINAL_APP_DIR: appDir } : {}) }
  const child = spawn('/bin/sh', ['-c', `${INSTALL_SCRIPT} >> "$OPENTERMINAL_UPDATE_LOG" 2>&1`], { detached: true, stdio: 'ignore', env })
  child.unref()
  note(`install script started for ${version} (pid ${child.pid}${appDir ? `, ${appDir}` : ''}); output in ${updateLog}`)
}

async function update(version: string) {
  if (strategy === 'electron-updater') {
    note(`downloading ${version}`)
    await autoUpdater.downloadUpdate()
    quitting = true
    autoUpdater.quitAndInstall(false, true)
  } else if (strategy === 'install-script') {
    // The script quits this app itself once the new one is downloaded and checked, then reopens it.
    startInstallScript(version)
  } else {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Open Terminal ${version} is available`,
      detail: 'This copy was installed from a .deb, so the package manager updates it: download the new .deb and install it.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
    })
    if (response === 0) void shell.openExternal(debAssetUrl(process.arch))
  }
}

/** Quiet on start (a notification and the tray item when there is news); `interactive` from the menu answers either way. */
async function checkForUpdates(interactive: boolean) {
  if (strategy === 'none') {
    if (interactive) void dialog.showMessageBox({ type: 'info', message: 'Updates are off for this copy', detail: app.isPackaged ? 'OPENTERMINAL_NO_UPDATE_CHECK is set.' : 'This is a development build.', buttons: ['OK'] })
    return
  }
  let version: string | undefined
  try {
    version = available ?? (await latestNewer())
  } catch (err) {
    note(`update check failed: ${err instanceof Error ? err.message : String(err)}`)
    if (interactive) void dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: `${err instanceof Error ? err.message : String(err)}\n\nReleases: ${RELEASES_PAGE}`, buttons: ['OK'] })
    return
  }
  if (!version) {
    if (interactive) void dialog.showMessageBox({ type: 'info', message: `Open Terminal ${VERSION} is up to date.`, buttons: ['OK'] })
    return
  }
  if (available !== version) {
    available = version
    refreshTray()
  }
  if (!interactive) {
    if (Notification.isSupported()) {
      const n = new Notification({ title: `Open Terminal ${version} is available`, body: 'Click to update, or use the tray menu later.' })
      n.on('click', () => void checkForUpdates(true))
      n.show()
    }
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: `Open Terminal ${version} is available`,
    detail: `This is ${VERSION}. Updating restarts the app; your workspaces and keys stay in ${dataDir}.`,
    buttons: ['Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    try {
      await update(version)
    } catch (err) {
      dialog.showErrorBox('Update failed', `${err instanceof Error ? err.message : String(err)}\n\nReleases: ${RELEASES_PAGE}`)
    }
  }
}

function setUpUpdater() {
  if (strategy !== 'electron-updater') return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Nothing is signed: the installer's integrity comes from the sha512 in latest*.yml, not a publisher certificate.
  const nsis = autoUpdater as unknown as { verifyUpdateCodeSignature?: unknown }
  if (process.platform === 'win32' && 'verifyUpdateCodeSignature' in nsis) nsis.verifyUpdateCodeSignature = async () => null
  autoUpdater.logger = { info: (m: unknown) => note(String(m)), warn: (m: unknown) => note(String(m)), error: (m: unknown) => note(String(m)), debug: () => {} }
}

// ---- lifecycle ----

if (!args.noWindow && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('activate', () => showWindow())
  // The tray keeps the app alive with no window open.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
    if (server && !serverExited) server.kill()
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())

  void app.whenReady().then(async () => {
    if (args.noWindow && process.platform === 'darwin') app.dock?.hide()
    try {
      url = await startServer()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      note(`could not start: ${message}`)
      if (!args.noWindow) dialog.showErrorBox('Open Terminal could not start', `${message}\n\nThe log is ${join(dataDir, 'desktop.log')}.`)
      app.exit(1)
      return
    }
    if (args.noWindow) {
      console.log(`OPENTERMINAL_URL=${url}`)
      return
    }
    setUpUpdater()
    createTray()
    showWindow()
    setTimeout(() => void checkForUpdates(false), 10_000)
    setInterval(() => void checkForUpdates(false), 24 * 60 * 60 * 1000).unref()
  })
}
