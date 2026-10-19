import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { recipesMarkdownTable } from '../src/index.js'
import { builtinRecipes } from '../src/node.js'

const START = '<!-- recipes:start -->'
const END = '<!-- recipes:end -->'

describe('the README recipe table', () => {
  it('is generated from recipes.yml and has not drifted (run `pnpm readme:recipes` to refresh it)', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const a = readme.indexOf(START)
    const b = readme.indexOf(END)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(readme.slice(a + START.length, b).trim()).toBe(recipesMarkdownTable(builtinRecipes()))
  })
  it('lists every recipe once with its params, preset and routes', () => {
    const table = recipesMarkdownTable(builtinRecipes())
    const lines = table.split('\n')
    expect(lines).toHaveLength(2 + builtinRecipes().length)
    expect(lines[0]).toBe('| Recipe | Params | View | Reads | What it answers |')
    const quote = lines.find((l) => l.startsWith('| `quote` |'))!
    expect(quote).toContain('symbols[]')
    expect(quote).toContain('| stat |')
    expect(quote).toContain('yahoo `quote`')
    expect(quote).toContain('openbb `equity/price/quote`')
    const options = lines.find((l) => l.startsWith('| `options` |'))!
    expect(options).toContain('type?=call\\|put\\|both')
    expect(options).toContain('+ transform')
  })
})
