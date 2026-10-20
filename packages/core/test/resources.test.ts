import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUILTIN_ANNOTATIONS_PATH, BUILTIN_RECIPES_PATH, BUNDLE_FILES, isBundled, resourcePaths, resources } from '../src/node.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('resources', () => {
  it('resolves every runtime file from source to the monorepo', () => {
    const r = resources()
    expect(isBundled()).toBe(false)
    expect(r.layout).toBe('source')
    expect(r.root).toBe(repo)
    expect(r.recipes).toBe(join(repo, 'packages/core/recipes.yml'))
    expect(BUILTIN_RECIPES_PATH).toBe(r.recipes)
    expect(BUILTIN_ANNOTATIONS_PATH).toBe(r.annotations)
    const files = [r.recipes, r.annotations, r.wheels, r.transformWorker, join(r.transformScripts, 'ot.py'), join(r.transformScripts, 'runtime.py'), join(r.pyodide, 'pyodide-lock.json'), join(r.pyodide, 'pyodide.asm.wasm')]
    for (const p of files) expect(existsSync(p), p).toBe(true)
    // The web app is built on demand (vite build), so only its path is fixed.
    expect(r.webDist).toBe(join(repo, 'packages/web/dist'))
  })

  it('puts everything under lib/ in the bundle layout, under the names the bundler writes', () => {
    const lib = '/opt/openterminal/0.1.0/lib'
    const r = resourcePaths('bundle', lib)
    expect(r).toEqual({
      layout: 'bundle',
      root: lib,
      recipes: join(lib, 'data/recipes.yml'),
      annotations: join(lib, 'data/annotations.yml'),
      webDist: join(lib, 'web'),
      pyodide: join(lib, 'pyodide'),
      wheels: join(lib, 'wheels'),
      transformWorker: join(lib, 'transform-worker.mjs'),
      transformScripts: join(lib, 'transform'),
    })
    for (const [key, rel] of Object.entries(BUNDLE_FILES)) if (key !== 'entry') expect(Object.values(r)).toContain(join(lib, rel))
  })
})
