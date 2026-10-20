// Ported from openbb_jodi/utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the source tables are held in
// memory (typed columns, numeric observations only) behind ctx.cache instead of parquet partitions under the user
// cache directory; the zip is read as a stream; ranges of a small file are requested in order so recordings replay.
import { zipMemberLines } from '../lib/zip.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { CODE_TO_COUNTRY, COUNTRIES, GAS_DOWNLOAD_URL, GAS_FILES_URL, GAS_START_YEAR, OIL_START_YEAR, OIL_TABLE_URLS } from './constants.js'

const DAY_MS = 24 * 3600 * 1000
/** The JODI web server answers 406 without a browser-like user agent. */
const HEADERS = { 'User-Agent': 'Mozilla/5.0' }
const DOWNLOAD_TIMEOUT_MS = 600_000
const MAX_RANGE_CONNECTIONS = 16
/** Python asks for 2 MiB ranges; 512 KiB keeps each recorded body of the small gas table under the fixture limit. */
const MIN_RANGE_CHUNK = 512 * 1024
/** Files above this are fetched as concurrent ranges (the server throttles per connection); smaller ones in order. */
const PARALLEL_FROM = 4 * 1024 * 1024

const EXPECTED_COLUMNS = ['REF_AREA', 'TIME_PERIOD', 'ENERGY_PRODUCT', 'FLOW_BREAKDOWN', 'UNIT_MEASURE', 'OBS_VALUE', 'ASSESSMENT_CODE']

// ---------------------------------------------------------------------------------------------------------------
// Download

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function requestRange(ctx: NativeCtx, url: string, start?: number, end?: number, validator?: string): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  const headers: Record<string, string> = { ...HEADERS }
  if (start !== undefined) {
    headers.Range = `bytes=${start}-${end}`
    // A mid-transfer file replacement returns 200 instead of a torn 206.
    if (validator) headers['If-Range'] = validator
  }
  const res = await ctx.http.response(url, { headers, timeoutMs: DOWNLOAD_TIMEOUT_MS })
  return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) }
}

/**
 * Download a file by byte ranges: the first range says how large it is, a large file's remaining ranges are fetched
 * concurrently, and any unusable range falls back to one plain request (`download`).
 */
async function download(ctx: NativeCtx, url: string): Promise<Uint8Array> {
  const first = await requestRange(ctx, url, 0, MIN_RANGE_CHUNK - 1)
  // Ranges are not supported: the first request returned the complete file.
  if (first.status === 200) return first.body
  if (first.status !== 206) throw new Error(`Failed to download ${url} -> Status Code: ${first.status}`)
  const parts = [first.body]
  const total = Number(/\/(\d+)\s*$/.exec(first.headers.get('content-range') ?? '')?.[1] ?? 0)

  if (total > PARALLEL_FROM) {
    const validator = first.headers.get('etag') ?? first.headers.get('last-modified') ?? undefined
    const remaining = total - first.body.length
    const size = Math.ceil(remaining / Math.min(MAX_RANGE_CONNECTIONS, Math.max(1, Math.ceil(remaining / MIN_RANGE_CHUNK))))
    const offsets: [number, number][] = []
    for (let start = first.body.length; start < total; start += size) offsets.push([start, Math.min(start + size, total) - 1])
    const got = await Promise.allSettled(offsets.map(([start, end]) => requestRange(ctx, url, start, end, validator)))
    const usable = got.every((g, i) => g.status === 'fulfilled' && g.value.status === 206 && g.value.body.length === offsets[i]![1] - offsets[i]![0] + 1)
    if (usable) return concat([...parts, ...got.map((g) => (g as PromiseFulfilledResult<{ body: Uint8Array }>).value.body)])
    // The range responses were unusable: one full request.
    const whole = await requestRange(ctx, url)
    if (whole.status !== 200) throw new Error(`Failed to download ${url} -> Status Code: ${whole.status}`)
    return whole.body
  }

  // A small file, in order: full-size ranges until one comes back short or past the end.
  let body = first.body
  for (let start = MIN_RANGE_CHUNK; body.length === MIN_RANGE_CHUNK && start < 1000 * MIN_RANGE_CHUNK; start += MIN_RANGE_CHUNK) {
    const next = await requestRange(ctx, url, start, start + MIN_RANGE_CHUNK - 1)
    if (next.status === 416) break
    if (next.status !== 206) throw new Error(`Failed to download ${url} -> Status Code: ${next.status}`)
    body = next.body
    parts.push(body)
  }
  return concat(parts)
}

