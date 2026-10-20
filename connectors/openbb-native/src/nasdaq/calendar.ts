// equity/calendar/{dividend,earnings,ipo,splits} and economy/calendar, provider nasdaq. Ported from
// openbb_nasdaq/models/{calendar_dividend,calendar_earnings,calendar_ipo,calendar_splits,economic_calendar}.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, requests bounded to a few at a time.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { countryName } from './countries.js'
import { addDays, compact, dateRange, getNasdaqData, htmlUnescape, listParam, mapLimit, mdyToIso, parseLooseDate, pyFloat, removeHtmlTags, rowsFromTable, today, toDate, toNumber, weekday, type Dict } from './helpers.js'

const CONCURRENCY = 6

/** Rename `from` keys to OpenBB's names (`__alias_dict__` read backwards); other keys are kept as they are. */
function rename(raw: Dict, aliases: Record<string, string>): Dict {
  const out: Dict = {}
  for (const [k, v] of Object.entries(raw)) out[aliases[k] ?? k] = v
  return out
}

/** Python's `sorted(rows, key=..., reverse=True)` on strings: stable, descending. */
function sortDescByString<T>(rows: T[], key: (r: T) => string): T[] {
  return [...rows].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
}

/** `datetime.strptime(v, "%m/%d/%Y").date()` after `v.replace("N/A", "")`; null when empty. */
function dateOrNull(v: unknown): string | null {
  const s = String(v ?? '').replaceAll('N/A', '')
  if (!s) return null
  const d = mdyToIso(s)
  if (d === null) throw new Error(`time data '${s}' does not match format '%m/%d/%Y'`)
  return d
}

function floatOrThrow(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  const n = pyFloat(String(v))
  if (n === null) throw new Error(`could not convert string to float: '${String(v)}'`)
  return n
}

// --- equity/calendar/dividend ----------------------------------------------------------------------------------

const DIVIDEND_ALIASES = {
  companyName: 'name',
  dividend_Ex_Date: 'ex_dividend_date',
  payment_Date: 'payment_date',
  record_Date: 'record_date',
  announcement_Date: 'declaration_date',
  dividend_Rate: 'amount',
  indicated_Annual_Dividend: 'annualized_amount',
}

export async function calendarDividend(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = today(ctx)
  const start = (params.start_date as string | undefined) ?? now
  const end = (params.end_date as string | undefined) ?? addDays(now, 3)
  const data: Dict[] = []
  const batches = await mapLimit(dateRange(start, end), CONCURRENCY, async (date) => {
    const payload = await getNasdaqData(ctx, `calendar/dividends?date=${date}`)
    return ((payload ?? {}).calendar ?? {}).rows ?? []
  })
  for (const rows of batches) if (rows && rows.length) data.push(...rows)
  if (!data.length) return []
  const sorted = sortDescByString(data, (r) => String(r.dividend_Ex_Date))
  return sorted.map((raw) => {
    const row = rename(raw, DIVIDEND_ALIASES)
    for (const k of ['ex_dividend_date', 'record_date', 'payment_date', 'declaration_date']) if (k in row) row[k] = dateOrNull(row[k])
    if ('amount' in row) row.amount = floatOrThrow(row.amount)
    if ('annualized_amount' in row) row.annualized_amount = floatOrThrow(row.annualized_amount)
    return compact(row)
  })
}

// --- equity/calendar/earnings ----------------------------------------------------------------------------------

const EARNINGS_ALIASES = {
  date: 'report_date',
  lastYearEPS: 'eps_previous',
  epsForecast: 'eps_consensus',
  eps: 'eps_actual',
  surprise: 'surprise_percent',
  noOfEsts: 'num_estimates',
  fiscalQuarterEnding: 'period_ending',
  lastYearRptDt: 'previous_report_date',
  time: 'reporting_time',
  marketCap: 'market_cap',
}

/** `datetime.strptime(payload["asOf"], "%a, %b %d, %Y").date()` */
function asOfDate(asOf: string): string {
  const d = parseLooseDate(asOf)
  if (d === null) throw new Error(`time data '${asOf}' does not match format '%a, %b %d, %Y'`)
  return d
}

/** The earnings validators' number reading: placeholders, currency marks and parentheses cleaned, then `float`. */
function earningsNumber(v: unknown): number | null {
  if (typeof v !== 'string') return v === null || v === undefined ? null : Number(v)
  const s = v.replaceAll('N/A', '').replaceAll('$', '').replaceAll(',', '').replaceAll('(', '-').replaceAll(')', '')
  return s ? floatOrThrow(s) : null
}

