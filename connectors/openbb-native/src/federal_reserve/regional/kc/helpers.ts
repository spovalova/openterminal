// Shared by the Kansas City Fed routes, provider federal_reserve. Ported from openbb_federal_reserve/utils/kansas_city.py
// and kansas_city_ag.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain HTTPS requests through ctx.http (the Python
// code warms up a curl_cffi Chrome session for Akamai; the site answers plain requests), ctx.cache instead of the on-disk
// cache, and plain arrays instead of pandas frames.
import type { NativeCtx, NativeParams } from '../../../types.js'
import { isNa, readGrids, toNumeric, type Cell, type Grid } from '../workbook.js'

export const SITE_HOST = 'https://www.kansascityfed.org'
export const DATA_HOST = 'https://kcresearch-share.kansascityfed.org'
const INDEX_URL = `${SITE_HOST}/center-for-agriculture-and-the-economy/agricultural-data-and-indicators/`
const DAY_MS = 24 * 3600 * 1000

export const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)

/** A Kansas City Fed download, kept for a day. The site answers plain requests; a browser user agent without a browser's TLS hangs. */
export function download(ctx: NativeCtx, url: string): Promise<Uint8Array> {
  return ctx.cache(`kc:${url}`, DAY_MS, async () => {
    const bytes = await ctx.http.bytes(url, { headers: { referer: `${SITE_HOST}/` }, timeoutMs: 180_000 })
    if (bytes.length === 0) throw new Error('The request was returned empty.')
    return bytes
  })
}

/** The current (quarter-versioned) file URL of a stable document id, from the agricultural data index (`resolve_kc_ag_url`). */
export async function resolveKcAgUrl(ctx: NativeCtx, documentId: number): Promise<string> {
  const html = await ctx.cache('kc:ag-index', DAY_MS, async () => new TextDecoder().decode(await download(ctx, INDEX_URL)))
  const match = new RegExp(`/documents/${documentId}/[^"'\\s>]+\\.xlsx`).exec(html)
  if (!match) throw new Error(`Could not resolve Kansas City Ag document ${documentId} on the index.`)
  return SITE_HOST + match[0]
}

export function emptyData(): never {
  throw new Error('The request was returned empty.')
}

const QUARTER_END: Record<number, string> = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' }

/** A quarter-end date from separate year and quarter values, or undefined (`_quarter_end`). */
export function quarterEnd(year: unknown, quarter: unknown): string | undefined {
  const y = pyInt(year)
  const q = pyInt(quarter)
  if (y === undefined || q === undefined || !(q in QUARTER_END)) return undefined
  return `${String(y).padStart(4, '0')}-${QUARTER_END[q]}`
}