/** A table's current download URL; the gas URL rotates per publication. */
async function resolveSourceUrl(ctx: NativeCtx, table: string): Promise<string> {
  if (table !== 'gas_world') return OIL_TABLE_URLS[table.replace(/^oil_/, '') as 'primary' | 'secondary']
  const info = await ctx.http.json<{ publicationId?: unknown; files?: { format?: string; ignore?: boolean; filename?: string }[] }>(GAS_FILES_URL, { headers: HEADERS })
  const file = (info.files ?? []).find((f) => f.format === 'CSV' && !f.ignore)
  if (!file) throw new Error('No CSV file is listed by the JODI-Gas publisher API.')
  return GAS_DOWNLOAD_URL.replace('{publication_id}', String(info.publicationId)).replace('{filename}', String(file.filename))
}

// ---------------------------------------------------------------------------------------------------------------
// Tables

/** One JODI world table: the numeric observations as columns, dimension codes as indexes into their dictionaries. */
export type JodiTable = {
  n: number
  areas: string[]
  products: string[]
  flows: string[]
  units: string[]
  area: Uint8Array
  product: Uint8Array
  flow: Uint8Array
  unit: Uint8Array
  /** Year * 12 + month - 1. */
  period: Uint16Array
  value: Float64Array
}

type TypedColumn = Uint8Array | Uint16Array | Float64Array

function grow<T extends TypedColumn>(a: T, capacity: number): T {
  const b = new (a.constructor as new (n: number) => T)(capacity)
  b.set(a)
  return b
}

/** Parse the archive's CSV (clean_chunk and ingest_table: the columns are checked, non-numeric observations dropped). */
export function ingestTable(zip: Uint8Array): JodiTable {
  const dicts = { area: new Map<string, number>(), product: new Map<string, number>(), flow: new Map<string, number>(), unit: new Map<string, number>() }
  const code = (d: Map<string, number>, key: string): number => {
    let i = d.get(key)
    if (i === undefined) {
      i = d.size
      if (i > 255) throw new Error('Unexpected JODI file format. -> more than 256 distinct codes in one column')
      d.set(key, i)
    }
    return i
  }
  let cap = 1 << 20
  let n = 0
  let area = new Uint8Array(cap)
  let product = new Uint8Array(cap)
  let flow = new Uint8Array(cap)
  let unit = new Uint8Array(cap)
  let period = new Uint16Array(cap)
  let value = new Float64Array(cap)
  let header = true
  const member = zipMemberLines(
    zip,
    (name) => name.toLowerCase().endsWith('.csv'),
    (line) => {
      if (line === '') return
      if (header) {
        header = false
        const f = line.split(',')
        if (f.length !== EXPECTED_COLUMNS.length || f.some((c, i) => c.trim() !== EXPECTED_COLUMNS[i])) {
          throw new Error(`Unexpected JODI file format. Expected columns: ${JSON.stringify(EXPECTED_COLUMNS)} Got: ${JSON.stringify(f)}`)
        }
        return
      }
      // OBS_VALUE sits between the last two commas; most rows of the oil tables are "-" or "x", so look there first.
      const last = line.lastIndexOf(',')
      const raw = line.slice(line.lastIndexOf(',', last - 1) + 1, last)
      const v = raw.trim() === '' ? Number.NaN : Number(raw)
      // to_numeric(errors="coerce") then notna(): "-", "x" and the like are not observations.
      if (Number.isNaN(v)) return
      const f = line.split(',')
      if (f.length !== EXPECTED_COLUMNS.length) throw new Error(`Unexpected JODI file format. -> expected ${EXPECTED_COLUMNS.length} fields, got ${f.length} in: ${line.slice(0, 80)}`)
      const t = f[1]!
      const p = Number(t.slice(0, 4)) * 12 + Number(t.slice(5, 7)) - 1
      if (n === cap) {
        cap *= 2
        area = grow(area, cap)
        product = grow(product, cap)
        flow = grow(flow, cap)
        unit = grow(unit, cap)
        period = grow(period, cap)
        value = grow(value, cap)
      }
      area[n] = code(dicts.area, f[0]!)
      product[n] = code(dicts.product, f[2]!)
      flow[n] = code(dicts.flow, f[3]!)
      unit[n] = code(dicts.unit, f[4]!)
      period[n] = p
      value[n] = v
      n++
    },
  )
  if (member === undefined) throw new Error('No CSV member was found in the JODI archive.')
  if (n === 0) throw new Error('The JODI source file contains no observations.')
  return { n, areas: [...dicts.area.keys()], products: [...dicts.product.keys()], flows: [...dicts.flow.keys()], units: [...dicts.unit.keys()], area, product, flow, unit, period, value }
}

