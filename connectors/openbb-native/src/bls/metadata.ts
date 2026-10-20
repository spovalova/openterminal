// The BLS series catalog, rebuilt from BLS's flat files. Ported from openbb_bls/utils/generate_cache.py and
// utils/metadata/_core.py (OpenBB Platform 5.0.0, Apache-2.0); modified: OpenBB ships the result as a 10 MB
// bls_cache.zip built from https://download.bls.gov/pub/time.series/ in September 2026; here the same files are
// read when a route needs them (memoised through ctx.cache), so the catalog is as current as BLS's files.
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx } from '../types.js'
import { BLS_USER_AGENT } from './helpers.js'

const BASE = 'https://download.bls.gov/pub/time.series'
const DAY_MS = 24 * 3600 * 1000

/** Surveys of each category (the cache's index.json). */
export const SURVEY_CATEGORY_MAP: Record<string, string[]> = {
  cpi: ['ap', 'cu', 'cw', 'li', 'su'],
  ixp: ['ei'],
  pce: ['cx'],
  ppi: ['wp', 'pc'],
  ip: ['ip', 'pr', 'mp'],
  jolts: ['jl', 'jt'],
  nfp: ['ce'],
  cps: ['le', 'lu'],
  lfs: ['ln', 'fm', 'in', 'ws'],
  wages: ['ci', 'wm'],
  ec: ['cm', 'cc'],
  sla: ['la', 'sm'],
  bed: ['bd'],
  tu: ['tu'],
}

export const SURVEY_NAMES: Record<string, string> = {
  AP: 'Consumer Price Index - Average Price Data',
  BD: 'Business Employment Dynamics',
  CC: 'Employer Costs for Employee Compensation',
  CE: 'Current Employment Statistics (National)',
  CI: 'Employment Cost Index',
  CM: 'Employer Costs for Employee Compensation',
  CU: 'Consumer Price Index - All Urban Consumers',
  CW: 'Consumer Price Index - Urban Wage Earners and Clerical Workers',
  CX: 'Consumer Expenditure Survey',
  EI: 'Import/Export Price Indexes',
  FM: 'Current Population Survey - Marital and Family Labor Force',
  IN: 'International Labor Comparisons',
  IP: 'Industry Productivity',
  JL: 'Job Openings and Labor Turnover Survey',
  JT: 'Job Openings and Labor Turnover Survey',
  LA: 'Local Area Unemployment Statistics',
  LE: 'Current Population Survey - Weekly and Hourly Earnings',
  LI: 'Consumer Price Index - Department Store Inventory Price Index',
  LN: 'Labor Force Statistics from the Current Population Survey',
  LU: 'Current Population Survey - Union Affiliation',
  MP: 'Major Sector Total Factor Productivity',
  PC: 'Producer Price Index - Industry',
  PR: 'Major Sector Productivity and Costs',
  SM: 'State and Area Employment, Hours, and Earnings',
  SU: 'Consumer Price Index - Chained (C-CPI-U)',
  TU: 'American Time Use Survey',
  WM: 'Modeled Wage Estimates',
  WP: 'Producer Price Index - Commodity',
  WS: 'Work Stoppages',
}

/** Flat files too large to read at request time (31, 15, 108 and 24 MB): the API answers these. */
export const HUGE_SURVEYS = new Set(['cx', 'ln', 'wm', 'tu'])

type Tsv = Record<string, string | null>[]

/** pandas' default NA strings: read_csv turns these into missing values. */
const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])

/** `_parse_tsv`: stripped headers and values; blank, quote-only and "nan" values are null. */
function parseTsv(text: string): Tsv {
  const [header, ...rows] = parseCsv(text, '\t')
  if (!header) return []
  const names = header.map((h) => h.trim())
  return rows.map((r) => {
    const out: Record<string, string | null> = {}
    names.forEach((n, i) => {
      const v = r[i]?.trim()
      out[n] = v === undefined || v === '' || v === "''" || v === '""' || v === 'nan' ? null : v
    })
    return out
  })
}

