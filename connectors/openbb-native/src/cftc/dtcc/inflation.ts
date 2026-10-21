// Published inflation index histories and zero-coupon inflation curves. Ported from openbb_cftc/utils/inflation.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are ISO strings, downloads are memoised with ctx.cache
// instead of the on-disk store.
import type { NativeCtx } from '../../types.js'
import { buildNodes, extractObservations, trimObservations, pyFloat, type SliceRecord } from './curve.js'
import { daysInMonth, mk, month, type D, year as yearOf } from './dates.js'
import { SEARCH_USER_AGENT } from './search.js'

const BLS_TIMESERIES_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data'
const ONS_TIMESERIES_URL = 'https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries'
const EUROSTAT_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr'

export const INFLATION_FISN_PREFIX = 'NA/Swap Infl Idx'

/** The UPI FISN of a currency's zero-coupon inflation swap (`inflation_fisn`). */
export const inflationFisn = (currency: string): string => `${INFLATION_FISN_PREFIX} ${currency.toUpperCase()}`

export type InflationSpec = { label: string; currency: string; source: string; series: string; lag_months: number; interpolate: boolean }

export const INFLATION_INDICES: Record<string, InflationSpec> = {
  USCPI: { label: 'US CPI-U NSA', currency: 'USD', source: 'bls', series: 'CUUR0000SA0', lag_months: 3, interpolate: true },
  UKRPI: { label: 'UK RPI', currency: 'GBP', source: 'ons', series: 'chaw/mm23', lag_months: 2, interpolate: false },
  EURHICPXT: { label: 'Euro area HICP excluding tobacco', currency: 'EUR', source: 'eurostat', series: 'M.I15.TOT_X_TBC.EA', lag_months: 3, interpolate: true },
}

const UNDERLIER_TOKENS: [string[], string][] = [
  [['UK-RPI', 'GB-RPI', 'UKRPI'], 'UKRPI'],
  [['EXT-CPI', 'HICP', 'EUR-CPI'], 'EURHICPXT'],
  [['CPI-U', 'CPURNSA', 'USA-CPI', 'US-CPI'], 'USCPI'],
]

/** The published index an inflation underlier references, or null (`index_for_inflation_underlier`). */
export function indexForInflationUnderlier(underlier: string | null | undefined): string | null {
  const name = (underlier ?? '').trim().toUpperCase().replace(/ /g, '-')
  if (!name) return null
  for (const [tokens, key] of UNDERLIER_TOKENS) if (tokens.some((t) => name.includes(t))) return key
  return null
}

/** Monthly index levels keyed by the first of the month. */
export type Levels = Map<D, number>

const monthStart = (day: D): D => `${day.slice(0, 7)}-01`

/** Shift a month-start date back by a number of months (`_shift_months`). */
function shiftMonths(day: D, months: number): D {
  const total = yearOf(day) * 12 + month(day) - 1 - months
  return mk(Math.floor(total / 12), (((total % 12) + 12) % 12) + 1, 1)
}

const daysInMonthOf = (day: D): number => daysInMonth(yearOf(day), month(day))

/** Fill months the publisher skipped, interpolating between the levels around them (`backfill_gaps`). */
export function backfillGaps(levels: Levels): Levels {
  if (levels.size < 2) return new Map(levels)
  const ordered = [...levels.keys()].sort()
  const filled = new Map(levels)
  for (let i = 0; i + 1 < ordered.length; i++) {
    const earlier = ordered[i]!
    const later = ordered[i + 1]!
    const span = yearOf(later) * 12 + month(later) - (yearOf(earlier) * 12 + month(earlier))
    if (span <= 1) continue
    const step = (levels.get(later)! - levels.get(earlier)!) / span
    for (let offset = 1; offset < span; offset++) filled.set(shiftMonths(earlier, -offset), levels.get(earlier)! + step * offset)
  }
  return filled
}

