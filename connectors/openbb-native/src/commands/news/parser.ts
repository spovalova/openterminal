// RSS feed and article body helpers. Ported from openbb_news/parser.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// the HTML tree is the lxml emulation the SEC markdown port has (sec/markdown/lxml-parser.ts) with its whitespace-only
// text kept as lxml keeps it, XPath queries are tree walks, the session is ctx.http, and an XPath over the site rules
// is a predicate.
import { split, strip } from '../../sec/markdown/py.js'
import { parseLxml } from '../../sec/markdown/lxml-parser.js'
import { BeautifulSoup, NavigableString, Tag, type PageElement, type StringKind } from '../../sec/markdown/soup.js'
import type { NativeCtx } from '../../types.js'
import { parseFeed, type ParsedFeed } from './feedparser.js'
import { FeedParserDict } from './feeddict.js'
import { htmlTextParts } from './pyhtml.js'
import type { StructTime } from './pydates.js'

const FEED_TIMEOUT_MS = 8_000
const ARTICLE_TIMEOUT_MS = 6_000
const CHROME_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'svg'])
const TEMPLATE_MARKERS = ['[[', '{{']
const MIN_PARAGRAPHS = 2
const TIMESTAMP = /^\p{Nd}{1,2}:\p{Nd}{2}(?::\p{Nd}{2})?$/u

const WEBKIT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
const FEED_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,application/atom+xml,*/*;q=0.8'
/** What aiohttp's session sends when a request names no headers of its own. */
const SESSION_HEADERS: Record<string, string> = { accept: '*/*', 'user-agent': 'Python/3.12 aiohttp/3.14.5' }

/** Browser-like headers the shared session can decode (`_pinned`). */
function pinned(userAgent?: string): Record<string, string> {
  return { Accept: FEED_ACCEPT, 'Accept-Encoding': 'gzip, deflate', ...(userAgent ? { 'User-Agent': userAgent } : {}) }
}

// Hosts whose rotating-UA / JSON-Accept defaults get 403/406/202 or br-encoded.
const HOST_HEADERS: Record<string, Record<string, string>> = {
  'drugs.com': pinned(WEBKIT_UA),
  'espn.com': pinned(SAFARI_UA),
  'heavy.com': pinned(SAFARI_UA),
  'bleepingcomputer.com': pinned(SAFARI_UA),
  'pbs.org': pinned(SAFARI_UA),
  'techmeme.com': pinned(),
}

/** The hostname of a URL without a `www.` prefix (`_host`). */
function host(url: string | undefined): string {
  if (!url) return ''
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname
}

/** Headers for a request to a URL: the session's, then the host's own. */
function headersFor(url: string): Record<string, string> {
  const own = Object.hasOwn(HOST_HEADERS, host(url)) ? HOST_HEADERS[host(url)]! : {}
  // Request headers override same-named session headers whatever their case.
  const merged: Record<string, string> = { ...SESSION_HEADERS }
  for (const [name, value] of Object.entries(own)) merged[name.toLowerCase()] = value
  return merged
}

// ---- text ----

/** Strip HTML tags and collapse whitespace. */
export function stripHtml(text: string): string {
  if (!text) return ''
  return split(htmlTextParts(text)).join(' ')
}

/** Truncate at the nearest word boundary within `limit` characters. */
export function truncate(text: string, limit = 280): string {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  const head = chars.slice(0, limit).join('')
  const at = head.lastIndexOf(' ')
  const cut = at >= 0 ? head.slice(0, at) : head
  return `${cut.replace(/[,.;:]+$/, '')}…`
}