/** A table by name (`oil_primary`, `oil_secondary`, `gas_world`), downloaded once a day (`ensure_table`). */
export function getTable(ctx: NativeCtx, table: string, useCache: boolean): Promise<JodiTable> {
  const load = async (): Promise<JodiTable> => ingestTable(await download(ctx, await resolveSourceUrl(ctx, table)))
  return useCache ? ctx.cache(`jodi:${table}`, DAY_MS, load) : load()
}

// ---------------------------------------------------------------------------------------------------------------
// Query parameters

export function normalizeCountryNames(v: unknown): string[] {
  const items = Array.isArray(v) ? v : String(v).split(',')
  const out: string[] = []
  for (const item of items) {
    const country = String(item).trim().toLowerCase().replace(/ /g, '_')
    if (country in COUNTRIES) out.push(country)
    else if (country.toUpperCase() in CODE_TO_COUNTRY) out.push(CODE_TO_COUNTRY[country.toUpperCase()]!)
    else throw new Error(`Invalid country: '${String(item)}'. Valid values are: ${JSON.stringify(Object.keys(COUNTRIES))}`)
  }
  return [...new Set(out)]
}

/** The country codes asked for: one country (`multiple` false, defaulting to the given one) or any number, or all (undefined). */
export function countryCodes(params: NativeParams, multiple: boolean, fallback: string | undefined): Set<string> | undefined {
  const v = params.country
  const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  const names = empty ? (fallback === undefined ? [] : [fallback]) : normalizeCountryNames(v)
  if (!multiple && names.length > 1) throw new Error('Only one country can be selected for this endpoint.')
  return names.length === 0 ? undefined : new Set(names.map((c) => COUNTRIES[c]!))
}

/** A single-select token: trimmed, lower-cased, spaces to underscores, and one of the choices. */
export function token(params: NativeParams, name: string, choices: readonly string[], fallback: string): string {
  const raw = params[name]
  const value = raw === undefined || raw === '' || raw === false ? fallback : String(raw).trim().toLowerCase().replace(/ /g, '_')
  if (!choices.includes(value)) throw new Error(`Invalid ${name}: '${value}'. Valid values are: ${JSON.stringify(choices)}`)
  return value
}

/** The date range with the full-history default; both ends as YYYY-MM-DD. */
export function resolveDateRange(params: NativeParams, ctx: NativeCtx, startYear: number): { start: string; end: string } {
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : `${startYear}-01-01`
  const end = typeof params.end_date === 'string' && params.end_date ? params.end_date : ctx.now().toISOString().slice(0, 10)
  if (start > end) throw new Error('The start_date must be on, or before, the end_date.')
  return { start, end }
}

