// Node-only helpers: reading the built-in YAML data files, where the config directory is, and where the runtime
// resources are (resources.ts). Kept out of index.ts so the web bundle never imports node:fs.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseAnnotations, type AnnotationRule } from './annotations.js'
import { parseRecipes, type Recipe } from './recipes.js'
import { resources } from './resources.js'

export { BUNDLE_FILES, isBundled, resourcePaths, resources, type ResourceLayout, type Resources } from './resources.js'

/** packages/core/recipes.yml from source, lib/data/recipes.yml in the release bundle. */
export const BUILTIN_RECIPES_PATH = resources().recipes
/** packages/core/annotations.yml from source, lib/data/annotations.yml in the release bundle. */
export const BUILTIN_ANNOTATIONS_PATH = resources().annotations

export function loadYamlFile(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8'))
}

/** Recipes from a YAML file (`recipes:` list or a bare list). */
export function loadRecipesFile(path: string = BUILTIN_RECIPES_PATH): Recipe[] {
  return parseRecipes(loadYamlFile(path))
}

/** Annotation rules from a YAML file; `orderFrom` lets a user file rank after the built-in one on ties. */
export function loadAnnotationsFile(path: string = BUILTIN_ANNOTATIONS_PATH, opts: { orderFrom?: number } = {}): AnnotationRule[] {
  return parseAnnotations(loadYamlFile(path), opts)
}

let recipesMemo: Recipe[] | undefined
let annotationsMemo: AnnotationRule[] | undefined

/** The built-in recipes (packages/core/recipes.yml), parsed once. */
export function builtinRecipes(): Recipe[] {
  return (recipesMemo ??= loadRecipesFile())
}

/** The built-in annotations (packages/core/annotations.yml), parsed once. */
export function builtinAnnotations(): AnnotationRule[] {
  return (annotationsMemo ??= loadAnnotationsFile())
}

/** The config directory's name under the user's home directory. */
export const HOME_DIR = '.openterminal'
/** Its name before the product was renamed to Open Terminal (2026-10-19); the server copies it across once. */
export const LEGACY_HOME_DIR = '.terminal'

export type HomeOverride = { path: string; variable: 'OPENTERMINAL_HOME' | 'TERMINAL_HOME' }

/** The directory the environment names: `OPENTERMINAL_HOME`, else the deprecated `TERMINAL_HOME`; undefined when neither is set. */
export function homeOverride(env: NodeJS.ProcessEnv = process.env): HomeOverride | undefined {
  for (const variable of ['OPENTERMINAL_HOME', 'TERMINAL_HOME'] as const) {
    const path = env[variable]?.trim()
    if (path) return { path, variable }
  }
  return undefined
}

/**
 * Where config.yml, the store, the catalog cache and the user's recipes and annotations live: `OPENTERMINAL_HOME`,
 * else `TERMINAL_HOME` (the variable's name before the rename, still honoured), else `~/.openterminal`. A path only;
 * the server's `resolveHome` adds the one-time copy from `~/.terminal`.
 */
export function openterminalHome(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): string {
  return homeOverride(env)?.path ?? join(userHome, HOME_DIR)
}
