// usda/report_calendar, provider usda. Ported from openbb_government_us/usda/models/report_calendar.py
// and utils/fas_report_calendar.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models,
// plain HTTPS with browser headers instead of a curl_cffi Chrome session (www.fas.usda.gov answers it).
import { BROWSER_UA } from '../http.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { optString, sortedBy } from './helpers.js'

const BASE_URL = 'https://www.fas.usda.gov'
const CALENDAR_URL = `${BASE_URL}/data/scheduled-reports`

const REPORT_TYPES: Record<string, string> = { export_sales: '10254', trade_forecast: '10257', world_markets_trade: '10259' }
const COMMODITIES: Record<string, string> = {
  coffee: '609',
  cotton_and_hemp: '13040',
  cotton: '6',
  dairy_livestock_and_poultry: '13005',
  beef: '13008',
  dairy_products: '13012',
  pork: '13009',
  poultry: '13010',
  fruits_and_vegetables: '8',
  fresh_fruit: '13013',
  grains_feeds_and_fodders: '13',
  corn: '14',
  rice: '16',
  wheat: '15',
  oilseeds: '26',
  oilseeds_excluding_soybean: '28',
  soybeans: '27',
  processed_food_products: '31',
  tree_nuts: '30',
}

const ROW_PATTERN = /<div\s+class="c-view__row">([\s\S]*?)(?=<div\s+class="c-view__row">|$)/g
const MONTH_DAY_PATTERN = /class="fas-date__month-day">([^<]+)</
const DOW_PATTERN = /class="fas-date__dow">([^<]+)</
const TIME_PATTERN = /class="fas-date__time">([^<]+)</
const TAG_PATTERN = /class="c-card__tags">\s*<span>([^<]+)<\/span>/
const TITLE_PATTERN = /class="c-card__title">([^<]+)</
const URL_PATTERN = /href="([^"]+)"\s+class="c-card__url"/
const DTSTART_PATTERN = /DTSTART:(\d{8}T\d{6}Z)/

/** The calendar URL with the facet filters, written the way FAS's own links are (brackets and colons unescaped). */
function buildUrl(reportType: string | undefined, commodity: string | undefined, keyword: string | undefined): string {
  const params: string[] = []
  let index = 0
  if (reportType !== undefined) {
    params.push(`report_releases[${index}]=report_type:${REPORT_TYPES[reportType]}`)
    index += 1
  }
  if (commodity !== undefined) params.push(`report_releases[${index}]=report_listing_commodities:${COMMODITIES[commodity]}`)
  if (keyword !== undefined) params.push(`keyword=${keyword}`)
  return params.length ? `${CALENDAR_URL}?${params.join('&')}` : CALENDAR_URL
}

const search = (pattern: RegExp, text: string): string | null => pattern.exec(text)?.[1]?.trim() ?? null

/** `urllib.parse.unquote`: percent escapes decoded as UTF-8, bad bytes replaced. */
function unquote(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%').map((h) => parseInt(h, 16)))))
}

type Release = { releaseDatetime: string | null; monthDay: string | null; dayOfWeek: string | null; releaseTime: string | null; reportType: string | null; title: string; url: string | null; released: boolean }

function parseCalendar(html: string): Release[] {
  const out: Release[] = []
  for (const match of html.matchAll(ROW_PATTERN)) {
    const row = match[1]!
    const title = search(TITLE_PATTERN, row)
    if (title === null) continue
    const url = search(URL_PATTERN, row)
    const dtstart = search(DTSTART_PATTERN, unquote(row))
    out.push({
      // 20261022T123000Z → 2026-10-22T12:30:00Z
      releaseDatetime: dtstart ? `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}T${dtstart.slice(9, 11)}:${dtstart.slice(11, 13)}:${dtstart.slice(13, 15)}Z` : null,
      monthDay: search(MONTH_DAY_PATTERN, row),
      dayOfWeek: search(DOW_PATTERN, row),
      releaseTime: search(TIME_PATTERN, row),
      reportType: search(TAG_PATTERN, row),
      title,
      url: url ? `${BASE_URL}${url}` : null,
      released: dtstart === null,
    })
  }
  return out
}

const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

export async function reportCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const reportType = optString(params, 'report_type')
  const commodity = optString(params, 'commodity')
  const keyword = optString(params, 'keyword')
  const startDate = optString(params, 'start_date')
  const endDate = optString(params, 'end_date')

  const url = buildUrl(reportType, commodity, keyword)
  const res = await ctx.http.response(url, { headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' } })
  if (res.status !== 200) throw new Error(`FAS request failed with status ${res.status} -> ${url}`)
  const releases = parseCalendar(await res.text())

  const results: { releaseDate: string; row: Row; title: string }[] = []
  for (const r of releases) {
    let releaseDate: string
    if (r.releaseDatetime !== null) releaseDate = easternDate.format(new Date(r.releaseDatetime))
    else if (r.monthDay) releaseDate = easternDate.format(ctx.now())
    else throw new Error('The release carries neither a timestamp nor a date.')
    if (startDate && releaseDate < startDate) continue
    if (endDate && releaseDate > endDate) continue
    results.push({
      releaseDate,
      title: r.title,
      row: { release_date: releaseDate, release_time: r.releaseTime, day_of_week: r.dayOfWeek, release_datetime: r.releaseDatetime, report_type: r.reportType, title: r.title, url: r.url, released: r.released },
    })
  }
  if (results.length === 0) throw new Error('The request was returned empty.')
  return sortedBy(results, (x) => [x.releaseDate, x.title]).map((x) => x.row)
}
