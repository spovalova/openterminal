#!/usr/bin/env node
/* global process, console */
// Build the desktop app: the release bundle (scripts/release/bundle.mjs, unless it is already there), the main
// process (src/main.ts → dist/main.cjs, esbuild, electron-updater bundled in), then electron-builder for this machine's
// platform. Nothing is published: release/ gets the installers and electron-builder's latest*.yml, under the release
// asset names (PLAN.md section 18), and the workflow uploads them.
//
//   node scripts/build.mjs                    # this platform's installers (mac: dmg + zip, arm64 and x64;
//                                             #   win: NSIS x64; linux: AppImage + deb for this machine's arch)
//   node scripts/build.mjs --dir              # an unpacked app only (release/<platform>-unpacked), fastest
//   node scripts/build.mjs --no-package       # dist/main.cjs only, for `electron .`
//   node scripts/build.mjs --rebuild-bundle   # rebuild dist/release/lib even when it exists
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pkgDir, '../..')
const lib = join(repo, 'dist/release/lib')
const flag = (f) => process.argv.includes(f)

// One version for everything: the CLI's package.json.
const version = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8')).version
const electronVersion = JSON.parse(readFileSync(join(pkgDir, 'node_modules/electron/package.json'), 'utf8')).version

if (flag('--rebuild-bundle') || !existsSync(join(lib, 'openterminal.mjs'))) {
  execFileSync(process.execPath, [join(repo, 'scripts/release/bundle.mjs')], { stdio: 'inherit', cwd: repo })
}

rmSync(join(pkgDir, 'dist'), { recursive: true, force: true })
await esbuild.build({
  entryPoints: [join(pkgDir, 'src/main.ts')],
  outfile: join(pkgDir, 'dist/main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  logLevel: 'warning',
})
console.error(`dist/main.cjs (Open Terminal ${version}, Electron ${electronVersion})`)
if (flag('--no-package')) process.exit(0)

/** The release asset names (PLAN.md section 18): `${arch}` is x86_64 for an AppImage, amd64 for a deb, else x64/arm64. */
export const config = {
  appId: 'ai.spova.openterminal',
  productName: 'Open Terminal',
  copyright: 'Copyright © 2026 Open Terminal contributors (MIT)',
  electronVersion,
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/main.cjs', 'package.json'],
  // `desktopName` is the WM_CLASS Electron sets, so desktops tie the window to the .desktop entry.
  extraMetadata: { version, main: 'dist/main.cjs', name: 'openterminal-desktop', desktopName: 'openterminal-app.desktop' },
  // The bundle stays outside the asar archive: the server runs from it and Pyodide reads its files with fs.
  extraResources: [
    { from: '../../dist/release/lib', to: 'lib' },
    { from: 'build', to: '.', filter: ['icon.png', 'tray.png', 'trayTemplate.png', 'trayTemplate@2x.png'] },
  ],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  // Where electron-updater looks (app-update.yml); the workflow uploads the files itself.
  publish: [{ provider: 'github', owner: 'spovalova', repo: 'openterminal' }],
  // The static type-2 AppImage runtime: no libfuse2 or libz.so needed on the user's system (the legacy one needs both).
  toolsets: { appimage: '1.0.3' },
  mac: {
    category: 'public.app-category.finance',
    icon: 'build/icon.icns',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // Unsigned: no Apple Developer ID. Ad-hoc signing is what lets the arm64 build run at all on Apple silicon; the
    // hardened runtime would reject Electron's own frameworks under an ad-hoc signature.
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    artifactName: 'OpenTerminal-mac-${arch}.${ext}',
  },
  dmg: { artifactName: 'OpenTerminal-mac-${arch}.${ext}' },
  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    // Unsigned: electron-updater checks the installer's sha512 from latest.yml, not a publisher certificate.
    verifyUpdateCodeSignature: false,
    artifactName: 'OpenTerminal-win-${arch}-setup.${ext}',
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, artifactName: 'OpenTerminal-win-${arch}-setup.${ext}' },
  linux: {
    icon: 'build/icon.png',
    category: 'Finance',
    // Not `openterminal`: that is the CLI's command (npx openterminal).
    executableName: 'openterminal-app',
    syncDesktopName: true,
    synopsis: 'The open-source, AI-native terminal for traders',
    description: 'Ask a question, get a live workspace of charts, tables and option chains, and an answer that points at them.',
    maintainer: 'Open Terminal <noreply@spova.ai>',
    target: ['AppImage', 'deb'],
    artifactName: 'OpenTerminal-linux-${arch}.${ext}',
  },
  appImage: { artifactName: 'OpenTerminal-linux-${arch}.${ext}' },
  deb: { packageName: 'openterminal', artifactName: 'OpenTerminal-linux-${arch}.${ext}' },
}

const { build, Platform, Arch } = await import('electron-builder')
const platform = process.platform === 'darwin' ? Platform.MAC : process.platform === 'win32' ? Platform.WINDOWS : Platform.LINUX
let targets
if (flag('--dir')) targets = platform.createTarget(['dir'], Arch[process.arch])
else if (platform === Platform.LINUX) targets = platform.createTarget(['AppImage', 'deb'], Arch[process.arch])
else targets = platform.createTarget()
const files = await build({ projectDir: pkgDir, targets, config, publish: 'never' })
for (const f of files) console.error(`  ${f}`)
