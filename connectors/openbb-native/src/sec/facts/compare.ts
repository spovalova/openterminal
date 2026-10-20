// equity/compare/company_facts, provider sec. Ported from openbb_sec/models/compare_company_facts.py and
// openbb_sec/utils/frames.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic
// models (an absent or null field is omitted), the clock is ctx.now(), and symbols are fetched in order, not concurrently.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { CALENDAR_PERIODS_DICT, INSTANT_FACTS, SHARES_FACTS, USD_PER_SHARE_FACTS } from '../definitions.js'
import { HEADERS, cachedRequest, getAllCompanies, symbolMap } from '../helpers.js'
import { dayNum } from './py.js'

type Entry = Record<string, any>

const DAY_S = 24 * 3600

/** Fetch a frames or concept document: frames for the current year are cached until evicted, older ones refresh daily. */
function fetchData(ctx: NativeCtx, url: string, useCache: boolean, persist: boolean): Promise<Record<string, any>> {
  return cachedRequest(ctx, url, { headers: HEADERS, useCache, ...(persist ? {} : { expireS: DAY_S }) }) as Promise<Record<string, any>>
}

// Duration buckets that participate in a cumulative year-to-date chain, and the spans surfaced to the caller.
const CUMULATIVE_SPANS = new Set(['quarter', 'h1', 'nine_month', 'annual'])
const PRIMARY_SPANS = new Set(['annual', 'quarter', 'instant'])

// Standard calendar quarter-end month/day pairs (Q1-Q4).
const QUARTER_END_DAYS: [number, number][] = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
]

/** An SEC frame id as a `(calendar_year, calendar_period)` pair: `CY2026` is FY, `CY2026Q1` and `CY2026Q1I` are Q1. */
function parseFrame(frame: string): [number | null, string] {
  const year = /^\d{4}$/.test(frame.slice(2, 6)) ? parseInt(frame.slice(2, 6), 10) : null
  const period = frame.includes('Q') ? 'Q' + frame.split('Q').slice(1).join('Q').replace(/I+$/, '') : 'FY'
  return [year, period]
}

/** The calendar quarter whose standard end date is nearest to a period end; `(null, null)` for an unparseable date. */
function nearestQuarter(end: string): [number | null, string | null] {
  const d = dayNum(end)
  if (d === null) return [null, null]
  const year = new Date(d * 86_400_000).getUTCFullYear()
  let bestYear: number | null = null
  let bestQ: number | null = null
  let bestDist: number | null = null
  for (const yy of [year - 1, year, year + 1]) {
    QUARTER_END_DAYS.forEach(([month, day], i) => {
      const dist = Math.abs(Math.round(Date.UTC(yy, month - 1, day) / 86_400_000) - d)
      if (bestDist === null || dist < bestDist) {
        bestYear = yy
        bestQ = i + 1
        bestDist = dist
      }
    })
  }
  return [bestYear, `Q${bestQ}`]
}

/** The inclusive day count of an entry, or null when instantaneous. */
function spanDays(item: Entry): number | null {
  const { start, end } = item
  if (!start || !end) return null
  const a = dayNum(end)
  const b = dayNum(start)
  return a === null || b === null ? null : a - b + 1
}

/** Bucket a reporting duration (in days) into a span class. */
function classifySpan(days: number | null): string {
  if (days === null) return 'instant'
  if (days <= 120) return 'quarter'
  if (days <= 210) return 'h1'
  if (days <= 300) return 'nine_month'
  return 'annual'
}

/** Annotate a companyconcept entry with span and calendar period metadata. */
function enrichEntry(item: Entry): Entry {
  const end: string = item.end || ''
  const span = classifySpan(spanDays(item))
  item.span = span
  let calYear: number | null
  let calPeriod: string | null
  if (item.frame) {
    ;[calYear, calPeriod] = parseFrame(item.frame)
  } else {
    ;[calYear, calPeriod] = nearestQuarter(end)
    if (span === 'annual') calPeriod = 'FY'
  }
  item.calendar_year = calYear
  item.calendar_period = calPeriod
  return item
}

