#!/usr/bin/env node
/* global process, console */
// Build the release bundle: dist/release/lib/, the whole app in one directory that needs nothing but a Node runtime
// (≥ 22.13) to run. Every wrapper consumes this directory unchanged: the npm package (npm.mjs), the desktop app, or
// anything else later. No tsx, no pnpm, no node_modules at runtime. Smoke-test it with smoke.mjs.
//
//   node scripts/release/bundle.mjs              # build the web app, bundle, copy the resources
//   node scripts/release/bundle.mjs --skip-web   # reuse packages/web/dist as it is
//
// lib/ holds (names in packages/core/src/resources.ts, BUNDLE_FILES; `resources()` reads them at runtime):
//   openterminal.mjs        the entry (scripts/release/entry.mjs): Node version check, warning filter, loads cli.mjs
//   cli.mjs                 CLI + server + connectors, bundled by esbuild (ESM, node22)
//   transform-worker.mjs    the Pyodide worker thread, bundled with Pyodide's JS loader
//   transform/              runtime.py and ot.py, written into the Python filesystem at boot
//   data/                   recipes.yml and annotations.yml, the built-in recipes and annotations
//   web/                    the built web app, served statically
//   pyodide/                Pyodide's runtime files: pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, the lock file
//   wheels/                 the vendored wheels (pandas, numpy, scipy and their closure)
//   xdg-open                the `open` package's fallback launcher for Linux desktops without xdg-utils
//   LICENSE, THIRD-PARTY-NOTICES.txt
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const RELEASE_DIR = join(repo, 'dist/release')
export const LIB_DIR = join(RELEASE_DIR, 'lib')
const skipWeb = process.argv.includes('--skip-web')

const version = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8')).version
const pyodideDir = join(repo, 'packages/server/node_modules/pyodide')
const PYODIDE_RUNTIME = ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']

function run(cmd, args, opts = {}) {
  console.error(`$ ${cmd} ${args.join(' ')}`)
  // pnpm and npm are .cmd shims on Windows, which execFileSync only finds through a shell.
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, shell: process.platform === 'win32', ...opts })
}