const monthIndex = (isoDate: string): number => Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1

// ---------------------------------------------------------------------------------------------------------------
// Slices and pivots

/** One observation: country code, period (YYYY-MM), product code, flow code, value. */
export type Observation = { area: string; period: string; product: string; flow: string; value: number }

export type Filter = {
  countries?: Set<string> | undefined
  products?: Set<string> | undefined
  flows: Set<string>
  units: Set<string>
}

const periodText = (p: number): string => `${String(Math.floor(p / 12)).padStart(4, '0')}-${String((p % 12) + 1).padStart(2, '0')}`

/** `load_partitions` and `apply_filters`: the observations of a table for the codes and months asked for. */
export function selectObservations(table: JodiTable, f: Filter, start: string, end: string): Observation[] {
  const mask = (names: string[], wanted: Set<string> | undefined): Uint8Array | undefined => (wanted ? Uint8Array.from(names, (x) => (wanted.has(x) ? 1 : 0)) : undefined)
  const area = mask(table.areas, f.countries)
  const product = mask(table.products, f.products)
  const flow = mask(table.flows, f.flows)
  const unit = mask(table.units, f.units)
  const lo = monthIndex(start)
  const hi = monthIndex(end)
  const out: Observation[] = []
  for (let i = 0; i < table.n; i++) {
    const p = table.period[i]!
    if (p < lo || p > hi) continue
    if (area && !area[table.area[i]!]) continue
    if (flow && !flow[table.flow[i]!]) continue
    if (unit && !unit[table.unit[i]!]) continue
    if (product && !product[table.product[i]!]) continue
    out.push({ area: table.areas[table.area[i]!]!, period: periodText(p), product: table.products[table.product[i]!]!, flow: table.flows[table.flow[i]!]!, value: table.value[i]! })
  }
  if (out.length === 0) throw new Error('No results were found with the given query parameters.')
  return out
}

/** `_to_wide`: one row per month, the first observation per column, columns in the given order (those with data). */
function toWide(obs: Observation[], columnOf: (o: Observation) => string, order: string[]): Row[] {
  const byPeriod = new Map<string, Map<string, number>>()
  const present = new Set<string>()
  for (const o of obs) {
    const column = columnOf(o)
    present.add(column)
    const row = byPeriod.get(o.period) ?? new Map<string, number>()
    if (!row.has(column)) row.set(column, o.value)
    byPeriod.set(o.period, row)
  }
  const columns = order.filter((c) => present.has(c))
  return [...byPeriod.keys()].sort().map((period) => {
    const cells = byPeriod.get(period)!
    const row: Row = { date: `${period}-01` }
    for (const c of columns) if (cells.has(c)) row[c] = cells.get(c)
    return row
  })
}

/** `build_field_table`: date rows with one field per item code (flow or product), in the map's order. */
export function buildFieldTable(obs: Observation[], codeColumn: 'flow' | 'product', fieldMap: Record<string, string>): Row[] {
  return toWide(obs, (o) => fieldMap[o[codeColumn]]!, [...new Set(Object.values(fieldMap))])
}

/** `build_country_table`: date rows with one field per country, alphabetical. */
export function buildCountryTable(obs: Observation[]): Row[] {
  const name = (o: Observation): string => CODE_TO_COUNTRY[o.area] ?? o.area
  return toWide(obs, name, [...new Set(obs.map(name))].sort())
}

/** The month range checks of `check_oil_dates` and `check_gas_dates`. */
export function checkDates(kind: 'Oil' | 'Gas', start: string, end: string): void {
  const first = kind === 'Oil' ? OIL_START_YEAR : GAS_START_YEAR
  if (Number(end.slice(0, 4)) < first) throw new Error(`No JODI-${kind} data is available between ${start} and ${end}. The data starts in ${first}.`)
}