/** A feedparser struct_time as ISO 8601 (UTC); the current time where the feed gave none. */
export function structTimeToIso(t: StructTime | null | undefined, now: Date): string {
  if (!t) {
    // `datetime.now(timezone.utc).isoformat()`: microseconds only when there are some.
    const [base, ms] = now.toISOString().slice(0, -1).split('.') as [string, string]
    return `${base}${ms === '000' ? '' : `.${ms}000`}+00:00`
  }
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(t[0]!, 4)}-${pad(t[1]!)}-${pad(t[2]!)}T${pad(t[3]!)}:${pad(t[4]!)}:${pad(t[5]!)}+00:00`
}

// ---- HTML trees (lxml) ----

const BLANK = new NavigableString('')

/**
 * The lxml tree of some HTML. The Beautiful Soup emulation the SEC port has collapses a run of whitespace-only text to
 * one space or newline, as bs4 does; lxml keeps it, and the number of newlines shows in the markdown, so the collapse
 * is switched off for the length of the parse (the parse is synchronous, so nothing else sees the change).
 */
function parseRaw(markup: string): BeautifulSoup {
  const proto = BeautifulSoup.prototype as unknown as { endData(kind?: StringKind): void; preserveWhitespaceTagStack: unknown[] }
  const original = proto.endData
  proto.endData = function (this: typeof proto, kind?: StringKind): void {
    this.preserveWhitespaceTagStack.push(BLANK)
    try {
      original.call(this, kind)
    } finally {
      this.preserveWhitespaceTagStack.pop()
    }
  }
  try {
    return parseLxml(markup)
  } finally {
    proto.endData = original
  }
}

const TEXT_KINDS = new Set<StringKind>(['text', 'script', 'style', 'template', 'rt', 'rp'])

/** `el.text_content()`: every text node under the element, comments and processing instructions left out. */
function textContent(el: Tag): string {
  let out = ''
  for (const d of el.descendants()) if (d instanceof NavigableString && TEXT_KINDS.has(d.kind)) out += d.text
  return out
}

function* tagsOf(root: Tag): Generator<Tag> {
  for (const d of root.descendants()) if (d instanceof Tag) yield d
}

/** Elements by name, in document order (`//name`). */
function elementsNamed(root: Tag, name: string): Tag[] {
  return [...tagsOf(root)].filter((t) => t.name === name)
}

const attr = (el: Tag, name: string): string | undefined => {
  const v = el.get(name)
  return v === undefined ? undefined : Array.isArray(v) ? v.join(' ') : v
}

/** `"".join(el.xpath(".//text()"))`-style joins use these: the text nodes under an element. */
function textNodes(el: Tag): string[] {
  const out: string[] = []
  for (const d of el.descendants()) if (d instanceof NavigableString && TEXT_KINDS.has(d.kind)) out.push(d.text)
  return out
}

/** `has an ancestor named …`. */
function hasAncestor(el: Tag, name: string): boolean {
  for (let p = el.parent; p; p = p.parent) if (p.name === name) return true
  return false
}

// ---- HTML fragments to markdown ----

const FULL_HTML = /^\s*<(?:html|!doctype)/i

/** Render an HTML fragment as markdown, preserving anchors and images. */
export function htmlToMarkdown(fragment: string): string {
  if (!fragment) return ''

  let nodes: PageElement[]
  try {
    const doc = parseRaw(FULL_HTML.test(fragment) ? fragment : `<html><body>${fragment}</body></html>`)
    const html = doc.contents.find((c): c is Tag => c instanceof Tag)
    if (!html || html.name !== 'html') throw new Error('not html')
    const bodies = html.contents.filter((c): c is Tag => c instanceof Tag && c.name === 'body')
    if (bodies.length !== 1) throw new Error('one body expected')
    nodes = [...bodies[0]!.contents]
    // The body's leading text is the new root's text when it says something; blank leading text is dropped.
    const first = nodes[0]
    if (first instanceof NavigableString && TEXT_KINDS.has(first.kind)) {
      if (!strip(first.text)) nodes = nodes.slice(1)
    }
  } catch {
    return stripHtml(fragment)
  }

  const parts: string[] = []
  const emit = (list: readonly PageElement[]): void => {
    for (const node of list) {
      if (node instanceof NavigableString) {
        // A comment element's text is emitted like any other; a processing instruction's is not kept.
        if (TEXT_KINDS.has(node.kind) || node.kind === 'comment') parts.push(node.text)
        continue
      }
      if (!(node instanceof Tag)) continue
      const tag = node.name
      if (tag === 'a') {
        const href = strip(attr(node, 'href') ?? '')
        const inner = split(textContent(node)).join(' ')
        if (inner && href) parts.push(`[${inner}](${href})`)
        else if (inner) parts.push(inner)
        parts.push(' ')
        continue
      }
      if (tag === 'img') {
        const src = strip(attr(node, 'src') ?? '')
        const alt = strip(attr(node, 'alt') ?? '')
        if (src) parts.push(`![${alt}](${src})`)
        continue
      }
      if (tag === 'br') parts.push('\n')
      else if (tag === 'p' && parts.length > 0 && !parts.at(-1)!.endsWith('\n')) parts.push('\n\n')
      emit(node.contents)
      if (tag === 'p') parts.push('\n\n')
    }
  }
  emit(nodes)
  const lines = parts.join('').split('\n').map((line) => split(line).join(' '))
  return strip(lines.join('\n'))
}

