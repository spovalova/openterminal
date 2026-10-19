// Write the built-in recipe table into README.md between `<!-- recipes:start -->` and `<!-- recipes:end -->`, so the
// README cannot drift from packages/core/recipes.yml. `pnpm readme:recipes` rewrites it; `--check` exits 1 when the
// README is stale (packages/core/test/readme-recipes.test.ts runs the same comparison).
import { readFileSync, writeFileSync } from 'node:fs'
import { recipesMarkdownTable } from '@terminal/core'
import { builtinRecipes } from '@terminal/core/node'

export const START = '<!-- recipes:start -->'
export const END = '<!-- recipes:end -->'

/** The README with the recipe table replaced; throws when the markers are missing. */
export function withRecipeTable(readme: string, table: string): string {
  const a = readme.indexOf(START)
  const b = readme.indexOf(END)
  if (a < 0 || b < 0 || b < a) throw new Error(`README has no ${START} … ${END} block`)
  return `${readme.slice(0, a + START.length)}\n${table}\n${readme.slice(b)}`
}

const path = new URL('../README.md', import.meta.url)
const current = readFileSync(path, 'utf8')
const next = withRecipeTable(current, recipesMarkdownTable(builtinRecipes()))
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('README.md recipe table is stale; run `pnpm readme:recipes`')
    process.exit(1)
  }
  console.error('README.md recipe table is current')
} else if (next !== current) {
  writeFileSync(path, next)
  console.error('README.md recipe table updated')
} else console.error('README.md recipe table already current')