export async function calendarEarnings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = today(ctx)
  const start = (params.start_date as string | undefined) ?? now
  const end = (params.end_date as string | undefined) ?? addDays(now, 3)
  const batches = await mapLimit(dateRange(start, end), CONCURRENCY, async (date) => {
    const payload = await getNasdaqData(ctx, `calendar/earnings?date=${date}`)
    if (!payload?.rows) return []
    const asOf = asOfDate(payload.asOf)
    return (payload.rows as Dict[]).map((d) => ({ ...d, date: asOf }))
  })
  const data = batches.flat()
  if (!data.length) return []
  return sortDescByString(data, (r) => String(r.date)).map((raw) => {
    const row = rename(raw, EARNINGS_ALIASES)
    if ('period_ending' in row) {
      const v = String(row.period_ending).replaceAll('N/A', '')
      row.period_ending = v ? monthYear(v) : null
    }
    if ('previous_report_date' in row) row.previous_report_date = dateOrNull(row.previous_report_date)
    if ('reporting_time' in row) row.reporting_time = row.reporting_time ? String(row.reporting_time).replaceAll('time-', '') : null
    for (const k of ['market_cap', 'eps_previous', 'eps_consensus', 'num_estimates', 'eps_actual']) if (k in row) row[k] = earningsNumber(row[k])
    if ('surprise_percent' in row) {
      const v = String(row.surprise_percent).replaceAll('N/A', '')
      row.surprise_percent = v ? floatOrThrow(v)! * 0.01 : null
    }
    return compact(row)
  })
}

/** `datetime.strptime(v, "%b/%Y").strftime("%Y-%m")` */
function monthYear(v: string): string {
  const m = /^([A-Za-z]{3,9})\/(\d{4})$/.exec(v)
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const i = m ? months.indexOf(m[1]!.slice(0, 3).toLowerCase()) : -1
  if (!m || i < 0) throw new Error(`time data '${v}' does not match format '%b/%Y'`)
  return `${m[2]}-${String(i + 1).padStart(2, '0')}`
}

// --- equity/calendar/ipo ---------------------------------------------------------------------------------------

const STATUS_DATES: Record<string, string> = { priced: 'ipo_date', filed: 'filed_date', withdrawn: 'withdraw_date', upcoming: 'expected_price_date' }

export async function calendarIpo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const status = String(params.status ?? 'priced')
  const isSpo = params.is_spo === true
  const now = today(ctx)
  const start = (params.start_date as string | undefined) ?? addDays(now, -300)
  const end = (params.end_date as string | undefined) ?? now
  const months = [...new Set(dateRange(start, end).map((d) => d.slice(0, 7)))].sort()
  const offering = isSpo ? '&type=spo' : ''
  const batches = await mapLimit(months, CONCURRENCY, async (month) => {
    const payload = (await getNasdaqData(ctx, `ipo/calendar?date=${month}${offering}`)) ?? {}
    const block = payload[status] ?? {}
    return (status === 'upcoming' ? (block.upcomingTable ?? {}).rows : block.rows) ?? []
  })
  const data: Dict[] = batches.flat()
  if (!data.length) return [] // EmptyDataError: no offering matched the status and window
  const results = data.map((row) => {
    const shareCount = toNumber(row.sharesOffered)
    return compact({
      symbol: row.proposedTickerSymbol,
      name: row.companyName,
      exchange: row.proposedExchange,
      id: row.dealID,
      ipo_date: toDate(row.pricedDate),
      share_price: toNumber(row.proposedSharePrice),
      share_count: shareCount === null ? null : Math.trunc(shareCount),
      offer_amount: toNumber(row.dollarValueOfSharesOffered),
      expected_price_date: toDate(row.expectedPriceDate),
      filed_date: toDate(row.filedDate),
      withdraw_date: toDate(row.withdrawDate),
      deal_status: row.dealStatus,
    })
  })
  const field = STATUS_DATES[status]!
  return results.sort((a, b) => {
    const x = (a[field] as string | undefined) ?? '0001-01-01'
    const y = (b[field] as string | undefined) ?? '0001-01-01'
    return x < y ? -1 : x > y ? 1 : 0
  })
}

// --- equity/calendar/splits ------------------------------------------------------------------------------------