// ---- article bodies ----

type SiteRule = {
  /** Does this `div` hold the article? */
  container: (el: Tag) => boolean
  /** Does this child end the article? */
  cut: (el: Tag) => boolean
  /** Substrings marking a hero image as a site placeholder rather than art. */
  heroSkip: string[]
}

const normalizeSpace = (text: string): string => text.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '')

// Drugs.com has no <article> and its <main> holds the sidebar, so //main swallows related teasers, newsletter pitches
// and vendor copyright.
const SITE_RULES: Record<string, SiteRule> = {
  'drugs.com': {
    container: (el) => el.name === 'div' && (attr(el, 'class') ?? '').includes('ddc-main-content'),
    cut: (el) =>
      (attr(el, 'class') ?? '').includes('ddc-disclaimer') ||
      (attr(el, 'class') ?? '').includes('more-resources') ||
      (el.name === 'h2' && normalizeSpace(textContent(el)) === 'More news resources') ||
      (el.name === 'h2' && normalizeSpace(textContent(el)) === 'Subscribe to our newsletter'),
    heroSkip: ['ddc-opengraph-logomark'],
  },
}

/** Remove the chrome tags in place (and the text that follows each, which lxml takes with the element). */
function stripChrome(doc: Tag): void {
  for (const el of [...tagsOf(doc)]) {
    if (!CHROME_TAGS.has(el.name) || !el.parent) continue
    removeWithTail(el)
  }
}

/** `parent.remove(el)`: the element goes, and so does the text that follows it. */
function removeWithTail(el: Tag): void {
  const parent = el.parent
  if (!parent) return
  const at = parent.contents.indexOf(el)
  const next = parent.contents[at + 1]
  if (next instanceof NavigableString && TEXT_KINDS.has(next.kind)) next.extract()
  el.extract()
}

/** Reject empty results and unrendered template fragments. */
const looksClean = (text: string): boolean => text.length > 0 && !TEMPLATE_MARKERS.some((marker) => text.includes(marker))

const codePoints = (s: string): number => Array.from(s).length

const asString = (v: unknown): string | undefined => (typeof v === 'string' && strip(v) ? strip(v) : undefined)

/** A top-level string field from any JSON-LD script. */
function jsonldField(doc: Tag, field: string): string | undefined {
  for (const script of elementsNamed(doc, 'script')) {
    if (attr(script, 'type') !== 'application/ld+json') continue
    // Each text node of the script is read on its own.
    for (const source of script.contents.filter((c): c is NavigableString => c instanceof NavigableString)) {
      let data: unknown
      try {
        data = JSON.parse(source.text)
      } catch {
        continue
      }
      for (const entry of Array.isArray(data) ? data : [data]) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const graph = (entry as Record<string, unknown>)['@graph']
        for (const candidate of [entry, ...(Array.isArray(graph) ? graph : [])]) {
          if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
          const value = (candidate as Record<string, unknown>)[field]
          const text = asString(value)
          if (text) return text
          if (Array.isArray(value) && value.length > 0) {
            const first = value[0]
            const firstText = asString(first)
            if (firstText) return firstText
            if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
              const nested = asString((first as Record<string, unknown>).url)
              if (nested) return nested
            }
          }
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const nested = asString((value as Record<string, unknown>).url)
            if (nested) return nested
          }
        }
      }
    }
  }
  return undefined
}

/** Render an article container as markdown with text and inline images. */
function articleMarkdown(node: Tag): string {
  const parts: string[] = []
  let textCount = 0
  const walk = (el: Tag): void => {
    const tag = el.name
    if (tag === 'p') {
      const text = split(textContent(el)).join(' ')
      if (text && !TIMESTAMP.test(text)) {
        parts.push(text)
        textCount += 1
      }
      return
    }
    if (tag === 'figure') {
      const srcs = elementsNamed(el, 'img').filter((img) => img.has('src')).map((img) => attr(img, 'src')!)
      if (srcs.length > 0) {
        const src = strip(srcs[0]!)
        const caps = elementsNamed(el, 'figcaption').flatMap(textNodes)
        const cap = caps.length > 0 ? split(caps.join('')).join(' ') : ''
        if (src) parts.push(`![${cap}](${src})`)
      }
      return
    }
    if (tag === 'img') {
      const src = strip(attr(el, 'src') ?? '')
      const alt = strip(attr(el, 'alt') ?? '')
      if (src) parts.push(`![${alt}](${src})`)
      return
    }
    for (const child of el.contents) if (child instanceof Tag) walk(child)
  }
  walk(node)
  return textCount < MIN_PARAGRAPHS ? '' : parts.join('\n\n')
}

