// news/rss against OpenBB's own code (openbb_news with feedparser 6 and lxml), run on the same inputs
// (test/fixtures/commands/unit/generate-news.py): what feedparser reads from real and hand-written feeds, the rows the
// router builds from them with article pages served and refused, the article bodies, the text helpers, and the dates
// and links feedparser resolves.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { rss } from '../src/commands/news/rss.js'
import { parseFeed } from '../src/commands/news/feedparser.js'
import { parseDate } from '../src/commands/news/pydates.js'
import { extractBody, htmlToMarkdown, stripHtml, structTimeToIso, truncate } from '../src/commands/news/parser.js'
import { feedUrljoin, makeSafeAbsoluteUri, urljoin } from '../src/commands/news/pyurl.js'
import { defaultFeedFor, getFeedUrl, listFeedChoices } from '../src/commands/news/registry.js'
import type { Row } from '../src/types.js'

const dir = new URL('./fixtures/commands/unit/news/', import.meta.url)
const read = (path: string): Buffer => readFileSync(new URL(path, dir))

type Manifest = { feeds: { name: string; file: string; key: string }[]; cases: { name: string; feed: string; limit: number; fetch_body: boolean }[] }
type Expected = {
  feeds: Record<string, { bozo: boolean; feedTitle: string | null; entries: Record<string, unknown>[] }>
  cases: Record<string, { rows: Row[]; served: Record<string, string | null> }>
  pages: Record<string, { url: string | null; body: string | null }>
  text: { in: string; strip: string; truncate: string; markdown: string }[]
  dates: { in: string; out: number[] | null }[]
  urls: { base: string; rel: string; join: string; safe: string }[]
}
const manifest = JSON.parse(read('manifest.json').toString('utf8')) as Manifest
const expected = JSON.parse(read('expected.json').toString('utf8')) as Expected
const feeds = new Map(manifest.feeds.map((f) => [f.name, f]))

/** The clock the generator fixed. */
const NOW = new Date('2026-10-21T12:00:00.123Z')
const KEYS = ['title', 'link', 'id', 'author', 'summary', 'description', 'published_parsed', 'updated_parsed', 'published', 'updated']

describe('the feeds feedparser reads', () => {
  for (const feed of manifest.feeds) {
    it(`reads ${feed.name} as feedparser does`, () => {
      const parsed = parseFeed(new Uint8Array(read(feed.file)), NOW)
      const want = expected.feeds[feed.name]!
      expect(parsed.bozo).toBe(want.bozo)
      expect(parsed.feed.get('title') ?? null).toBe(want.feedTitle)
      expect(parsed.entries.map((e) => Object.fromEntries(KEYS.map((k) => [k, e.get(k) ?? null])))).toEqual(want.entries)
    })
  }
})

