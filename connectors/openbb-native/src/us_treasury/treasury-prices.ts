// fixedincome/government/treasury_prices, provider us_treasury. Ported from openbb_government_us/treasury/models/treasury_prices.py
// and openbb_core/provider/standard_models/treasury_prices.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of a DataFrame and pydantic models, pandas' read_csv is a small CSV reader with its column inference, and the
// download follows FedInvest's current form flow (a session and CSRF token, then the date, then the CSV), which OpenBB
// 5.0.0's single POST no longer gets past (HTTP 403).
import { NativeHttpError, BROWSER_UA } from '../http.js'
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { validateModel } from './coerce.js'
import { TREASURY_PRICES_FIELDS } from './fields.js'
import { isoDate, nullTokensToNone, optString, parseDate, shiftDays, today } from './helpers.js'

const BASE = 'https://www.treasurydirect.gov/GA-FI/FedInvest/'
const COLUMNS = ['cusip', 'security_type', 'rate', 'maturity_date', 'call_date', 'bid', 'offer', 'eod_price']
const SECURITY_TYPES = ['bill', 'note', 'bond', 'tips', 'frn']

/** pandas' default NaN strings. */
const NA_VALUES = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])

/** The last business day on or before today, by weekday only (no holidays). */
function lastBusinessDay(ctx: NativeCtx): Date {
  const t = today(ctx)
  const weekday = (t.getDay() + 6) % 7 // Monday is 0
  return weekday > 4 ? shiftDays(t, -(weekday - 4)) : t
}

/** `to_datetime(col, format="%m/%d/%Y").strftime("%Y-%m-%d")`; a blank cell stays missing. */
function parseUsDate(text: string | undefined): string | null {
  if (text === undefined || NA_VALUES.has(text)) return null
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim())
  const d = m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : undefined
  if (!m || !d || d.getMonth() !== Number(m[1]) - 1 || d.getDate() !== Number(m[2])) throw new Error(`time data "${text}" doesn't match format "%m/%d/%Y"`)
  return isoDate(d)
}

/** The cookies a response sets, as a request `Cookie` header value. */
function cookieHeader(res: Response, previous = ''): string {
  const jar = new Map<string, string>()
  for (const pair of previous.split('; ').filter(Boolean)) jar.set(pair.slice(0, pair.indexOf('=')), pair)
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0]!
    jar.set(pair.slice(0, pair.indexOf('=')), pair)
  }
  return [...jar.values()].join('; ')
}

const csrfOf = (html: string): string => /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1] ?? ''

/** The day's prices as CSV text, through FedInvest's session, CSRF-protected form flow. */
async function downloadCsv(ctx: NativeCtx, day: Date): Promise<string> {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-CA,en-US;q=0.7,en;q=0.3',
    'User-Agent': BROWSER_UA,
  }
  const read = async (res: Response): Promise<string> => {
    const text = await res.text()
    if (!res.ok) throw new NativeHttpError(res.status, res.url, text)
    return text
  }

  // 1. The date form: a session cookie and its CSRF token.
  const first = await ctx.http.response(`${BASE}selectSecurityPriceDate`, { headers })
  let cookie = cookieHeader(first)
  const token = csrfOf(await read(first))

  // 2. Choose the date; FedInvest redirects to the price page, which carries a fresh token for the download forms.
  const second = await ctx.http.response(`${BASE}selectSecurityPriceDate`, {
    method: 'POST',
    headers: { ...headers, Cookie: cookie, Referer: `${BASE}selectSecurityPriceDate`, Origin: 'https://www.treasurydirect.gov' },
    form: { priceDate: isoDate(day), submit: 'Show Prices', _csrf: token },
  })
  cookie = cookieHeader(second, cookie)
  const detailToken = csrfOf(await read(second))

  // 3. The CSV download form.
  const csv = await ctx.http.response(`${BASE}securityPriceDetail`, {
    method: 'POST',
    headers: { ...headers, Cookie: cookie, Referer: `${BASE}securityPriceDetail`, Origin: 'https://www.treasurydirect.gov' },
    form: { priceDateDay: String(day.getDate()), priceDateMonth: String(day.getMonth() + 1), priceDateYear: String(day.getFullYear()), fileType: 'csv', csv: 'CSV FORMAT', _csrf: detailToken },
  })
  return read(csv)
}

export async function treasuryPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const securityType = optString(params, 'security_type')
  if (securityType !== undefined && !SECURITY_TYPES.includes(securityType)) throw new Error(`Input should be 'bill', 'note', 'bond', 'tips' or 'frn': ${securityType}`)
  const cusip = optString(params, 'cusip')
  const date = optString(params, 'date') ?? isoDate(lastBusinessDay(ctx))

  const text = await downloadCsv(ctx, parseDate(date))
  if (!text) throw new Error('Data not found')

  // The eight columns by position. The file used to start with a header row (read_csv header=0); it now starts with data.
  let lines = parseCsv(text)
  if (lines[0]?.[0]?.trim().toUpperCase() === 'CUSIP') lines = lines.slice(1)
  let rows = lines.map((cells) => {
    const r: Record<string, string | undefined> = {}
    COLUMNS.forEach((name, i) => {
      r[name] = cells[i]
    })
    return r
  })

  if (securityType !== undefined) rows = rows.filter((r) => (r.security_type ?? '').toLowerCase().includes(securityType))
  if (cusip !== undefined) rows = rows.filter((r) => r.cusip === cusip)

  return rows.map((r) => {
    const row: Row = { date }
    for (const name of COLUMNS) {
      const raw = r[name]
      if (name === 'maturity_date' || name === 'call_date') row[name] = parseUsDate(raw)
      else if (raw === undefined || NA_VALUES.has(raw)) row[name] = null
      else if (['rate', 'bid', 'offer', 'eod_price'].includes(name)) {
        const n = Number(raw)
        row[name] = raw.trim() === '' || Number.isNaN(n) ? raw : n
      } else row[name] = raw
    }
    return validateModel(TREASURY_PRICES_FIELDS, {}, nullTokensToNone(row), 'UsTreasuryPricesData')
  })
}
