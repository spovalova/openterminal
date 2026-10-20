// economy/survey/bls_search, provider bls. Ported from openbb_bls/models/search.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: the series catalog is read from BLS's flat files (metadata.ts) instead of the bundled
// bls_cache.zip, and the categories whose files are too large to read at request time (pce, lfs, wages, tu) are
// left to the OpenBB API through NativeUnsupported. The code map (`include_code_map`) travels beside the rows in
// OpenBB and is not part of them, so it is not returned here.
import { type NativeCtx, NativeUnsupported, type NativeHandler, type NativeParams, type Row } from '../types.js'
import { str } from './helpers.js'
import { categoryCatalog, HUGE_SURVEYS, SURVEY_CATEGORY_MAP } from './metadata.js'

const BLANK_TITLE = new Set(['', 'nan', 'none', 'null', '-'])
/** Descriptive columns, in reading order, from which a title is built for series BLS lists without one. */
const TITLE_FIELDS = ['sector_code', 'industry_code', 'region_code', 'state_code', 'area_code', 'item_code', 'dataelement_code', 'measure_code', 'ratelevel_code', 'sizeclass_code', 'duration_code']
const SEASONAL_LABEL: Record<string, string> = { S: 'seasonally adjusted', U: 'not seasonally adjusted' }

type Rec = Record<string, string | null>

const isBlankTitle = (v: string | null | undefined): boolean => v === null || v === undefined || BLANK_TITLE.has(String(v).trim().toLowerCase())

/** A readable title from a row's resolved descriptive columns (`_synthesize_title`). */
function synthesizeTitle(row: Rec): string | null {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const key of TITLE_FIELDS) {
    const value = row[key]
    if (isBlankTitle(value)) continue
    const text = String(value).trim()
    if (!seen.has(text)) {
      seen.add(text)
      parts.push(text)
    }
  }
  let title = parts.join(' — ')
  const label = SEASONAL_LABEL[String(row.seasonal ?? '').trim().toUpperCase()]
  if (label) title = title ? `${title} (${label})` : label.charAt(0).toUpperCase() + label.slice(1).toLowerCase()
  return title || null
}

async function blsSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const category = str(params.category)
  if (!category) throw new Error('A BLS category is required.')
  const surveys = SURVEY_CATEGORY_MAP[category]
  if (!surveys) throw new Error(`Unknown BLS category '${category}'. Choose from ${Object.keys(SURVEY_CATEGORY_MAP).sort().join(', ')}.`)
  if (surveys.some((sv) => HUGE_SURVEYS.has(sv))) throw new NativeUnsupported(`bls_search: the '${category}' series listing is too large to read at request time`)

  const catalog = await categoryCatalog(ctx, category)
  const query = typeof params.query === 'string' ? params.query : ''
  const terms = query ? query.split(';').map((t) => t.trim()) : []
  let matches = catalog.rows
  if (terms.length > 0) {
    const patterns = terms.map((t) => new RegExp(t, 'i'))
    // pandas' astype(str) turns a missing cell into "None", which a pattern can match.
    matches = matches.filter((row) => patterns.every((re) => catalog.columns.some((c) => re.test(row[c] ?? 'None'))))
    if (matches.length === 0) throw new Error('No results found for the provided query.')
  }

  // Fill in a title for series BLS lists without one.
  let columns = catalog.columns
  if (!columns.includes('series_title')) columns = [...columns, 'series_title']
  let rows: Rec[] = matches.map((row) => (isBlankTitle(row.series_title) ? { ...row, series_title: synthesizeTitle(row) } : row))

  // Rank current series above discontinued ones: end_year, then end_period, newest first, then series_id.
  if (columns.includes('end_year')) {
    const hasPeriod = columns.includes('end_period')
    const recency = (r: Rec): number => (r.end_year && /^\s*\d+(\.\d+)?\s*$/.test(r.end_year) ? Number(r.end_year) : 0)
    rows = [...rows].sort((a, b) => {
      if (recency(a) !== recency(b)) return recency(b) - recency(a)
      if (hasPeriod) {
        const pa = a.end_period
        const pb = b.end_period
        if (pa !== pb) {
          if (pa === null || pa === undefined) return 1
          if (pb === null || pb === undefined) return -1
          return pa < pb ? 1 : -1
        }
      }
      const sa = a.series_id ?? ''
      const sb = b.series_id ?? ''
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
  }

  const extras = params.include_extras === true || params.include_extras === 'true'
  return rows.map((r) => {
    if (extras) {
      const { series_id, series_title, ...rest } = r
      const out: Row = { symbol: series_id, title: series_title }
      for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) out[k] = v
      return out
    }
    return { symbol: r.series_id, title: r.series_title, survey_name: r.survey_name }
  })
}

export const searchRoutes: Record<string, NativeHandler> = {
  'economy/survey/bls_search': blsSearch,
}