/** Keep the most recently filed value per (symbol, unit, period, span). */
function dedupLatestFiled(records: Entry[]): Entry[] {
  const best = new Map<string, Entry>()
  for (const r of records) {
    const key = JSON.stringify([r.symbol ?? null, r.unit ?? null, r.start ?? null, r.end ?? null, r.span ?? null])
    const cur = best.get(key)
    const rank: [string, string] = [r.filed ?? '', r.accn ?? '']
    if (cur === undefined || rank[0] > (cur.filed ?? '') || (rank[0] === (cur.filed ?? '') && rank[1] > (cur.accn ?? ''))) best.set(key, r)
  }
  return [...best.values()]
}

/** Derive standalone 3-month quarters from cumulative YTD chains (Q4 falls out as FY - 9-month). */
function deriveStandaloneQuarters(records: Entry[]): Entry[] {
  const derived: Entry[] = []
  const groups = new Map<string, Entry[]>()
  for (const r of records) {
    if (CUMULATIVE_SPANS.has(r.span) && r.end) {
      const key = JSON.stringify([r.symbol ?? null, r.unit ?? null, r.fy ?? null])
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
  }

  for (const entries of groups.values()) {
    const annual = entries.find((e) => e.span === 'annual')
    let fyStart: string | null
    if (annual && annual.start) fyStart = annual.start
    else {
      const starts = entries.filter((e) => e.start).map((e) => e.start as string)
      fyStart = starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null
    }
    if (!fyStart) continue

    const chain = entries.filter((e) => e.start === fyStart).sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
    const reported = new Set<string>(entries.filter((e) => e.span === 'quarter' && e.calendar_period).map((e) => e.calendar_period))
    let prevVal = 0.0
    let prevDays = 0
    let prevEnd: string = fyStart

    for (const e of chain) {
      const linkStart = prevEnd
      const curVal = e.val
      const curDays = spanDays(e) || 0
      const curEnd: string = e.end
      const standalone = curVal !== null && curVal !== undefined ? curVal - prevVal : null
      const stepDays = curDays - prevDays
      if (curVal !== null && curVal !== undefined) prevVal = curVal
      prevDays = curDays
      prevEnd = curEnd

      // The first link is already a standalone quarter; keep it from the primary set rather than re-deriving it.
      if (curVal === null || curVal === undefined || e.span === 'quarter') continue
      // A difference that is not ~one quarter means the chain skipped a link; splitting it would invent data.
      if (!(stepDays >= 60 && stepDays <= 120)) continue
      const [calYear, cq] = nearestQuarter(curEnd)
      if (cq !== null && reported.has(cq)) continue
      const next: Entry = { ...e }
      next.val = standalone
      next.start = linkStart
      next.span = 'quarter'
      next.calendar_period = cq
      next.calendar_year = calYear
      delete next.frame
      next.derived = true
      if (cq !== null) reported.add(cq)
      derived.push(next)
    }
  }
  return derived
}

/** Filter parsed records to the requested calendar year and period. */
function selectPeriods(records: Entry[], year: number | null, calendarPeriod: string | null): Entry[] {
  const primary = records.filter((r) => PRIMARY_SPANS.has(r.span))
  const fp = (calendarPeriod ?? '').toLowerCase()
  let selected: Entry[]
  if (fp === 'fy') {
    selected = primary.filter((r) => r.calendar_period === 'FY')
    // instant-only concept: use the calendar year-end point
    if (selected.length === 0) selected = primary.filter((r) => r.span === 'instant' && r.calendar_period === 'Q4')
  } else if (['q1', 'q2', 'q3', 'q4'].includes(fp)) {
    selected = primary.filter((r) => r.calendar_period === fp.toUpperCase())
  } else {
    selected = primary
  }
  if (year !== null) selected = selected.filter((r) => r.calendar_year === year)
  return selected
}

type Frame = { metadata: Record<string, any>; data: Entry[] }

/** The symbol of each CIK; a CIK listed twice takes the later ticker. */
async function cikToSymbol(ctx: NativeCtx, useCache: boolean): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const c of await getAllCompanies(ctx, useCache)) map.set(c.cik, c.symbol)
  return map
}

