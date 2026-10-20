// sec/rss_litigation, provider sec. Ported from openbb_sec/models/rss_litigation.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: xmltodict → src/lib/xml.ts, BeautifulSoup → ./soup.ts, plain rows instead of pydantic models.
import { asArray, parseXml } from '../../lib/xml.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { HEADERS, secResponse } from '../helpers.js'
import { htmlToMarkdown } from './html2markdown.js'
import { parse } from './soup.js'
import { strip } from './py.js'

const URL_RSS = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss'

/** `email.utils.parsedate_to_datetime` for the RFC 822 dates the feed uses; the ISO text pydantic would serialise, or null. */
function parseRfc822(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const m = /^\s*(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,4})?\s*$/.exec(value)
  if (!m) return null
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const mon = months.indexOf(m[2]!.toLowerCase()) + 1
  if (mon === 0) return null
  let year = parseInt(m[3]!, 10)
  if (m[3]!.length <= 2) year += year < 70 ? 2000 : 1900
  const pad = (n: number | string, w = 2): string => String(n).padStart(w, '0')
  const base = `${pad(year, 4)}-${pad(mon)}-${pad(m[1]!)}T${pad(m[4]!)}:${m[5]}:${pad(m[6] ?? '00')}`
  const zone = m[7]
  const names: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700 }
  let offset: number | null
  if (zone === undefined) offset = null
  else if (/^[+-]\d{4}$/.test(zone)) offset = zone === '-0000' ? null : parseInt(zone.slice(0, 1) + '1', 10) * (parseInt(zone.slice(1, 3), 10) * 60 + parseInt(zone.slice(3), 10))
  else if (Object.prototype.hasOwnProperty.call(names, zone.toUpperCase())) {
    const n = names[zone.toUpperCase()]!
    offset = Math.sign(n) * (Math.floor(Math.abs(n) / 100) * 60 + (Math.abs(n) % 100))
  } else offset = null
  if (offset === null) return base
  if (offset === 0) return `${base}Z`
  const sign = offset < 0 ? '-' : '+'
  return `${base}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** `_fetch_body`: best-effort fetch and clean of a litigation release's full text. */
async function fetchBody(ctx: NativeCtx, url: string): Promise<string | null> {
  try {
    const res = await secResponse(ctx, url, { headers: HEADERS })
    const text = await res.text()
    if (!text) return null
    const soup = parse(text, 'html.parser')
    for (const tag of soup.findAll(['script', 'style', 'nav', 'header', 'footer', 'form'])) tag.decompose()
    const main = soup.find('article') ?? soup.find(null, { attrs: { id: 'main-content' } }) ?? soup.find('main') ?? soup.body
    if (main === null) return null
    const body = strip(htmlToMarkdown(main.toString(), url))
    return body || null
  } catch {
    return null
  }
}

export async function secRssLitigation(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = params.limit === undefined ? 25 : Number(params.limit)

  const res = await secResponse(ctx, URL_RSS, { headers: HEADERS })
  const content = await res.text()
  if (!content) throw new Error('No data returned from the SEC litigation RSS feed.')

  const cleaned = content.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;')
  const doc = parseXml(cleaned, { removeNSPrefix: false }) as { rss: { channel: { item?: Record<string, unknown> | Record<string, unknown>[] } } }
  const items = asArray(doc.rss.channel.item)

  const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && '#text' in v ? String((v as Record<string, unknown>)['#text']) : '')
  const results: { title: string; date: string | null; author: null; excerpt: string | null; url: string; id: string | null; body?: string | null }[] = []
  for (const item of items.slice(0, limit)) {
    const link = text(item.link)
    let releaseId: string | null = null
    const idMatch = /(lr-?\d+|\d{5,})/i.exec(link)
    if (idMatch) releaseId = idMatch[1]!.toUpperCase()
    results.push({
      title: strip(text(item.title).replace(/\s+/g, ' ')),
      date: parseRfc822(item.pubDate),
      author: null,
      excerpt: strip(text(item.description).replace(/\s+/g, ' ')) || null,
      url: link,
      id: text(item['dc:creator']) || releaseId,
    })
  }

  const withUrl = results.filter((r) => r.url)
  const bodies = await Promise.all(withUrl.map((r) => fetchBody(ctx, r.url)))
  // zip(results, bodies): bodies line up with the results that have a URL.
  const n = Math.min(results.length, bodies.length)
  for (let i = 0; i < n; i++) results[i]!.body = bodies[i] || results[i]!.excerpt

  return results.map((r) => {
    if (!r.date) throw new Error(`rss_litigation: unreadable date for ${r.url}`)
    const row: Row = { title: r.title, date: r.date, url: r.url }
    if (r.excerpt) row.excerpt = r.excerpt
    if (r.body) row.body = r.body
    if (r.id) row.id = r.id
    return row
  })
}