/** The reference index for a date, on the TIPS lag and interpolation (`reference_index`). */
export function referenceIndex(levels: Levels, day: D, lagMonths: number, interpolate: boolean): number | null {
  const base = shiftMonths(monthStart(day), lagMonths)
  const first = levels.get(base)
  if (first === undefined) return null
  if (!interpolate) return first
  const following = levels.get(shiftMonths(base, -1))
  if (following === undefined) return null
  return first + ((Number(day.slice(8, 10)) - 1) / daysInMonthOf(day)) * (following - first)
}

/** A trade's index ratio between its base date and a later date (`index_ratio`). */
export function indexRatio(levels: Levels, baseDate: D, day: D, lagMonths: number, interpolate: boolean): number | null {
  const base = referenceIndex(levels, baseDate, lagMonths, interpolate)
  const current = referenceIndex(levels, day, lagMonths, interpolate)
  if (base === null || current === null || base <= 0) return null
  return current / base
}

const BLS_MAX_YEARS = 10
const INDEX_HISTORY_YEARS = 30

type BlsBody = { Results?: { series?: { data?: { period?: string; value?: string; year?: string }[] }[] }; message?: string[] }

/** One BLS window of at most ten years, from the key-free public API (`_fetch_bls_window`). */
async function fetchBlsWindow(ctx: NativeCtx, series: string, startYear: number, endYear: number): Promise<Levels> {
  const body = await ctx.http.json<BlsBody | null>(BLS_TIMESERIES_URL, {
    method: 'POST',
    body: JSON.stringify({ seriesid: [series], startyear: String(startYear), endyear: String(endYear) }),
    headers: { 'Content-Type': 'application/json' },
  })
  const seriesList = body?.Results?.series
  if (!seriesList || seriesList.length === 0) {
    const reported = (body?.message ?? []).join('; ')
    throw new Error(`The BLS API did not return ${series}` + (reported ? ` -> ${reported}` : '.'))
  }
  const levels: Levels = new Map()
  for (const row of seriesList[0]!.data ?? []) {
    const period = (row.period ?? '').trim()
    if (!period.startsWith('M') || period === 'M13') continue
    const level = pyFloat((row.value ?? '').trim())
    if (level === null) continue
    levels.set(mk(Number(row.year), Number(period.slice(1)), 1), level)
  }
  return levels
}

