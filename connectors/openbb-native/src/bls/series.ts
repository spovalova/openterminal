// economy/survey/bls_series, provider bls. Ported from openbb_bls/models/series.py and utils/helpers.py
// (get_bls_timeseries) (OpenBB Platform 5.0.0, Apache-2.0); modified: the series' first year (used when no
// start_date is given) comes from BLS's flat series files instead of the bundled cache, and the requests of
// the chunks run one after the other.
import { MissingCredential, type NativeCtx, NativeUnsupported, type NativeHandler, type NativeParams, type Row } from '../types.js'
import { applyDateWindow, str } from './helpers.js'
import { HUGE_SURVEYS, SURVEY_CATEGORY_MAP, surveySeries } from './metadata.js'

const API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/'

type BlsPoint = { year?: string; period?: string; value?: string; latest?: string; footnotes?: ({ text?: string } | string | null)[]; calculations?: { net_changes?: Record<string, string | undefined>; pct_changes?: Record<string, string | undefined> } }
type BlsResponse = { Results?: { series?: { seriesID?: string; catalog?: { series_title?: string }; data?: BlsPoint[] }[] }; message?: string[] }

/** `float(x)` for the strings BLS returns; a missing or empty value is null. */
const num = (v: string | undefined): number | null => {
  if (!v) return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

/** The earliest `begin_year` among the symbols in the category's catalog (`_earliest_begin_year`). */
async function earliestBeginYear(ctx: NativeCtx, symbols: string[], category: string): Promise<number | null> {
  const surveys = SURVEY_CATEGORY_MAP[category]
  if (!surveys || symbols.length === 0) return null
  const wanted = new Set(symbols)
  const needed = surveys.filter((sv) => symbols.some((s) => s.toLowerCase().startsWith(sv)))
  if (needed.some((sv) => HUGE_SURVEYS.has(sv))) throw new NativeUnsupported(`bls_series: the ${needed.join('/')} series listing is too large to read; pass start_date`)
  let min: number | null = null
  for (const sv of needed) {
    for (const row of await surveySeries(ctx, sv)) {
      if (!row.series_id || !wanted.has(row.series_id) || !row.begin_year || !/^\d+$/.test(row.begin_year)) continue
      const y = Number(row.begin_year)
      if (min === null || y < min) min = y
    }
  }
  return min
}

/** BLS's period codes as the date OpenBB gives them, and whether the point is an annual average. */
function pointDate(year: string, period: string): { date: string; annual: boolean } {
  let month = period.replace('M', '')
  let date: string
  if (month.startsWith('A') || month === 'S01' || month === 'Q01') date = `${year}-01-01`
  else if (month === 'S02') date = `${year}-07-01`
  else if (month === 'S03' || month === 'Q05') {
    date = `${year}-12-31`
    month = '13'
  } else if (month === 'Q02') date = `${year}-04-01`
  else if (month === 'Q03') date = `${year}-07-01`
  else if (month === 'Q04') date = `${year}-10-01`
  else date = month === '13' ? `${year}-12-31` : `${year}-${month}-01`
  return { date, annual: month === '13' }
}

/** One request to BLS's API, parsed into rows (`get_bls_timeseries`). */
async function timeseries(ctx: NativeCtx, apiKey: string, symbols: string[], startYear: number, endYear: number, p: { calculations: boolean; annualAverage: boolean; aspects: boolean }): Promise<{ rows: Row[]; messages: string[] }> {
  const payload = Object.fromEntries(
    Object.entries({ seriesid: symbols.slice(0, 50), startyear: startYear, endyear: endYear, catalog: true, calculations: p.calculations, annualaverage: p.annualAverage, aspects: p.aspects, registrationkey: apiKey }).filter(([, v]) => v),
  )
  const res = await ctx.http.json<BlsResponse>(API_URL, { method: 'POST', headers: { 'Content-type': 'application/json' }, body: JSON.stringify(payload) })
  const messages = (res.message ?? []).filter(Boolean).map((m) => (m.startsWith('The key:') ? `The key provided by the User is invalid. ${m.split(' provided by the User is invalid.')[1]?.trim() ?? ''}` : m))
  const rows: Row[] = []
  for (const series of res.Results?.series ?? []) {
    const symbol = series.seriesID
    if (!symbol) continue
    const seriesTitle = series.catalog ? series.catalog.series_title : undefined
    for (const d of series.data ?? []) {
      const { date, annual } = pointDate(d.year ?? '', d.period ?? '')
      const out: Row = { symbol }
      const title = series.catalog && seriesTitle ? seriesTitle + (annual ? ' (Annual Average)' : '') : undefined
      if (title) out.title = title
      out.date = date
      out.value = d.value && d.value !== '-' ? Number(d.value) : null
      out.latest = d.latest === 'true'
      const footnotes = (d.footnotes ?? []).filter((f) => f && !(typeof f === 'object' && Object.keys(f).length === 0)).map((f) => (typeof f === 'object' && f !== null ? f.text : String(f)))
      if (footnotes.length > 0) {
        const joined = footnotes.join('; ')
        if (joined) out.footnotes = joined
      }
      const calcs = d.calculations
      if (calcs) {
        const { net_changes: changes, pct_changes: pct } = calcs
        if (changes) for (const k of ['1', '3', '6', '12']) out[`change_${k}M`] = num(changes[k])
        if (pct) for (const k of ['1', '3', '6', '12']) out[`change_percent_${k}M`] = pct[k] ? Number(pct[k]) / 100 : null
      }
      rows.push(out)
    }
  }
  return { rows, messages }
}

async function blsSeries(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The fetcher does not set require_credentials = False, so OpenBB refuses the call without a key.
  const apiKey = ctx.credential('bls_api_key')
  if (!apiKey) throw new MissingCredential('bls', 'bls_api_key')
  const raw = params.symbol
  const symbols = (Array.isArray(raw) ? raw.flatMap((s) => String(s).split(',')) : String(raw ?? '').split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean)
  const category = str(params.category) ?? 'cpi'
  const startDate = str(params.start_date)
  const endDate = str(params.end_date)
  const flag = (v: unknown, dflt: boolean): boolean => (v === undefined ? dflt : v === true || v === 'true')
  const now = ctx.now()

  // No start date: the series' whole published history, or 20 years when the catalog does not know them.
  const startYear = startDate ? Number(startDate.slice(0, 4)) : ((await earliestBeginYear(ctx, symbols, category)) ?? new Date(now.getTime() - 52 * 20 * 7 * 86_400_000).getUTCFullYear())
  const endYear = endDate ? Number(endDate.slice(0, 4)) : now.getUTCFullYear()
  // Per-request limits with a key: 50 series and 20 years.
  const maxSymbols = 50
  const maxYears = 20
  const opts = { calculations: flag(params.calculations, true), annualAverage: flag(params.annual_average, false), aspects: flag(params.aspects, false) }

  const rows: Row[] = []
  const messages = new Set<string>()
  for (let i = 0; i < symbols.length; i += maxSymbols) {
    const chunk = symbols.slice(i, i + maxSymbols)
    for (let y = startYear; y <= endYear; y += maxYears) {
      const got = await timeseries(ctx, apiKey, chunk, y, Math.min(y + maxYears - 1, endYear), opts)
      rows.push(...got.rows)
      for (const m of got.messages) messages.add(m)
    }
  }
  if (rows.length === 0) {
    if (messages.size > 0) throw new Error([...messages].join(','))
    throw new Error('The request was returned empty.')
  }
  const sorted = rows.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : (a.symbol as string) < (b.symbol as string) ? -1 : (a.symbol as string) > (b.symbol as string) ? 1 : 0))
  return applyDateWindow(sorted, startDate, endDate)
}

export const seriesRoutes: Record<string, NativeHandler> = {
  'economy/survey/bls_series': blsSeries,
}
