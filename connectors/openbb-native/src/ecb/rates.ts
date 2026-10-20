// ecb/key_interest_rates, ecb/mfi_interest_rates, fixedincome/rate/estr and fixedincome/government/yield_curve,
// provider ecb. Ported from openbb_ecb/models/{ecb_interest_rates,mfi_interest_rates,euro_short_term_rate,yield_curve}.py
// and utils/yield_curve_series.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models
// and the pandas pivot, forward-fill and as-of steps written out by hand.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cachedRecords, EST_DATA_TYPES, estKey, fetchSdmxData, flag, FM_RATE_CODES, localDate, MIR_SERIES, mirKey, text, withField } from './helpers.js'

const DAY_MS = 86400000

/** An ISO date plus a number of days (UTC arithmetic on calendar dates). */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// --- ecb/key_interest_rates

const KEY_RATES: Record<string, string> = { DFR: 'deposit_facility', MRR_FR: 'main_refinancing', MLFR: 'marginal_lending' }
const KEY_RATES_KEY = `B.U2.EUR.4F.KR.${Object.values(FM_RATE_CODES).join('+')}.LEV`

export async function keyInterestRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const records = await cachedRecords(ctx, 'fm', JSON.stringify({ key: KEY_RATES_KEY }), flag(params, 'use_cache', true), () => fetchSdmxData(ctx, 'FM', KEY_RATES_KEY))
  if (records.length === 0) throw new Error('No data found for the ECB key rates.')

  // Pivot to one series per rate (the last value on a date wins), then carry each rate forward day by day.
  const series = new Map<string, Map<string, number>>()
  for (const record of records) {
    const field = KEY_RATES[(record.PROVIDER_FM_ID as string | undefined) ?? '']
    if (record.OBS_VALUE === null || record.OBS_VALUE === undefined || !field) continue
    let byDate = series.get(field)
    if (!byDate) series.set(field, (byDate = new Map()))
    byDate.set(record.date as string, record.OBS_VALUE as number)
  }
  if (series.size === 0) throw new Error('No data found for the ECB key rates.')
  const observed = [...series.values()].flatMap((m) => [...m.keys()]).sort()
  const start = text(params, 'start_date') ?? observed[0]!
  const end = text(params, 'end_date') ?? localDate(ctx.now())

  const fields = Object.values(KEY_RATES)
  const sorted = new Map([...series].map(([field, byDate]) => [field, [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))] as const))
  const pointer = new Map<string, number>()
  const last = new Map<string, number>()
  const out: Row[] = []
  // Observations on or before the first day count: they are what the first days carry forward.
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const row: Row = { date: day }
    for (const field of fields) {
      const obs = sorted.get(field)
      if (!obs) continue
      let at = pointer.get(field) ?? 0
      while (at < obs.length && obs[at]![0] <= day) last.set(field, obs[at++]![1])
      pointer.set(field, at)
      const value = last.get(field)
      if (value !== undefined) row[field] = value
    }
    out.push(row)
  }
  return out
}

// --- ecb/mfi_interest_rates

const DEFAULT_MFI_SYMBOL = Object.keys(MIR_SERIES).join(',')

export async function mfiInterestRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The symbol validator: a missing or empty value means every series, an unknown name is an error.
  const items = (text(params, 'symbol') ?? DEFAULT_MFI_SYMBOL).split(',').map((s) => s.trim()).filter(Boolean)
  const seriesList = items.length === 0 ? Object.keys(MIR_SERIES) : items
  const invalid = seriesList.filter((s) => !(s in MIR_SERIES))
  if (invalid.length > 0) throw new Error(`Invalid MFI series ${JSON.stringify(invalid)}. Choose from: ${JSON.stringify(Object.keys(MIR_SERIES))}`)
  const refArea = (text(params, 'country') ?? 'U2').toUpperCase()
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const useCache = flag(params, 'use_cache', true)

  const batches = await Promise.all(
    seriesList.map(async (series) => {
      const key = mirKey(series, refArea)
      const records = await cachedRecords(ctx, 'mfi_interest_rates', JSON.stringify({ series, area: refArea, start, end }), useCache, () => fetchSdmxData(ctx, 'MIR', key, { startDate: start, endDate: end }))
      return withField(records, '_series_name', series)
    }),
  )
  const records = batches.flat()
  if (records.length === 0) throw new Error('No MFI interest rate data found for the query.')

  const byDate = new Map<string, Row>()
  for (const record of records) {
    const value = record.OBS_VALUE
    const series = record._series_name as string
    if (value === null || value === undefined || !(series in MIR_SERIES)) continue
    const date = record.date as string
    let row = byDate.get(date)
    if (!row) byDate.set(date, (row = { date }))
    row[series] = Number(value)
  }
  if (byDate.size === 0) throw new Error('No MFI interest rate data found for the query.')
  return [...byDate.values()].sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
}

// --- fixedincome/rate/estr

const PERCENT_FIELDS = new Set(['rate', 'percentile_25', 'percentile_75', 'large_bank_share_of_volume'])
const INT_FIELDS = new Set(['transactions', 'number_of_banks'])