describe('news/rss', () => {
  for (const c of manifest.cases) {
    it(`answers ${c.name} as OpenBB does`, async () => {
      const f = feeds.get(c.feed)!
      const want = expected.cases[c.name]!
      const routes = new Map<string, { status: number; body: Uint8Array }>([[getFeedUrl(f.key), { status: 200, body: new Uint8Array(read(f.file)) }]])
      const asked: string[] = []
      for (const [link, page] of Object.entries(want.served)) routes.set(link, page ? { status: 200, body: new Uint8Array(read(`pages/${page}`)) } : { status: 404, body: new Uint8Array() })
      const fetchImpl: typeof fetch = async (input) => {
        asked.push(String(input))
        const route = routes.get(String(input))
        if (!route) throw new TypeError('no route')
        return new Response(route.body, { status: route.status })
      }
      const rows = await rss({ source: f.key, limit: c.limit, fetch_body: c.fetch_body }, createNativeCtx({ fetch: fetchImpl, now: () => NOW, cache: new Map() }))
      expect(rows).toEqual(want.rows)
      // The feed first, then (when bodies are asked for) one request per article link of the rows.
      expect(asked[0]).toBe(getFeedUrl(f.key))
      if (!c.fetch_body) expect(asked).toHaveLength(1)
    })
  }

  it('picks the default feed of an outlet, and nothing for an outlet or source it has none for', async () => {
    const asked: string[] = []
    const ctx = createNativeCtx({ fetch: async (input) => (asked.push(String(input)), new Response('', { status: 404 })), now: () => NOW, cache: new Map() })
    expect(await rss({ outlet: 'bbc', limit: 3, fetch_body: false }, ctx)).toEqual([])
    expect(asked).toEqual(['http://feeds.bbci.co.uk/news/world/rss.xml'])
    expect(defaultFeedFor('bbc')).toBe('bbc_world')
    expect(defaultFeedFor('pr_newswire')).toBe('pr_newswire_global')
    expect(defaultFeedFor('drudge_report')).toBe('drudge_report')
    expect(defaultFeedFor('nope')).toBeUndefined()
    asked.length = 0
    expect(await rss({ limit: 3, fetch_body: false }, ctx)).toEqual([])
    expect(await rss({ outlet: 'nope', limit: 3, fetch_body: false }, ctx)).toEqual([])
    expect(asked).toEqual([])
  })

  it('refuses a source it does not know, and a limit below one', async () => {
    const ctx = createNativeCtx({ fetch: async () => new Response(''), now: () => NOW, cache: new Map() })
    await expect(rss({ source: 'nope', limit: 3 }, ctx)).rejects.toThrow(/^Unknown RSS feed source 'nope'\. Known sources: axios_main, .+\.$/)
    await expect(rss({ source: 'bbc_world', limit: 0 }, ctx)).rejects.toThrow(/greater than or equal to 1/)
  })

  it('lists the feeds of an outlet by label', () => {
    expect(listFeedChoices('bbc').map((c) => c.value)).toContain('bbc_world')
    expect(listFeedChoices(undefined)).toEqual([])
    const labels = listFeedChoices('cbc').map((c) => c.label)
    expect(labels).toEqual([...labels].sort())
  })

  it('treats a feed that cannot be reached as an empty one', async () => {
    for (const fetchImpl of [async () => new Response('', { status: 503 }), async () => Promise.reject(new TypeError('offline')), async () => new Response('<html>not a feed</html>')] as (typeof fetch)[]) {
      expect(await rss({ source: 'bbc_world', limit: 3, fetch_body: false }, createNativeCtx({ fetch: fetchImpl, now: () => NOW, cache: new Map() }))).toEqual([])
    }
  })

  it('sends the headers of the Python session, and a host\'s own for the hosts that need them', async () => {
    const seen = new Map<string, Headers>()
    const fetchImpl: typeof fetch = async (input, init) => (seen.set(String(input), new Headers(init?.headers)), new Response('', { status: 404 }))
    const ctx = createNativeCtx({ fetch: fetchImpl, now: () => NOW, cache: new Map() })
    await rss({ source: 'bbc_world', limit: 1, fetch_body: false }, ctx)
    await rss({ source: 'drugs_com_medical_news', limit: 1, fetch_body: false }, ctx)
    const plain = seen.get(getFeedUrl('bbc_world'))!
    expect(plain.get('user-agent')).toMatch(/^Python\/3\.12 aiohttp\//)
    expect(plain.get('accept')).toBe('*/*')
    const drugs = seen.get(getFeedUrl('drugs_com_medical_news'))!
    expect(drugs.get('user-agent')).toMatch(/Chrome\/131/)
    expect(drugs.get('accept-encoding')).toBe('gzip, deflate')
    expect(drugs.get('accept')).toMatch(/application\/rss\+xml/)
  })

  it('dates an article without a date with the clock', () => {
    expect(structTimeToIso(null, NOW)).toBe('2026-10-21T12:00:00.123000+00:00')
    expect(structTimeToIso(null, new Date('2026-10-21T12:00:00.000Z'))).toBe('2026-10-21T12:00:00+00:00')
    expect(structTimeToIso([2026, 1, 2, 3, 4, 5, 0, 0, 0], NOW)).toBe('2026-01-02T03:04:05+00:00')
  })
})

describe('article bodies', () => {
  for (const [page, want] of Object.entries(expected.pages)) {
    it(`extracts ${page} as OpenBB does`, () => {
      const file = page.replace(/@.*$/, '')
      expect(extractBody(new Uint8Array(read(`pages/${file}`)), want.url ?? undefined)).toBe(want.body)
    })
  }
})

describe('the text helpers', () => {
  it('strip, truncate and render markdown as OpenBB does', () => {
    const mismatches: string[] = []
    for (const t of expected.text) {
      const stripped = stripHtml(t.in)
      if (stripped !== t.strip || truncate(stripped) !== t.truncate || htmlToMarkdown(t.in) !== t.markdown) mismatches.push(t.in.slice(0, 60))
    }
    expect(expected.text.length).toBeGreaterThan(250)
    expect(mismatches).toEqual([])
  })

  it('cuts at a word boundary and keeps a short text whole', () => {
    expect(truncate('short')).toBe('short')
    expect(truncate(`${'word '.repeat(70)}tail`)).toMatch(/^(word ){55}word…$/)
    expect(truncate('x'.repeat(300))).toBe(`${'x'.repeat(280)}…`)
  })
})

describe('what feedparser resolves', () => {
  it('reads dates as feedparser does', () => {
    const mismatches = expected.dates.filter((d) => JSON.stringify(parseDate(d.in, NOW)) !== JSON.stringify(d.out)).map((d) => d.in)
    expect(mismatches).toEqual([])
  })

  it('joins and checks links as feedparser does', () => {
    const mismatches = []
    for (const u of expected.urls) {
      let joined: string
      let safe: string
      try {
        joined = feedUrljoin(u.base, u.rel)
        safe = makeSafeAbsoluteUri(u.base, u.rel)
      } catch {
        joined = safe = '<threw>'
      }
      if (joined !== u.join || safe !== u.safe) mismatches.push([u.base, u.rel, joined, u.join])
    }
    expect(mismatches).toEqual([])
    expect(urljoin('http://a.com/b/c', '../d')).toBe('http://a.com/d')
  })
})
