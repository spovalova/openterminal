/// <reference types="node" />
/**
 * The landing page (site/, see site/README.md) is static files with no build step, so nothing else catches a broken
 * reference. These checks keep it whole: every local file the page and its stylesheet name exists, nothing loads from
 * another origin, the example prompts on the page are the ones recorded in site/prompts.json (the exact text that was
 * run, with its screenshot and verification), and the directory stays small. Colours are checked by pure-hue.test.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const site = join(dirname(fileURLToPath(import.meta.url)), '../../../site')
const html = readFileSync(join(site, 'index.html'), 'utf8')
const css = readFileSync(join(site, 'styles.css'), 'utf8')

type Prompt = { id: string; title: string; tag: string; prompt: string; image: string; widgets: number; steps: number; seconds: number; verified: [number, number] }
const data = JSON.parse(readFileSync(join(site, 'prompts.json'), 'utf8')) as { prompts: Prompt[] }

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const attrs = (name: string) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => decode(m[1]!))
const cssUrls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!)
const isLocal = (ref: string) => !/^([a-z]+:|\/\/|#|data:)/i.test(ref)

describe('the landing page', () => {
  it('names only files that exist in site/', () => {
    const refs = [...attrs('src'), ...attrs('href'), ...cssUrls].filter(isLocal)
    expect(refs.length).toBeGreaterThan(10)
    expect(refs.filter((ref) => !existsSync(join(site, ref.split(/[?#]/)[0]!)))).toEqual([])
  })

  it('loads nothing from another origin: scripts, styles, images and fonts are all local', () => {
    const loaded = [...attrs('src'), ...cssUrls, ...[...html.matchAll(/<link\b[^>]*>/g)].map((m) => /href="([^"]*)"/.exec(m[0])?.[1] ?? '')]
    expect(loaded.filter((ref) => !isLocal(ref) && !ref.startsWith('#'))).toEqual([])
  })

  it('links to the project repository and nowhere unexpected on GitHub', () => {
    const github = attrs('href').filter((h) => h.includes('github.com'))
    expect(github.length).toBeGreaterThan(3)
    expect(github.filter((h) => !h.startsWith('https://github.com/spovalova/openterminal'))).toEqual([])
    // Every in-page anchor has a target.
    const ids = new Set(attrs('id'))
    expect(attrs('href').filter((h) => h.startsWith('#') && h.length > 1 && !ids.has(h.slice(1)))).toEqual([])
  })

  it('shows exactly the prompts recorded in prompts.json, in order, each with its screenshot and verification', () => {
    const a = html.indexOf('<!-- prompts:start')
    const b = html.indexOf('<!-- prompts:end -->')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    const block = html.slice(a, b)
    const shown = [...block.matchAll(/<q id="prompt-([^"]+)">([^<]*)<\/q>/g)].map((m) => ({ id: m[1], prompt: decode(m[2]!) }))
    expect(shown).toEqual(data.prompts.map((p) => ({ id: p.id, prompt: p.prompt })))
    expect(data.prompts.length).toBeGreaterThanOrEqual(4)
    expect(data.prompts.length).toBeLessThanOrEqual(6)
    for (const p of data.prompts) {
      expect(p.verified[0], `${p.id}: every figure verified`).toBe(p.verified[1])
      expect(existsSync(join(site, p.image)), p.image).toBe(true)
      expect(block).toContain(`id="tab-${p.id}" aria-controls="panel-${p.id}"`)
      expect(block).toContain(`>${p.title}<span class="tag">${p.tag}</span></button>`)
      expect(block).toContain(`<img src="${p.image}"`)
      expect(block).toContain(`${p.verified[0]} of ${p.verified[1]} figures verified</span> · ${p.widgets} widgets · ${p.steps} steps · ${p.seconds} s`)
    }
  })

  it('stays under 3 MB', () => {
    let total = 0
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else total += statSync(p).size
      }
    }
    walk(site)
    expect(total).toBeLessThan(3 * 1024 * 1024)
  })
})