async function fetchTsv(ctx: NativeCtx, survey: string, asset: string): Promise<Tsv | null> {
  return ctx.cache(`bls:tsv:${survey}.${asset}`, DAY_MS, async () => {
    const res = await ctx.http.response(`${BASE}/${survey}/${survey}.${asset}`, { headers: { 'User-Agent': BLS_USER_AGENT, Accept: 'text/plain, */*' }, timeoutMs: 120_000 })
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${BASE}/${survey}/${survey}.${asset}`)
    const text = await res.text()
    return text.trim() ? parseTsv(text) : null
  })
}

/** One survey's series listing as BLS publishes it (no resolved labels). */
export async function surveySeries(ctx: NativeCtx, survey: string): Promise<Tsv> {
  return (await fetchTsv(ctx, survey, 'series')) ?? []
}

/** `{dim_code: {code: label}}` for the code columns of a survey's listing (`_build_code_map`). */
async function buildCodeMap(ctx: NativeCtx, survey: string, codeColumns: string[]): Promise<Record<string, Record<string, string>>> {
  const codeMap: Record<string, Record<string, string>> = {}
  for (const codeCol of codeColumns) {
    const dim = codeCol.replace(/_code$/, '')
    const rows = await fetchTsv(ctx, survey, dim === 'data' ? 'datatype' : dim)
    if (!rows || rows.length === 0) continue
    const resolvedDim = dim === 'data' && survey === 'ce' ? 'data_type' : dim
    const labels: Record<string, string> = {}
    for (const row of rows) {
      const code = row[`${dim}_code`]
      const label = row[`${dim}_name`] || row[`${dim}_text`] || row[`${dim}_title`]
      if (code === null || code === undefined) continue
      labels[code] = label ? label : code
    }
    if (Object.keys(labels).length > 0) codeMap[`${resolvedDim}_code`] = labels
  }
  return codeMap
}

/** Replace each `{dim}_code` value with its label when known (`_resolve_codes`). */
function resolveCodes(row: Record<string, string | null>, codeMap: Record<string, Record<string, string>>): Record<string, string | null> {
  const out = { ...row }
  for (const [col, labels] of Object.entries(codeMap)) {
    const raw = out[col]
    if (raw === undefined || raw === null) continue
    if (raw.includes(',') && /\d/.test(raw)) out[col] = raw.split(',').map((p) => labels[p] ?? p).filter(Boolean).join(' ')
    else out[col] = labels[raw] ?? raw
  }
  return out
}

export type Catalog = {
  /** Columns in the cache's order, without the all-empty ones. */
  columns: string[]
  /** Cells are null where pandas would read a missing value. */
  rows: Record<string, string | null>[]
  /** Per survey: `{dim_code: {code: label}}`. */
  codes: Record<string, Record<string, Record<string, string>>>
}

/** Every series of a category with code columns resolved to labels (`fetch_category` + `BlsMetadata.get_series`). */
export function categoryCatalog(ctx: NativeCtx, category: string): Promise<Catalog> {
  const surveys = SURVEY_CATEGORY_MAP[category]
  if (!surveys) throw new Error(`Unknown BLS category '${category}'. Choose from ${Object.keys(SURVEY_CATEGORY_MAP).sort().join(', ')}.`)
  return ctx.cache(`bls:catalog:${category}`, DAY_MS, async () => {
    const rows: Record<string, string | null>[] = []
    const codes: Catalog['codes'] = {}
    for (const survey of surveys) {
      const series = await fetchTsv(ctx, survey, 'series')
      if (!series || series.length === 0) continue
      const codeColumns = [...new Set(series.flatMap((r) => Object.keys(r)).filter((c) => c.endsWith('_code') && !c.includes('periodicity')))].sort()
      const codeMap = await buildCodeMap(ctx, survey, codeColumns)
      if (Object.keys(codeMap).length > 0) codes[survey] = codeMap
      const surveyName = SURVEY_NAMES[survey.toUpperCase()] ?? survey.toUpperCase()
      for (const raw of series) {
        const sid = raw.series_id
        if (typeof sid !== 'string' || !sid.toUpperCase().startsWith(survey.toUpperCase())) continue
        rows.push({ ...resolveCodes(raw, codeMap), survey_name: surveyName })
      }
    }
    // The cache writes a CSV without all-empty columns, and pandas reads its NA strings back as missing values.
    const seen = new Set<string>()
    const columns: string[] = []
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) {
      seen.add(k)
      columns.push(k)
    }
    const normalised = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] === undefined || r[c] === null || PANDAS_NA.has(r[c]!) ? null : r[c]!])))
    const keep = columns.filter((c) => normalised.some((r) => r[c] !== null))
    return { columns: keep, rows: normalised.map((r) => Object.fromEntries(keep.map((c) => [c, r[c]!]))), codes }
  })
}