/** `int(float(str(x).strip()))` or undefined where Python raises. */
function pyInt(v: unknown): number | undefined {
  if (isNa(v)) return undefined
  const s = String(v).trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** `str(cell).strip().replace("**", "").strip()` of a present cell, else "". */
function filled(cell: Cell | undefined): string {
  return isNa(cell) ? '' : String(cell).trim().replace(/\*\*/g, '').trim()
}

/** Forward fill along an array (`Series.ffill`). */
function ffill<T>(values: (T | null | undefined)[]): (T | null)[] {
  let last: T | null = null
  return values.map((v) => {
    if (!isNa(v)) last = v as T
    return last
  })
}

export type LongRecord = { date: string; series: string; value: number | null; frequency?: string; section?: number }

/** A distinct label for each value column from the multi-row header (`_quarterly_column_labels`). */
function quarterlyColumnLabels(raw: Grid, headerRow: number, skipRows: Set<number>): Map<number, string> {
  const width = raw[0]?.length ?? 0
  const valueColumns = Array.from({ length: Math.max(0, width - 2) }, (_, i) => i + 2)
  const headerCount = valueColumns.filter((c) => filled(raw[headerRow]![c])).length
  const threshold = Math.max(2, Math.floor(headerCount / 2))

  const superRows: number[] = []
  for (let row = headerRow - 1; row > Math.max(-1, headerRow - 9); row--) {
    if (skipRows.has(row)) continue
    const [first, second] = [raw[row]![0], raw[row]![1]]
    if ((!isNa(first) && String(first).trim()) || (!isNa(second) && String(second).trim())) break
    superRows.push(row)
  }
  superRows.reverse()
  const labelLines: number[] = []
  const groupRows: number[] = []
  for (const row of superRows) {
    const count = valueColumns.filter((c) => filled(raw[row]![c])).length
    ;(count >= threshold ? labelLines : groupRows).push(row)
  }
  const filledRows = new Map(groupRows.map((row) => [row, ffill(raw[row]!)] as const))

  const base = new Map<number, string>()
  for (const c of valueColumns) {
    const parts = [...labelLines, headerRow].map((row) => filled(raw[row]![c])).filter(Boolean)
    const joined = parts.join(' ').trim()
    if (joined) base.set(c, joined)
  }
  const counts = new Map<string, number>()
  for (const joined of base.values()) counts.set(joined, (counts.get(joined) ?? 0) + 1)
  const labels = new Map<number, string>()
  for (const [c, joined] of base) {
    let resolved = joined
    if ((counts.get(joined) ?? 0) > 1) {
      const groups: string[] = []
      for (const row of groupRows) {
        const label = filled(filledRows.get(row)![c])
        if (label && !joined.includes(label) && !groups.includes(label)) groups.push(label)
      }
      if (groups.length) resolved = `${groups.join(' - ')} - ${joined}`
    }
    labels.set(c, resolved)
  }
  return labels
}

/** Every `Year`/`Qtr.` block of a survey sheet as long records (`parse_kc_quarterly`). */
export function parseKcQuarterly(raw: Grid, start?: string, end?: string): LongRecord[] {
  const width = raw[0]?.length ?? 0
  const headerRows = raw.map((r, i) => [r, i] as const).filter(([r]) => String(r[0] ?? 'nan').trim().toLowerCase() === 'year').map(([, i]) => i)
  const multi = headerRows.length > 1
  const rows: LongRecord[] = []
  headerRows.forEach((header, block) => {
    let title = ''
    let titleRow: number | undefined
    for (let above = header - 1; above > Math.max(-1, header - 4); above--) {
      for (let c = 2; c < width; c++) {
        const candidate = raw[above]![c]
        if (!isNa(candidate) && String(candidate).trim()) {
          title = String(candidate).trim()
          titleRow = above
          break
        }
      }
      if (title) break
    }
    const stop = block + 1 < headerRows.length ? headerRows[block + 1]! : raw.length
    const body = raw.slice(header + 1, stop)
    if (body.length === 0) return
    const years = ffill(body.map((r) => r[0]))
    const skip = new Set<number>(multi && titleRow !== undefined ? [titleRow] : [])
    const columnLabels = quarterlyColumnLabels(raw, header, skip)
    const valueColumns = [...columnLabels].map(([c, name]): [number, string] => [c, multi && title ? `${title} - ${name}` : name])
    body.forEach((row, position) => {
      const observed = quarterEnd(years[position], row[1])
      if (observed === undefined) return
      if ((start && observed < start) || (end && observed > end)) return
      for (const [c, series] of valueColumns) rows.push({ date: observed, series, value: toNumeric(row[c]) })
    })
  })
  return rows
}

const DISTRICTS: Record<string, string> = { CHI: 'Chicago', DAL: 'Dallas', KC: 'Kansas City', MIN: 'Minneapolis', RIC: 'Richmond', SF: 'San Francisco', STL: 'St. Louis' }

/** The workbook's "Data" sheet and the labels of its "Description" sheet (`code → label`). */
function dataAndDescriptions(bytes: Uint8Array, labelOf: (header: string[], row: Cell[]) => string | undefined): { data: Grid; labels: Map<string, string> } {
  const sheets = readGrids(bytes)
  const data = sheets.find((s) => s.name === 'Data')
  if (!data) throw new Error("'Data'")
  const description = sheets.find((s) => s.name.trim().toLowerCase().startsWith('description'))
  const labels = new Map<string, string>()
  if (description) {
    const [head = [], ...rows] = description.grid
    const header = head.map((h, i) => (isNa(h) ? `Unnamed: ${i}` : String(h)))
    for (const row of rows) {
      if (row.length >= 2 && !isNa(row[0])) {
        const label = labelOf(header, row)
        if (label !== undefined) labels.set(String(row[0]).trim(), label)
      }
    }
  }
  return { data: data.grid, labels }
}

/** The "Data" sheet as quarter-dated long records: the first column is "2024Q1", the rest are coded series. */
function quarterlyCodes(data: Grid, labelFor: (code: string) => string, start?: string, end?: string): LongRecord[] {
  const header = data[0] ?? []
  const rows: LongRecord[] = []
  for (const row of data.slice(1)) {
    const m = /^(\d{4})Q([1-4])$/.exec(String(row[0] ?? 'nan').trim())
    const observed = m ? quarterEnd(m[1], m[2]) : undefined
    if (observed === undefined) continue
    if ((start && observed < start) || (end && observed > end)) continue
    for (let c = 1; c < header.length; c++) rows.push({ date: observed, series: labelFor(String(header[c] ?? '').trim()), value: toNumeric(row[c]) })
  }
  return rows
}

/** The multi-district ag credit survey, naming each district code (`parse_kc_district`). */
export function parseKcDistrict(bytes: Uint8Array, start?: string, end?: string): LongRecord[] {
  const { data, labels } = dataAndDescriptions(bytes, (_, row) => String(row[1] ?? 'nan').trim())
  return quarterlyCodes(
    data,
    (code) => {
      const metric = labels.get(code) ?? code
      const m = /^\d+([A-Z]+)$/.exec(code)
      const district = m && Object.hasOwn(DISTRICTS, m[1]!) ? DISTRICTS[m[1]!] : undefined
      return district ? `${district} - ${metric}` : metric
    },
    start,
    end,
  )
}

/** The Ag Finance Databook history, labelling codes from the descriptions (`parse_kc_databook`). */
export function parseKcDatabook(bytes: Uint8Array, start?: string, end?: string): LongRecord[] {
  const { data, labels } = dataAndDescriptions(bytes, (header, row) => {
    const parts = !isNa(row[1]) ? [String(row[1]).trim()] : []
    header.forEach((name, index) => {
      if (name.trim().toLowerCase().startsWith('attribute') && index < row.length && !isNa(row[index])) {
        const text = String(row[index]).trim()
        if (text && !parts.includes(text)) parts.push(text)
      }
    })
    return parts.length ? parts.join(' - ') : String(row[0]).trim()
  })
  return quarterlyCodes(data, (code) => labels.get(code) ?? code, start, end)
}

/** An archived databook sheet as long records (`parse_kc_annual_table`). */
export function parseKcAnnualTable(raw: Grid, start?: string, end?: string): LongRecord[] {
  const width = raw[0]?.length ?? 0
  const periodTerms = ['period', 'year', 'date']
  let headerRow: number | undefined
  let periodCol = 0
  for (let i = 0; i < Math.min(15, raw.length) && headerRow === undefined; i++) {
    for (let c = 0; c < Math.min(3, width); c++) {
      if (periodTerms.includes(String(raw[i]![c] ?? 'nan').trim().toLowerCase())) {
        headerRow = i
        periodCol = c
        break
      }
    }
  }
  if (headerRow === undefined) return []
  const labels = raw[headerRow]!
  const body = raw.slice(headerRow + 1).map((r) => r.slice())
  const characteristic = Array.from({ length: periodCol }, (_, i) => i)
  for (const c of characteristic) {
    const col = ffill(body.map((r) => r[c]))
    body.forEach((r, i) => {
      r[c] = col[i] ?? null
    })
  }
  const valueColumns: [number, string][] = []
  for (let c = periodCol + 1; c < width; c++) {
    const label = labels[c]
    if (!isNa(label) && String(label).trim()) valueColumns.push([c, String(label).trim()])
  }
  const rows: LongRecord[] = []
  let section = 1
  let seen = new Set<string>()
  let previousPrefix: string | undefined
  for (const row of body) {
    const m = /^(\d{4})(?::?Q([1-4]))?$/.exec(String(row[periodCol] ?? 'nan').trim())
    if (!m) continue
    const quarter = m[2] !== undefined
    const observed = quarter ? quarterEnd(m[1], m[2])! : `${m[1]}-12-31`
    const prefix = characteristic.filter((c) => !isNa(row[c]) && String(row[c]).trim()).map((c) => String(row[c]).trim()).join(' - ')
    if (prefix && prefix !== previousPrefix) {
      if (seen.has(prefix)) {
        section += 1
        seen = new Set()
      }
      seen.add(prefix)
    }
    previousPrefix = prefix
    if ((start && observed < start) || (end && observed > end)) continue
    for (const [c, label] of valueColumns) {
      rows.push({ date: observed, frequency: quarter ? 'quarter' : 'annual', section, series: prefix ? `${prefix} - ${label}` : label, value: toNumeric(row[c]) })
    }
  }
  return rows
}