/** A frame of data for a given fact: one value per reporting entity that best fits the calendar period. */
async function getFrame(
  ctx: NativeCtx,
  opts: { fact?: string; year?: number | null; calendarPeriod?: string | null; taxonomy?: string; units?: string; instantaneous?: boolean; useCache?: boolean },
): Promise<Frame> {
  const fact = opts.fact ?? 'Revenues'
  let year = opts.year ?? null
  const calendarPeriod = opts.calendarPeriod ?? null
  const taxonomy = opts.taxonomy ?? 'us-gaap'
  let units = opts.units ?? 'USD'
  const instantaneous = opts.instantaneous ?? false
  const useCache = opts.useCache ?? true

  const now = ctx.now()
  let quarter: number | null = calendarPeriod ? (CALENDAR_PERIODS_DICT[calendarPeriod] ?? null) : null
  if (year === null && quarter === null) {
    quarter = Math.floor(now.getMonth() / 3)
    year = now.getFullYear()
  }
  if (year === null) year = now.getFullYear()
  const persist = now.getFullYear() === year

  if (SHARES_FACTS.includes(fact)) units = 'shares'
  if (USD_PER_SHARE_FACTS.includes(fact)) units = 'USD-per-shares'

  let url = `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${fact}/${units}/CY${year}`
  if (quarter) url += `Q${quarter}`
  if (instantaneous) url += 'I'
  url += '.json'

  let response: Record<string, any>
  try {
    response = await fetchData(ctx, url, useCache, persist)
  } catch (e) {
    const message = 'No frame was found with the combination of parameters supplied. Try adjusting the period. Not all GAAP measures have frames available.'
    if (url.endsWith('I.json')) {
      ctx.log('No instantaneous frame was found, trying calendar period data.')
      url = url.replace('I.json', '.json')
      try {
        response = await fetchData(ctx, url, useCache, persist)
      } catch {
        throw new Error(message, { cause: e })
      }
    } else if (url.includes('Q') && !url.endsWith('I.json')) {
      ctx.log('No frame was found for the requested quarter, trying instantaneous data.')
      url = url.replace('.json', 'I.json')
      try {
        response = await fetchData(ctx, url, useCache, persist)
      } catch {
        throw new Error(message, { cause: e })
      }
    } else {
      throw new Error(message, { cause: e })
    }
  }

  // sorted(..., key=val, reverse=True): descending, ties in their original order.
  const data: Entry[] = [...((response.data ?? []) as Entry[])].sort((a, b) => b.val - a.val)
  const metadata = {
    frame: response.ccp ?? '',
    tag: response.tag ?? '',
    label: response.label ?? '',
    description: response.description ?? '',
    taxonomy: response.taxonomy ?? '',
    unit: response.uom ?? '',
    count: response.pts ?? '',
  }
  const symbols = await cikToSymbol(ctx, useCache)
  const [calYear, calPeriod] = parseFrame(metadata.frame || '')
  const rows = data.map((d) => {
    const symbol = symbols.get(String(d.cik))
    return { ...d, ...(symbol !== undefined ? { symbol } : {}), unit: metadata.unit, fact: metadata.label, frame: metadata.frame, calendar_period: calPeriod, calendar_year: calYear !== null ? calYear : year }
  })
  return { metadata, data: rows }
}

