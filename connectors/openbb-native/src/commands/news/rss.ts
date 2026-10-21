// news/rss: a registered RSS or Atom feed as articles. The feed is read the way feedparser reads it (feedparser.ts),
// the article pages the way OpenBB's parser does (parser.ts).
import { flag, text, whole } from '../../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { strip } from '../../sec/markdown/py.js'
import type { FeedParserDict } from './feeddict.js'
import { fetchArticleBody, fetchFeed, htmlToMarkdown, stripHtml, structTimeToIso, truncate } from './parser.js'
import { defaultFeedFor, getFeedUrl } from './registry.js'

/** A struct_time compared as Python compares tuples: field by field. */
function compareTimes(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0]
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const timeOf = (entry: FeedParserDict): number[] => (entry.get('published_parsed') || entry.get('updated_parsed') || Array(9).fill(0)) as number[]

// news/rss (command, no provider). Ported from openbb_news/rss.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of NewsItemData, ctx.http for the session, and a feed that cannot be read is an empty one as it is there.
export async function rss(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const outlet = text(params, 'outlet')
  const limit = whole(params, 'limit') ?? 20
  const fetchBody = flag(params, 'fetch_body', true)
  if (limit < 1) throw new Error('Input should be greater than or equal to 1')

  let source = text(params, 'source')
  if (!source) {
    source = defaultFeedFor(outlet)
    if (!source) return []
  }
  const url = getFeedUrl(source)

  const parsed = await fetchFeed(ctx, url)
  const feedTitle = (parsed.feed.size > 0 ? (parsed.feed.get('title') as string | undefined) : '') || ''
  // Newest first; entries without a date go last, and equal times keep the feed's order.
  const entries = [...parsed.entries].sort((a, b) => compareTimes(timeOf(b), timeOf(a))).slice(0, limit)

  // Fetch the article bodies concurrently; one that cannot be had is no body.
  const bodies: (string | null)[] =
    fetchBody && entries.length > 0
      ? await Promise.all(
          entries.map(async (entry) => {
            const link = entry.get('link') as string | undefined
            if (!link) return null
            try {
              return await fetchArticleBody(ctx, link)
            } catch {
              return null
            }
          }),
        )
      : entries.map(() => null)

  return entries.map((entry, i) => {
    const summaryHtml = (entry.get('summary') || entry.get('description') || '') as string
    const excerpt = truncate(stripHtml(summaryHtml))
    const url = strip((entry.get('link') || '') as string)
    let body = bodies[i]
    if (!body) {
      // No full body: some sources paywall or block article pages. Fall back to the summary and link out.
      body = htmlToMarkdown(summaryHtml) || excerpt
      if (url) body = `${body}\n\n[Read the full story at the source ↗](${url})`
    }
    return {
      title: strip((entry.get('title') || '(untitled)') as string),
      date: structTimeToIso((entry.get('published_parsed') || entry.get('updated_parsed')) as number[] | null, ctx.now()),
      author: entry.get('author') || feedTitle || 'Unknown',
      url,
      excerpt,
      body,
    }
  })
}
