// federal_reserve/stl/fred_md, fred_qd and national_index, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/{st_louis_fred_panel,st_louis_indexes}.py and utils/st_louis.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas and pydantic, no curl_cffi session (the
// St. Louis Fed answers plain requests), ctx.cache instead of the on-disk cache.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { readCsv, strptime, toDate } from './frame.js'
import { bool, DAY_MS, EmptyDataError, list, request, str } from './helpers.js'
import { coerceNumber } from './series.js'

const FRED_GRAPH_URL = (id: string) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`
const FRED_MD_URL = 'https://www.stlouisfed.org/-/media/project/frbstl/stlouisfed/research/fred-md/monthly/current.csv'
const FRED_QD_URL = 'https://www.stlouisfed.org/-/media/project/frbstl/stlouisfed/research/fred-md/quarterly/current.csv'

const fetchText = (ctx: NativeCtx, url: string): Promise<string> => ctx.cache(`fed:file:${url}`, DAY_MS, () => ctx.http.text(url, request({ timeoutMs: 180_000 })))

type Num = number | null

/** `shift(1)` then `diff()` on a column. */
const diff = (xs: Num[]): Num[] => xs.map((x, i) => (i === 0 || x === null || xs[i - 1] === null ? null : x - xs[i - 1]!))

/** FRED-MD's transformation codes (`_apply_transform`). */
function applyTransform(series: Num[], code: number | null): Num[] {
  if (code === 7) {
    const growth = series.map((x, i) => (i === 0 || x === null || series[i - 1] === null ? null : x / series[i - 1]! - 1))
    return diff(growth)
  }
  let c = code
  let s = series
  if (c === 4 || c === 5 || c === 6) {
    s = s.map((x) => (x === null ? null : Math.log(x)))
    c -= 3
  }
  if (c === 2) return diff(s)
  if (c === 3) return diff(diff(s))
  return s
}

async function panel(params: NativeParams, ctx: NativeCtx, url: string, transformRow: number, dataStart: number): Promise<Row[]> {
  const text = await fetchText(ctx, url)
  if (!text) throw new EmptyDataError('The request was returned empty.')
  const frame = readCsv(text)
  const columns = frame.columns.map((c) => (c === 'sasdate' ? 'date' : c))
  const cell = (r: (typeof frame.rows)[number], col: string) => r[col === 'date' ? 'sasdate' : col] ?? null
  const codeRow = frame.rows[transformRow]!
  const codes = new Map<string, number | null>()
  for (const c of columns) {
    if (c === 'date') continue
    const v = cell(codeRow, c)
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    codes.set(c, Number.isFinite(n) ? Math.trunc(n) : null)
  }
  const body = frame.rows.slice(dataStart).filter((r) => {
    const d = cell(r, 'date')
    return d !== null && String(d).trim() !== ''
  })
  const dates = body.map((r) => {
    const d = strptime(String(cell(r, 'date')), '%m/%d/%Y')
    if (d === undefined) throw new Error(`time data "${String(cell(r, 'date'))}" doesn't match format "%m/%d/%Y"`)
    return d
  })
  const filter = list(params, 'series')
  const valueColumns = columns.filter((c) => c !== 'date' && (filter.length === 0 || filter.includes(c)))
  const apply = bool(params, 'transform', false)
  const values = new Map<string, Num[]>()
  for (const c of valueColumns) {
    // `.replace(".", None)` then `to_numeric(errors="coerce")`.
    let col: Num[] = body.map((r) => {
      const v = cell(r, c)
      return v === '.' ? null : coerceNumber(v)
    })
    if (apply) col = applyTransform(col, codes.get(c) ?? null)
    values.set(c, col)
  }
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const order = dates.map((_, i) => i).sort((a, b) => (dates[a]! < dates[b]! ? -1 : dates[a]! > dates[b]! ? 1 : a - b))
  const out: Row[] = []
  for (const i of order) {
    const date = dates[i]!
    if ((start && date < start) || (end && date > end)) continue
    const row: Row = { date }
    let any = false
    for (const c of valueColumns) {
      const v = values.get(c)![i]
      if (v !== null && v !== undefined && !Number.isNaN(v)) {
        row[c] = v
        any = true
      }
    }
    if (any) out.push(row)
  }
  if (out.length === 0) throw new EmptyDataError('The request was returned empty.')
  return out
}

export const fredMd = (params: NativeParams, ctx: NativeCtx) => panel(params, ctx, FRED_MD_URL, 0, 1)
export const fredQd = (params: NativeParams, ctx: NativeCtx) => panel(params, ctx, FRED_QD_URL, 1, 2)

const INDEX_SERIES: Record<string, string> = { financial_stress_index: 'STLFSI4', price_pressures: 'STLPPM', economic_news_index: 'STLENI' }

export async function nationalIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const requested = list(params, 'index')
  const selected = (requested.length ? requested : Object.keys(INDEX_SERIES)).filter((n) => n in INDEX_SERIES)
  const texts = await Promise.all(selected.map((n) => fetchText(ctx, FRED_GRAPH_URL(INDEX_SERIES[n]!))))
  const frames = selected.flatMap((name, i) => {
    if (!texts[i]) return []
    const f = readCsv(texts[i]!)
    const [dateCol, valueCol] = f.columns
    const points = new Map<string, number | null>()
    for (const r of f.rows) {
      const d = toDate(r[dateCol!]!)
      if (d === undefined) throw new Error(`time data "${String(r[dateCol!])}" does not match`)
      const v = r[valueCol!]
      points.set(d, v === '.' ? null : coerceNumber(v))
    }
    return [{ name, points }]
  })
  if (frames.length === 0) throw new EmptyDataError('The request was returned empty.')
  // Outer merge on the date.
  const dates = [...new Set(frames.flatMap((f) => [...f.points.keys()]))].sort()
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const out: Row[] = []
  for (const date of dates) {
    if ((start && date < start) || (end && date > end)) continue
    const row: Row = { date }
    let any = false
    for (const f of frames) {
      const v = f.points.get(date)
      if (v !== undefined && v !== null) {
        row[f.name] = v
        any = true
      }
    }
    if (any) out.push(row)
  }
  if (out.length === 0) throw new EmptyDataError('The request was returned empty.')
  return out
}