/** Drop the first child matching the rule's tests and every element after it. */
function cutTail(container: Tag, cut: (el: Tag) => boolean): void {
  let cutting = false
  for (const child of [...container.contents]) {
    if (!(child instanceof Tag)) continue
    if (!cutting && cut(child)) cutting = true
    if (cutting) removeWithTail(child)
  }
}

/** The article container a site rule defines, as markdown. */
function siteBody(doc: Tag, rule: SiteRule): string {
  let best = ''
  for (const container of [...tagsOf(doc)].filter(rule.container)) {
    cutTail(container, rule.cut)
    const text = articleMarkdown(container)
    if (looksClean(text) && codePoints(text) > codePoints(best)) best = text
  }
  return best
}

/** A hero image URL from meta tags, JSON-LD, or the article body. */
function imageFromDoc(doc: Tag): string | undefined {
  const metas = elementsNamed(doc, 'meta')
  for (const [key, value] of [['property', 'og:image'], ['name', 'og:image'], ['name', 'twitter:image'], ['property', 'twitter:image']] as const) {
    for (const meta of metas) {
      if (attr(meta, key) !== value) continue
      const url = strip(attr(meta, 'content') ?? '')
      if (attr(meta, 'content') !== undefined && url) return url
    }
  }
  const jsonld = jsonldField(doc, 'image')
  if (jsonld) return jsonld
  for (const container of ['article', 'main']) {
    for (const img of elementsNamed(doc, 'img')) {
      if (!hasAncestor(img, container) || !img.has('src')) continue
      const url = strip(attr(img, 'src')!)
      if (url) return url
    }
  }
  return undefined
}

/** The article body as markdown with inline images. */
export function extractBody(payload: Uint8Array, url?: string): string | null {
  let doc: BeautifulSoup
  try {
    doc = parseRaw(new TextDecoder('utf-8').decode(payload))
  } catch {
    return null
  }
  const rule = Object.hasOwn(SITE_RULES, host(url)) ? SITE_RULES[host(url)] : undefined

  let hero = imageFromDoc(doc)
  if (hero && rule && rule.heroSkip.some((marker) => hero!.includes(marker))) hero = undefined

  let body: string | undefined = jsonldField(doc, 'articleBody')
  if (!(body && looksClean(body))) {
    stripChrome(doc)
    let best = rule ? siteBody(doc, rule) : ''
    if (!best) {
      for (const article of elementsNamed(doc, 'article')) {
        const text = articleMarkdown(article)
        if (looksClean(text) && codePoints(text) > codePoints(best)) best = text
      }
    }
    if (!best) {
      for (const main of elementsNamed(doc, 'main')) {
        const text = articleMarkdown(main)
        if (looksClean(text) && codePoints(text) > codePoints(best)) best = text
      }
    }
    body = best || undefined
  }

  if (body && hero && !body.includes('![')) body = `![](${hero})\n\n${body}`
  return body ?? null
}

// ---- fetching ----

const emptyFeed = (): ParsedFeed => ({ feed: new FeedParserDict(), entries: [], bozo: false })

/** Fetch and parse an RSS or Atom feed; an unreachable or failing one is an empty feed. */
export async function fetchFeed(ctx: NativeCtx, url: string): Promise<ParsedFeed> {
  let payload: Uint8Array
  try {
    const res = await ctx.http.response(url, { headers: headersFor(url), timeoutMs: FEED_TIMEOUT_MS })
    if (res.status >= 400) return emptyFeed()
    payload = new Uint8Array(await res.arrayBuffer())
  } catch {
    if (ctx.signal?.aborted) throw new Error('aborted')
    return emptyFeed()
  }
  return parseFeed(payload, ctx.now())
}

/** Fetch an article and return its body; null where the page cannot be had or holds none. */
export async function fetchArticleBody(ctx: NativeCtx, url: string): Promise<string | null> {
  let payload: Uint8Array
  try {
    const res = await ctx.http.response(url, { headers: headersFor(url), timeoutMs: ARTICLE_TIMEOUT_MS })
    if (res.status >= 400) return null
    payload = new Uint8Array(await res.arrayBuffer())
  } catch {
    if (ctx.signal?.aborted) throw new Error('aborted')
    return null
  }
  return extractBody(payload, url)
}
