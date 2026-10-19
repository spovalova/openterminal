#!/usr/bin/env node
/* global process, console, fetch, Buffer */
// Vendor the Pyodide wheels the transform engine loads (pandas, scipy, tzdata and their dependencies) into
// packages/server/pyodide/, so `loadPackage` reads them from disk and nothing is fetched at runtime.
//
//   node packages/server/scripts/vendor-pyodide.mjs            # download what is missing, verify every hash
//   node packages/server/scripts/vendor-pyodide.mjs --check    # verify only (exit 1 when a wheel is missing or wrong)
//
// The wheel list and hashes come from the lock file shipped inside the installed `pyodide` npm package, so bumping
// the dependency and re-running this script is the whole upgrade. Files are fetched from the Pyodide CDN for that
// exact version and checked against the lock's sha256 before they are kept.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pyodideDir = dirname(require.resolve('pyodide/package.json'))
const { version } = JSON.parse(readFileSync(join(pyodideDir, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(pyodideDir, 'pyodide-lock.json'), 'utf8'))
const outDir = resolve(here, '../pyodide')
const check = process.argv.includes('--check')

/** The packages the worker loads; the closure over `depends` is what gets vendored. */
export const ROOT_PACKAGES = ['pandas', 'scipy', 'tzdata']

export function closure(packages, roots = ROOT_PACKAGES) {
  const seen = new Set()
  const visit = (name) => {
    if (seen.has(name)) return
    const p = packages[name]
    if (!p) throw new Error(`"${name}" is not in the Pyodide lock file`)
    seen.add(name)
    for (const d of p.depends) visit(d)
  }
  for (const r of roots) visit(r)
  return [...seen].sort().map((name) => ({ name, file: packages[name].file_name, sha256: packages[name].sha256, version: packages[name].version }))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const wheels = closure(lock.packages)
mkdirSync(outDir, { recursive: true })
let bad = 0
let bytes = 0
for (const w of wheels) {
  const path = join(outDir, w.file)
  if (!existsSync(path) || sha256(path) !== w.sha256) {
    if (check) {
      console.error(`missing or wrong: ${w.file}`)
      bad++
      continue
    }
    const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${w.file}`
    process.stderr.write(`fetching ${w.file} … `)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(path, buf)
    if (sha256(path) !== w.sha256) {
      unlinkSync(path)
      throw new Error(`${w.file}: sha256 mismatch against the lock file`)
    }
    process.stderr.write('ok\n')
  }
  bytes += readFileSync(path).byteLength
}
// Wheels from an older version are dead weight; name them so they can be removed.
const wanted = new Set(wheels.map((w) => w.file))
for (const f of readdirSync(outDir)) if (f.endsWith('.whl') && !wanted.has(f)) console.error(`stale wheel (not in pyodide ${version}): ${f}`)
if (bad) process.exit(1)
console.log(`pyodide ${version}: ${wheels.length} wheels, ${(bytes / 1e6).toFixed(1)} MB in ${outDir}`)
for (const w of wheels) console.log(`  ${w.name} ${w.version}`)