/** A BLS timeseries, split into the ten-year windows the API serves (`_fetch_bls`). */
async function fetchBls(ctx: NativeCtx, series: string, startYear: number, endYear: number): Promise<Levels> {
  const bounds: [number, number][] = []
  for (let y = startYear; y <= endYear; y += BLS_MAX_YEARS) bounds.push([y, Math.min(y + BLS_MAX_YEARS - 1, endYear)])
  const windows = await Promise.all(bounds.map(([low, high]) => fetchBlsWindow(ctx, series, low, high)))
  const levels: Levels = new Map()
  for (const w of windows) for (const [k, v] of w) levels.set(k, v)
  return levels
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** An ONS monthly timeseries, served as JSON (`_fetch_ons`). */
async function fetchOns(ctx: NativeCtx, series: string): Promise<Levels> {
  const url = `${ONS_TIMESERIES_URL}/${series}/data`
  const text = await ctx.http.text(url, { headers: { 'User-Agent': SEARCH_USER_AGENT } })
  const body = JSON.parse(text) as { months?: { date?: string; value?: string }[] } | null
  const months = body?.months
  if (!months || months.length === 0) throw new Error(`Unexpected ONS response from ${url}.`)
  const levels: Levels = new Map()
  for (const row of months) {
    const label = (row.date ?? '').trim()
    const value = (row.value ?? '').trim()
    if (!label || !value) continue
    const m = /^(\d{4}) ([A-Za-z]{3})$/.exec(label)
    const idx = m ? MONTHS.indexOf(m[2]!.toLowerCase()) : -1
    if (!m || idx < 0) throw new Error(`time data '${label}' does not match format '%Y %b'`)
    const level = pyFloat(value)
    if (level === null) throw new Error(`could not convert string to float: '${value}'`)
    levels.set(mk(Number(m[1]), idx + 1, 1), level)
  }
  return levels
}

/** A Eurostat HICP monthly index, served as SDMX-JSON (`_fetch_eurostat`). */
async function fetchEurostat(ctx: NativeCtx, series: string): Promise<Levels> {
  const [freq, unit, coicop, geo] = series.split('.') as [string, string, string, string]
  const url = `${EUROSTAT_URL}?format=JSON&freq=${freq}&unit=${unit}&coicop18=${coicop}&geo=${geo}`
  const response = await ctx.http.json<unknown>(url)
  if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new Error(`Unexpected Eurostat response from ${url}.`)
  const r = response as { dimension?: { time?: { category?: { index?: Record<string, number> } } }; value?: Record<string, number | null> }
  const periods = r.dimension?.time?.category?.index
  const values = r.value
  if (!periods || !values) throw new Error(`Unexpected Eurostat response from ${url}.`)
  const byPosition = new Map<number, string>(Object.entries(periods).map(([label, position]) => [position, label]))
  const levels: Levels = new Map()
  for (const [position, value] of Object.entries(values)) {
    const label = byPosition.get(Number(position))
    if (label === undefined || value === null || value === undefined) continue
    const [y, m] = label.split('-') as [string, string]
    levels.set(mk(Number(y), Number(m), 1), Number(value))
  }
  return levels
}

/** A published index's monthly levels, by the first of each month (`get_inflation_index`). */
export async function getInflationIndex(ctx: NativeCtx, index: string): Promise<Levels> {
  const spec = INFLATION_INDICES[index]
  if (!spec) throw new Error(`No published source is configured for '${index}'.`)
  const today = ctx.now().toISOString().slice(0, 10)
  const key = `inflation-${index}-${monthStart(today)}`
  return ctx.cache(key, 6 * 3600_000, async () => {
    let levels: Levels
    try {
      if (spec.source === 'bls') levels = await fetchBls(ctx, spec.series, yearOf(today) - INDEX_HISTORY_YEARS, yearOf(today))
      else if (spec.source === 'ons') levels = await fetchOns(ctx, spec.series)
      else levels = await fetchEurostat(ctx, spec.series)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to fetch the ${index} index -> ${message}`, { cause: err })
    }
    if (levels.size === 0) throw new Error(`No published levels were returned for ${index}.`)
    return backfillGaps(levels)
  })
}

/** The day's traded zero-coupon breakevens as curve nodes (`build_breakeven_curve`). */
export function buildBreakevenCurve(records: Iterable<SliceRecord>, currency: string, tradeDate: D, minTrades = 1): [number, number][] {
  const observations = trimObservations(extractObservations(records, { tradeDate, fisn: inflationFisn(currency), currency, spotOnly: false }))
  if (observations.length === 0) return []
  const nodes = buildNodes(observations, { granularity: 'benchmark', minTrades, dayCountDefault: 'A020' })
  return nodes.map((n) => [n.tenor_years as number, n.par_rate as number])
}

/** The zero-coupon breakeven at a tenor, interpolated and flat past either end (`breakeven_at`). */
export function breakevenAt(curve: [number, number][], years: number): number | null {
  if (curve.length === 0 || years <= 0) return null
  if (curve.length === 1) return curve[0]![1]
  if (years <= curve[0]![0]) return curve[0]![1]
  if (years >= curve[curve.length - 1]![0]) return curve[curve.length - 1]![1]
  const low = [...curve].reverse().find((node) => node[0] <= years) ?? curve[0]!
  const high = curve.find((node) => node[0] >= years) ?? curve[curve.length - 1]!
  const span = high[0] - low[0]
  if (span <= 0) return low[1]
  return low[1] + ((years - low[0]) / span) * (high[1] - low[1])
}