/** All the XBRL disclosures of one concept for one or more companies. */
async function getConcept(
  ctx: NativeCtx,
  opts: { symbol: string; fact?: string; year?: number | null; calendarPeriod?: string | null; taxonomy?: string; useCache?: boolean },
): Promise<Frame> {
  const fact = opts.fact ?? 'Revenues'
  const year = opts.year ?? null
  const calendarPeriod = opts.calendarPeriod ?? null
  const taxonomy = opts.taxonomy ?? 'us-gaap'
  const useCache = opts.useCache ?? true
  const results: Entry[] = []
  const messages: string[] = []
  const metadata: Record<string, any> = {}

  for (const raw of opts.symbol.split(',')) {
    const ticker = raw.toUpperCase()
    const cik = await symbolMap(ctx, ticker)
    if (cik === '') {
      const message = `Symbol Error: No CIK was found for, ${ticker}`
      ctx.log(message)
      messages.push(message)
      continue
    }
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${fact}.json`
    let response: Record<string, any> | null = null
    try {
      response = await fetchData(ctx, url, useCache, false)
    } catch {
      const message = `Symbol Error: No data was found for, ${ticker} and ${fact}`
      ctx.log(message)
      messages.push(message)
    }
    if (response && Object.keys(response).length) {
      const units: Record<string, Entry[]> = response.units ?? {}
      metadata[ticker] = { cik: response.cik ?? '', taxonomy: response.taxonomy ?? '', tag: response.tag ?? '', label: response.label ?? '', description: response.description ?? '', name: response.entityName ?? '' }
      const unitNames = Object.keys(units)
      if (unitNames.length === 0) throw new Error('list index out of range')
      for (const [unit, values] of Object.entries(units)) {
        for (const value of values) {
          // The response is shared through the cache: annotate a copy.
          results.push({ ...value, unit, symbol: ticker, cik: metadata[ticker].cik, name: metadata[ticker].name, fact: metadata[ticker].label })
        }
      }
    }
  }

  if (results.length === 0) throw new Error(JSON.stringify(messages))

  // Dedup re-reported values (latest filing wins), then reduce cumulative year-to-date figures to standalone quarters.
  const parsed = dedupLatestFiled(results.map(enrichEntry))
  parsed.push(...deriveStandaloneQuarters(parsed))

  let final = selectPeriods(parsed, year, calendarPeriod)
  if (final.length === 0 && (year !== null || calendarPeriod)) {
    ctx.log(`No results were found for ${fact} in the requested calendar period. Returning all reported values instead.`)
    final = parsed.filter((r) => PRIMARY_SPANS.has(r.span))
  }

  const byFiledEnd = (a: Entry, b: Entry): number => {
    const af = a.filed ?? ''
    const bf = b.filed ?? ''
    if (af !== bf) return af < bf ? 1 : -1
    const ae = a.end ?? ''
    const be = b.end ?? ''
    return ae === be ? 0 : ae < be ? 1 : -1
  }
  return { metadata, data: [...final].sort(byFiledEnd) }
}

/** A standalone calendar-Q4 universe frame as FY - (Q1 + Q2 + Q3). */
async function getUniverseQuarter4(ctx: NativeCtx, opts: { fact?: string; year?: number | null; taxonomy?: string; units?: string; useCache?: boolean }): Promise<Frame> {
  const fact = opts.fact ?? 'Revenues'
  const taxonomy = opts.taxonomy ?? 'us-gaap'
  let units = opts.units ?? 'USD'
  const useCache = opts.useCache ?? true
  const now = ctx.now()
  const year = opts.year ?? now.getFullYear()

  // Instantaneous (balance-sheet) concepts already have a populated year-end CY####Q4I frame, so fetch that directly.
  if (INSTANT_FACTS.includes(fact)) return getFrame(ctx, { fact, year, calendarPeriod: 'q4', instantaneous: true, taxonomy, units, useCache })

  if (SHARES_FACTS.includes(fact)) units = 'shares'
  if (USD_PER_SHARE_FACTS.includes(fact)) units = 'USD-per-shares'

  const persist = now.getFullYear() === year
  const base = `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${fact}/${units}/CY${year}`

  let annualResp: Record<string, any>
  try {
    annualResp = await fetchData(ctx, base + '.json', useCache, persist)
  } catch {
    // No annual (duration) frame exists for this concept: it is a point-in-time balance not captured by INSTANT_FACTS.
    return getFrame(ctx, { fact, year, calendarPeriod: 'q4', instantaneous: true, taxonomy, units, useCache })
  }

  const quarterSums = new Map<unknown, number>()
  const quarterCounts = new Map<unknown, number>()
  for (const q of [1, 2, 3]) {
    let qresp: Record<string, any>
    try {
      qresp = await fetchData(ctx, `${base}Q${q}.json`, useCache, persist)
    } catch {
      continue
    }
    for (const row of (qresp.data ?? []) as Entry[]) {
      const cik = row.cik
      if (cik === null || cik === undefined || row.val === null || row.val === undefined) continue
      quarterSums.set(cik, (quarterSums.get(cik) ?? 0) + row.val)
      quarterCounts.set(cik, (quarterCounts.get(cik) ?? 0) + 1)
    }
  }

  let data: Entry[] = []
  for (const row of (annualResp.data ?? []) as Entry[]) {
    const cik = row.cik
    if (cik === null || cik === undefined || row.val === null || row.val === undefined || (quarterCounts.get(cik) ?? 0) < 3) continue
    data.push({ ...row, val: row.val - quarterSums.get(cik)! })
  }

  const metadata = {
    frame: `CY${year}Q4`,
    tag: annualResp.tag ?? '',
    label: annualResp.label ?? '',
    description: annualResp.description ?? '',
    taxonomy: annualResp.taxonomy ?? '',
    unit: annualResp.uom ?? '',
    count: data.length,
    note: 'Q4 derived as FY - (Q1 + Q2 + Q3); only filers reporting all three earlier quarters are included.',
  }

  data = data.sort((a, b) => b.val - a.val)
  const symbols = await cikToSymbol(ctx, useCache)
  const rows = data.map((d) => {
    const symbol = symbols.get(String(d.cik))
    return { ...d, ...(symbol !== undefined ? { symbol } : {}), unit: metadata.unit, fact: metadata.label, frame: metadata.frame, calendar_year: year, calendar_period: 'Q4' }
  })
  return { metadata, data: rows }
}

/** `__alias_dict__` of SecCompareCompanyFactsData: source key → field name. */
const ALIASES: Record<string, string> = { filed: 'reported_date', start: 'period_beginning', end: 'period_ending', fy: 'fiscal_year', fp: 'fiscal_period', entityName: 'name', accn: 'accession', val: 'value', loc: 'location' }

export async function compareCompanyFacts(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbolParam = params.symbol
  const symbol = Array.isArray(symbolParam) ? symbolParam.join(',') : typeof symbolParam === 'string' ? symbolParam : ''
  const fact = typeof params.fact === 'string' && params.fact ? params.fact : 'Revenues'
  const year = params.year === undefined || params.year === null ? null : Number(params.year)
  const calendarPeriod = typeof params.calendar_period === 'string' && params.calendar_period ? params.calendar_period : null
  const instantaneous = Boolean(params.instantaneous ?? false)
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)

  let results: Frame
  if (!symbol) {
    if (calendarPeriod === 'q4' && !instantaneous) {
      // No standalone Q4 duration frame exists; derive FY - (Q1+Q2+Q3).
      results = await getUniverseQuarter4(ctx, { fact, year, useCache })
    } else {
      results = await getFrame(ctx, { fact, year, calendarPeriod, instantaneous, useCache })
    }
  } else {
    if (instantaneous) ctx.log("The 'instantaneous' parameter is ignored when a symbol is supplied.")
    results = await getConcept(ctx, { symbol, fact, year, calendarPeriod, useCache })
  }

  return results.data.map((d) => {
    const row: Row = {}
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) continue
      row[ALIASES[k] ?? k] = v
    }
    return row
  })
}