export async function euroShortTermRate(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const records = await cachedRecords(ctx, 'estr', JSON.stringify({ start, end }), flag(params, 'use_cache', true), () => fetchSdmxData(ctx, 'EST', estKey(), { startDate: start, endDate: end }))
  if (records.length === 0) throw new Error('No €STR data found for the query.')

  const byDate = new Map<string, Row>()
  for (const record of records) {
    const dataType = record.DATA_TYPE_EST
    const field = typeof dataType === 'string' ? EST_DATA_TYPES[dataType] : undefined
    const value = record.OBS_VALUE
    if (field === undefined || value === null || value === undefined) continue
    const date = record.date as string
    let row = byDate.get(date)
    if (!row) byDate.set(date, (row = { date }))
    if (PERCENT_FIELDS.has(field)) row[field] = Number(value) / 100
    else if (INT_FIELDS.has(field)) row[field] = Math.trunc(Number(value))
    else row[field] = Number(value)
  }
  return [...byDate.values()].filter((r) => r.rate !== undefined).sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
}

// --- fixedincome/government/yield_curve

const RATING = { aaa: 'A', all_ratings: 'C' } as const
const YIELD_TYPE = { spot_rate: 'SR', instantaneous_forward: 'IF', par_yield: 'PY' } as const
const MATURITIES = ['month_3', 'month_6', ...Array.from({ length: 30 }, (_, i) => `year_${i + 1}`)]

/** The one key that covers every maturity, and the map from the series' data type to the maturity name. */
function yieldCurveKey(rating: keyof typeof RATING, type: keyof typeof YIELD_TYPE): { key: string; byDataType: Map<string, string> } {
  const yieldCode = YIELD_TYPE[type]
  const codes: [string, string][] = [['month_3', '3M'], ['month_6', '6M'], ...Array.from({ length: 30 }, (_, i): [string, string] => [`year_${i + 1}`, `${i + 1}Y`])]
  const byDataType = new Map(codes.map(([maturity, code]) => [`${yieldCode}_${code}`, maturity] as const))
  return { key: `B.U2.EUR.4F.G_N_${RATING[rating]}.SV_C_YM.${[...byDataType.keys()].join('+')}`, byDataType }
}

/** `maturity_years`: the standard model's computed field, "month_3" → 0.25, "year_10" → 10. */
function maturityYears(maturity: string): number | undefined {
  if (!maturity.includes('_')) return undefined
  const parts = maturity.split('_')
  let months = 0
  for (let i = 0; i < parts.length; i += 2) months += Number(parts[i + 1]) * (parts[i] === 'year' ? 12 : 1)
  return months / 12
}

/** The YYYY-MM-DD of a date as the standard model's validator reads it (pandas.to_datetime). */
function normalizeDate(raw: string): string {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`Unknown datetime string format, unable to parse: ${s}`)
  return new Date(t).toISOString().slice(0, 10)
}

export async function yieldCurve(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rating = (text(params, 'rating') ?? 'aaa') as keyof typeof RATING
  const type = (text(params, 'yield_curve_type') ?? 'spot_rate') as keyof typeof YIELD_TYPE
  if (!(rating in RATING) || !(type in YIELD_TYPE)) throw new Error(`Unsupported yield curve: rating=${rating}, yield_curve_type=${type}`)
  const { key, byDataType } = yieldCurveKey(rating, type)
  const requested = text(params, 'date')
  const dates = requested ? requested.split(',').map(normalizeDate) : [localDate(ctx.now())]
  const useCache = flag(params, 'use_cache', true)

  // A window of two weeks before each date, so a date without a fixing falls back to the one before it.
  const batches = await Promise.all(
    dates.map((date) => {
      const start = addDays(date, -14)
      const end = addDays(date, 1)
      return cachedRecords(ctx, 'yield_curve', JSON.stringify({ key, start, end }), useCache, () => fetchSdmxData(ctx, 'YC', key, { startDate: start, endDate: end }))
    }),
  )
  const seen = new Map<string, { date: string; maturity: string; rate: number }>()
  for (const record of batches.flat()) {
    const maturity = byDataType.get((record.series_key as string).split('.').at(-1)!)
    if (maturity && record.OBS_VALUE !== null && record.OBS_VALUE !== undefined) seen.set(`${record.date}|${maturity}`, { date: record.date as string, maturity, rate: record.OBS_VALUE as number })
  }
  const rows = [...seen.values()]
  if (rows.length === 0) throw new Error('The request was returned empty.')

  // For each requested date the latest date with data on or before it (`DatetimeIndex.asof`).
  const available = [...new Set(rows.map((r) => r.date))].sort()
  const nearest = new Set<string>()
  for (const date of dates) {
    const hit = available.filter((d) => d <= date).at(-1)
    if (hit !== undefined) nearest.add(hit)
  }
  return rows
    .filter((r) => nearest.has(r.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : MATURITIES.indexOf(a.maturity) - MATURITIES.indexOf(b.maturity)))
    .map((r) => ({ date: r.date, maturity: r.maturity, rate: r.rate / 100, maturity_years: maturityYears(r.maturity) }))
}