/** Split a '16 : 1' ratio string into its numerator and denominator (`_split_ratio`). */
function splitRatio(ratio: unknown): [number | null, number | null] {
  if (typeof ratio !== 'string' || !ratio.includes(':')) return [null, null]
  const at = ratio.indexOf(':')
  const numerator = toNumber(ratio.slice(0, at))
  const denominator = toNumber(ratio.slice(at + 1))
  if (numerator === null || !denominator) return [null, null]
  return [numerator, denominator]
}

export async function calendarSplits(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = today(ctx)
  const start = (params.start_date as string | undefined) ?? now
  const end = (params.end_date as string | undefined) ?? addDays(now, 30)
  const rows = rowsFromTable(await getNasdaqData(ctx, `calendar/splits?date=${start}`))
  if (!rows.length) return []
  const results: Row[] = []
  for (const row of rows) {
    const effective = toDate(row.executionDate)
    if (effective === null) continue
    if (start && effective < start) continue
    if (end && effective > end) continue
    const ratio = row.ratio
    const [numerator, denominator] = splitRatio(ratio)
    if (numerator === null || denominator === null) throw new Error(`Split ratio '${String(ratio)}' for ${String(row.symbol)} has no numerator and denominator`)
    results.push(
      compact({
        date: effective,
        payable_date: effective,
        symbol: row.symbol,
        name: row.name,
        ratio_display: ratio,
        numerator,
        denominator,
        split_ratio: numerator && denominator ? numerator / denominator : toNumber(ratio),
      }),
    )
  }
  return results.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
}

// --- economy/calendar ------------------------------------------------------------------------------------------

/** `NasdaqEconomicCalendarQueryParams.validate_country`: country names as lower_snake_case. */
function normalizeCountries(country: string): string[] {
  return country.split(',').map((item) => {
    const stripped = item.trim()
    const name = countryName(stripped)
    return (name ?? stripped).toLowerCase().replaceAll(' ', '_')
  })
}

/** "YYYY-MM-DD HH:MM" as the naive datetime OpenBB serialises: "YYYY-MM-DDTHH:MM:SS". */
function isoDateTime(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim())
  if (!m) throw new Error(`invalid datetime '${s}'`)
  return `${m[1]}T${m[2]!.padStart(2, '0')}:${m[3]}:${m[4] ?? '00'}`
}

export async function economyCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = today(ctx)
  const start = (params.start_date as string | undefined) ?? addDays(now, -2)
  const end = (params.end_date as string | undefined) ?? addDays(now, 3)
  const country = params.country === undefined ? undefined : listParam(params, 'country').join(',')
  const wanted = country ? normalizeCountries(country) : undefined
  const dates = dateRange(start, end).filter((d) => weekday(d) < 5) // exclude weekends
  let failure: unknown
  const batches = await mapLimit(dates, CONCURRENCY, async (date) => {
    let payload: Dict | undefined
    try {
      payload = await getNasdaqData(ctx, `calendar/economicevents?date=${date}`)
    } catch (err) {
      // a day that fails is skipped, unless nothing else answers
      failure ??= err
      return []
    }
    const rows: Dict[] = (payload ? payload.rows : undefined) ?? []
    return rows.map((item) => {
      const { gmt, ...rest } = item
      const time = gmt === 'All Day' ? `${date} 00:00` : `${date} ${gmt ?? ''}`.replaceAll('Tentative', '00:00').replaceAll('24H', '00:00')
      return { ...rest, date: time }
    })
  })
  let data: Dict[] = batches.flat()
  if (!data.length) throw failure ?? new Error('There was an error with the request and it was returned empty.')
  if (wanted) data = data.filter((d) => wanted.includes(String(d.country ?? '').toLowerCase().replaceAll(' ', '_')))
  return data.map((raw) => {
    const row = rename(raw, { eventName: 'event' })
    row.date = isoDateTime(String(row.date))
    for (const k of ['actual', 'previous', 'consensus']) if (typeof row[k] === 'string') row[k] = (row[k] as string).replaceAll('&nbsp;', '-')
    if ('description' in row) {
      let v = row.description
      if (typeof v === 'string' && v) {
        v = htmlUnescape(v).replaceAll('\r\n\r\n', ' ').replaceAll('\r\n', ' ').replaceAll("''", "'")
        v = removeHtmlTags(v as string)
      }
      row.description = v ? v : null
    }
    return compact(row)
  })
}
