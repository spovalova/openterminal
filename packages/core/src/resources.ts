// Where the files Open Terminal reads at runtime live: the built-in recipes and annotations, the built web app, the
// Pyodide runtime with its vendored wheels, and the transform worker with its Python helpers. One table, two layouts:
//
// - `source`: running from the monorepo (`pnpm dev`, the tests, `packages/cli/bin/openterminal.js` under tsx). Paths
//   are relative to the repo root, found from this file's own location.
// - `bundle`: running from the release bundle (`scripts/release/bundle.mjs`), whatever wraps it (the per-platform
//   archive with its own Node runtime, the npm package). Every file sits in one directory, the bundle's `lib/`, next
//   to `openterminal.mjs`; esbuild defines `__OPENTERMINAL_BUNDLE__` there, so the layout is known without probing.
//
// Everything that reads one of these files asks this module, so a new wrapper only has to keep `lib/` intact.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Defined (as `true`) by the release bundler only. */
declare const __OPENTERMINAL_BUNDLE__: boolean | undefined

export type ResourceLayout = 'source' | 'bundle'

export type Resources = {
  layout: ResourceLayout
  /** The repo root (`source`) or the bundle's `lib/` directory (`bundle`). */
  root: string
  /** The built-in recipes, `recipes.yml`. */
  recipes: string
  /** The built-in annotations, `annotations.yml`. */
  annotations: string
  /** The built web app (index.html, assets/), served statically by the server. */
  webDist: string
  /** The Pyodide runtime: pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json. Pyodide's `indexURL`. */
  pyodide: string
  /** The vendored wheels (pandas, numpy, scipy and their closure); Pyodide's `packageCacheDir`. */
  wheels: string
  /** The transform worker's entry file, started as a worker thread. */
  transformWorker: string
  /** The directory holding the worker's Python helpers, `runtime.py` and `ot.py`. */
  transformScripts: string
}

/** The bundle's file names inside `lib/`; `scripts/release/bundle.mjs` writes exactly these. */
export const BUNDLE_FILES = {
  entry: 'openterminal.mjs',
  transformWorker: 'transform-worker.mjs',
  transformScripts: 'transform',
  recipes: 'data/recipes.yml',
  annotations: 'data/annotations.yml',
  webDist: 'web',
  pyodide: 'pyodide',
  wheels: 'wheels',
} as const

/** The resource paths for a layout rooted at `root`. Pure; `resources()` picks the layout and root for this process. */
export function resourcePaths(layout: ResourceLayout, root: string): Resources {
  if (layout === 'bundle') {
    return {
      layout,
      root,
      recipes: join(root, BUNDLE_FILES.recipes),
      annotations: join(root, BUNDLE_FILES.annotations),
      webDist: join(root, BUNDLE_FILES.webDist),
      pyodide: join(root, BUNDLE_FILES.pyodide),
      wheels: join(root, BUNDLE_FILES.wheels),
      transformWorker: join(root, BUNDLE_FILES.transformWorker),
      transformScripts: join(root, BUNDLE_FILES.transformScripts),
    }
  }
  return {
    layout,
    root,
    recipes: join(root, 'packages/core/recipes.yml'),
    annotations: join(root, 'packages/core/annotations.yml'),
    webDist: join(root, 'packages/web/dist'),
    // pnpm links the dependency here; Pyodide's own files are read from the package directory.
    pyodide: join(root, 'packages/server/node_modules/pyodide'),
    wheels: join(root, 'packages/server/pyodide'),
    transformWorker: join(root, 'packages/server/src/transform/worker.ts'),
    transformScripts: join(root, 'packages/server/src/transform'),
  }
}

/** True inside the release bundle. */
export function isBundled(): boolean {
  return typeof __OPENTERMINAL_BUNDLE__ !== 'undefined' && __OPENTERMINAL_BUNDLE__ === true
}

let memo: Resources | undefined

/**
 * This process's resource paths. In the bundle, `import.meta.url` is `lib/openterminal.mjs` (or the worker beside it)
 * whichever module asks; from source it is this file, `packages/core/src/resources.ts`, three levels below the root.
 */
export function resources(): Resources {
  if (memo) return memo
  const here = dirname(fileURLToPath(import.meta.url))
  memo = isBundled() ? resourcePaths('bundle', here) : resourcePaths('source', resolve(here, '../../..'))
  return memo
}
