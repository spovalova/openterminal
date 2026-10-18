// Node-only helpers: reading the built-in YAML data files. Kept out of index.ts so the web bundle never imports node:fs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { parseAnnotations, type AnnotationRule } from './annotations.js'
import { parseRecipes, type Recipe } from './recipes.js'

export const BUILTIN_RECIPES_PATH = fileURLToPath(new URL('../recipes.yml', import.meta.url))
export const BUILTIN_ANNOTATIONS_PATH = fileURLToPath(new URL('../annotations.yml', import.meta.url))

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
