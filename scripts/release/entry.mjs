// lib/openterminal.mjs in the release bundle: the one file any wrapper runs (the archive's bin/openterminal, the npm
// package's bin, `node lib/openterminal.mjs`). It checks the Node version, silences node:sqlite's ExperimentalWarning
// (Node 22 prints one on every start, nothing a user can act on; the archives' Node 24 prints none), then loads the
// bundled CLI. It is a separate, unbundled file because the bundle's static `import 'node:sqlite'` would warn before
// any of the bundle's own code ran.
/* global process, console */
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Open Terminal needs Node 22.13 or later (for node:sqlite); this is Node ${process.versions.node}.`)
  process.exit(1)
}

const emitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type
  const name = typeof warning === 'object' && warning !== null ? warning.name : type
  const text = typeof warning === 'string' ? warning : warning?.message
  if (name === 'ExperimentalWarning' && /sqlite/i.test(String(text))) return
  return emitWarning.call(process, warning, ...rest)
}

await import('./cli.mjs')
