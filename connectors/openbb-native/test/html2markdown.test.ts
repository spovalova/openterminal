// The sec markdown part: the Beautiful Soup emulation (html.parser and lxml modes) and html_to_markdown. The expected
// strings in html2markdown.golden.json come from running Python's bs4 4.15 / lxml 6.1 and OpenBB's
// openbb_sec.utils.html2markdown on the same inputs.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../src/sec/markdown/html2markdown.js'
import { Comment, parse } from '../src/sec/markdown/soup.js'

type Golden = { snips: string[]; htmlParser: string[]; lxml: string[]; markdown: { html: string; markdown: string }[] }
const golden = JSON.parse(readFileSync(new URL('./html2markdown.golden.json', import.meta.url), 'utf8')) as Golden

describe('soup: html.parser mode', () => {
  golden.snips.forEach((snip, i) => {
    it(`snippet ${i}: ${JSON.stringify(snip).slice(0, 50)}`, () => {
      expect(parse(snip, 'html.parser').toString()).toBe(golden.htmlParser[i])
    })
  })
})

describe('soup: lxml mode', () => {
  golden.snips.forEach((snip, i) => {
    it(`snippet ${i}: ${JSON.stringify(snip).slice(0, 50)}`, () => {
      expect(parse(snip, 'lxml').toString()).toBe(golden.lxml[i])
    })
  })
})

describe('soup: the bs4 API', () => {
  it('finds, reads text, replaces and decomposes', () => {
    const soup = parse('<div class="a b"><p id="x">one <b>two</b></p><script>var s</script><!-- c --><p>three</p></div>', 'html.parser')
    const div = soup.find('div')!
    expect(div.get('class')).toEqual(['a', 'b'])
    expect(div.getText()).toBe('one twothree')
    expect(div.getText(' ', true)).toBe('one two three')
    expect(soup.findAll('p').length).toBe(2)
    expect(soup.findAll(null, { class_: 'b' })).toEqual([div])
    expect(soup.findAllStrings({ string: (s) => s instanceof Comment }).length).toBe(1)
    div.find('b')!.replaceWith('2')
    expect(div.find('p')!.toString()).toBe('<p id="x">one 2</p>')
    div.find('script')!.decompose()
    expect(div.find('script')).toBeNull()
    expect(div.copy().toString()).toBe(div.toString())
  })
})

describe('html_to_markdown', () => {
  golden.markdown.forEach((c, i) => {
    it(`document ${i}`, () => {
      expect(htmlToMarkdown(c.html, 'https://www.sec.gov/Archives/edgar/data/1/2/x.htm')).toBe(c.markdown)
    })
  })
})