function du(path) {
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((n, f) => n + du(join(path, f)), 0)
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`

// ---- 1. the web app and the wheels ----
if (!skipWeb) run('pnpm', ['--filter', '@openterminal/web', 'build'])
if (!existsSync(join(repo, 'packages/web/dist/index.html'))) throw new Error('packages/web/dist is missing; run without --skip-web')
run(process.execPath, ['packages/server/scripts/vendor-pyodide.mjs', '--check'])

rmSync(LIB_DIR, { recursive: true, force: true })
mkdirSync(LIB_DIR, { recursive: true })

// ---- 2. the two bundles ----
// CommonJS dependencies (ws, undici, …) call require() for node builtins; an ESM bundle has none, so give it one.
const banner = { js: "import { createRequire as __openterminalRequire } from 'node:module';\nconst require = __openterminalRequire(import.meta.url);" }
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // `resources()` switches to the lib/ layout on this constant.
  define: { __OPENTERMINAL_BUNDLE__: 'true' },
  banner,
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  absWorkingDir: repo,
}
const main = await esbuild.build({ ...common, entryPoints: ['packages/cli/src/bin.ts'], outfile: join(LIB_DIR, 'cli.mjs') })
const worker = await esbuild.build({
  ...common,
  entryPoints: ['packages/server/src/transform/worker.ts'],
  outfile: join(LIB_DIR, 'transform-worker.mjs'),
  // Pyodide's ESM loader imports `ws` only when `require` is undefined, which the banner rules out; never bundle it.
  external: ['ws'],
})
cpSync(join(repo, 'scripts/release/entry.mjs'), join(LIB_DIR, 'openterminal.mjs'))

// ---- 3. the resources ----
mkdirSync(join(LIB_DIR, 'transform'))
for (const f of ['runtime.py', 'ot.py']) cpSync(join(repo, 'packages/server/src/transform', f), join(LIB_DIR, 'transform', f))
mkdirSync(join(LIB_DIR, 'data'))
for (const f of ['recipes.yml', 'annotations.yml']) cpSync(join(repo, 'packages/core', f), join(LIB_DIR, 'data', f))
cpSync(join(repo, 'packages/web/dist'), join(LIB_DIR, 'web'), { recursive: true })
mkdirSync(join(LIB_DIR, 'pyodide'))
for (const f of PYODIDE_RUNTIME) cpSync(join(pyodideDir, f), join(LIB_DIR, 'pyodide', f))
mkdirSync(join(LIB_DIR, 'wheels'))
const lock = JSON.parse(readFileSync(join(pyodideDir, 'pyodide-lock.json'), 'utf8'))
const wanted = new Set(Object.values(lock.packages).map((p) => p.file_name))
for (const f of readdirSync(join(repo, 'packages/server/pyodide'))) if (wanted.has(f)) cpSync(join(repo, 'packages/server/pyodide', f), join(LIB_DIR, 'wheels', f))
const xdg = join(repo, 'packages/cli/node_modules/open/xdg-open')
if (existsSync(xdg)) {
  cpSync(xdg, join(LIB_DIR, 'xdg-open'))
  chmodSync(join(LIB_DIR, 'xdg-open'), 0o755)
}
cpSync(join(repo, 'LICENSE'), join(LIB_DIR, 'LICENSE'))

// ---- 4. third-party notices: every package in either bundle or in the web app ----
/** node_modules/.pnpm/x@1/node_modules/@scope/name/dist/a.js → node_modules/.pnpm/x@1/node_modules/@scope/name */
function packageDirOf(input) {
  const abs = resolve(repo, input)
  const parts = abs.split(sep)
  const i = parts.lastIndexOf('node_modules')
  if (i < 0) return undefined
  const n = parts[i + 1]?.startsWith('@') ? 3 : 2
  return parts.slice(0, i + n).join(sep)
}
async function webInputs() {
  // The web app is built by Vite; an esbuild pass over the same entry (no output) lists the packages it pulls in.
  const r = await esbuild.build({
    entryPoints: ['packages/web/src/main.tsx'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    absWorkingDir: repo,
  })
  return Object.keys(r.metafile.inputs)
}
const inputs = [...Object.keys(main.metafile.inputs), ...Object.keys(worker.metafile.inputs), ...(await webInputs())]
const pkgDirs = new Set(inputs.map(packageDirOf).filter(Boolean))
const notices = []
for (const dir of [...pkgDirs].sort((a, b) => relative(repo, a).split('node_modules').at(-1).localeCompare(relative(repo, b).split('node_modules').at(-1)))) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const licenseFile = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f))
  const text = licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : `License: ${pj.license ?? 'see the package'} (the package ships no license file).`
  notices.push({ id: `${pj.name}@${pj.version}`, license: pj.license, text })
}
const seen = new Set()
const unique = notices.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
const pyNames = Object.values(lock.packages).filter((p) => wanted.has(p.file_name) && existsSync(join(LIB_DIR, 'wheels', p.file_name)))
const header = [
  `Open Terminal ${version} (MIT, see LICENSE) bundles the software below. Each entry is a package name and version,`,
  'then its license as the package ships it.',
  '',
  'Also included, unmodified:',
  `- Pyodide ${JSON.parse(readFileSync(join(pyodideDir, 'package.json'), 'utf8')).version} (MPL-2.0; source: https://github.com/pyodide/pyodide), in pyodide/ and inside transform-worker.mjs;`,
  '  it carries CPython (PSF License) and its standard library.',
  `- Python wheels in wheels/: ${pyNames.map((p) => `${p.name} ${p.version}`).join(', ')}. Each wheel holds its own`,
  '  license in its *.dist-info directory (pandas, numpy, scipy: BSD-3-Clause; python-dateutil: Apache-2.0 or BSD-3-Clause;',
  '  pytz, six: MIT; tzdata: Apache-2.0).',
  '',
]
const ioskeley = join(repo, 'packages/ui/src/fonts/ioskeley/LICENSE')
const body = unique.map((n) => `${'='.repeat(78)}\n${n.id}${n.license ? ` (${n.license})` : ''}\n${'-'.repeat(78)}\n${n.text}\n`)
if (existsSync(ioskeley)) body.push(`${'='.repeat(78)}\nIoskeley Mono (OFL-1.1), vendored in the web app\n${'-'.repeat(78)}\n${readFileSync(ioskeley, 'utf8').trim()}\n`)
writeFileSync(join(LIB_DIR, 'THIRD-PARTY-NOTICES.txt'), header.join('\n') + '\n' + body.join('\n'))

// ---- 5. report ----
const sizes = Object.fromEntries(readdirSync(LIB_DIR).map((f) => [f, du(join(LIB_DIR, f))]))
console.error(`\nOpen Terminal ${version}: ${LIB_DIR} (${mb(du(LIB_DIR))}), ${unique.length} third-party packages in the notices`)
for (const [f, n] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) console.error(`  ${f.padEnd(26)} ${mb(n)}`)
