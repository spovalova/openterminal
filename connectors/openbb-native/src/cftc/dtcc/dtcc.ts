// DTCC Public Price Dissemination client: the cumulative-slice manifest, the daily slice archives and the helpers that
// pick a slice. Ported from openbb_cftc/utils/dtcc.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are ISO
// strings, downloads are memoised with ctx.cache instead of the on-disk store, and slice rows keep only their
// non-empty fields (every reader treats a missing field as the empty string, as Python's `record.get(x) or ""` does).
import { openZip } from '../../lib/zip-entries.js'
import type { NativeCtx } from '../../types.js'
import { JURISDICTION, PPD_API_URL, normalizeAssetClass, oisFisn } from './constants.js'
import type { SliceRecord } from './curve.js'
import { todayOf, type D } from './dates.js'
import { addDays } from './dates.js'
import { searchTrades } from './search.js'

export const MAX_LOOKBACK_DAYS = 10
const MANIFEST_TTL_MS = 3600_000

/** Asset-class-qualified identifiers; 19-digit ids exceed IEEE-754 precision (`qualified_keys`). */
export function qualifiedKeys(record: SliceRecord): Record<string, string> {
  const asset = (record['Asset Class'] ?? 'NA').trim() || 'NA'
  const keys: Record<string, string> = {}
  for (const [source, target] of [
    ['Dissemination Identifier', 'Trade Key'],
    ['Original Dissemination Identifier', 'Original Trade Key'],
  ] as const) {
    const value = (record[source] ?? '').trim()
    if (value) keys[target] = `${asset}:${value}`
  }
  return keys
}

export type ManifestEntry = { fileName?: string; fullFilePath?: string }

/** The cumulative-slice manifest for an asset class (`get_manifest`). */
export async function getManifest(ctx: NativeCtx, assetClass: string): Promise<ManifestEntry[]> {
  const asset = normalizeAssetClass(assetClass)
  const url = `${PPD_API_URL}/cumulative/${JURISDICTION}/${asset}`
  return ctx.cache(`ppd-manifest:${asset}`, MANIFEST_TTL_MS, async () => {
    let response: unknown
    try {
      response = await ctx.http.json<unknown>(url)
    } catch (err) {
      throw new Error(`Failed to fetch the PPD manifest from ${url} -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    if (!response || !Array.isArray(response) || response.length === 0) throw new Error(`No PPD manifest entries returned for ${JURISDICTION}/${asset}.`)
    return response as ManifestEntry[]
  })
}

/** A manifest indexed by report date, parsed from the file name (`manifest_by_date`). */
export function manifestByDate(manifest: ManifestEntry[]): Map<string, ManifestEntry> {
  const index = new Map<string, ManifestEntry>()
  for (const entry of manifest) {
    const name = entry.fileName ?? ''
    const dot = name.lastIndexOf('.')
    const stem = dot >= 0 ? name.slice(0, dot) : name
    const parts = stem.split('_')
    if (parts.length < 3) continue
    const [year, month, day] = parts.slice(-3) as [string, string, string]
    if (!/^\d+$/.test(year) || !/^\d+$/.test(month) || !/^\d+$/.test(day)) continue
    index.set(`${year}-${month}-${day}`, entry)
  }
  return index
}

/** The records of a slice's CSV text; each keeps only its non-empty fields (`csv.DictReader`). */
export function parseSliceCsv(source: string): SliceRecord[] {
  // The Python reads the member through a TextIOWrapper (utf-8-sig, universal newlines): a BOM is dropped and \r\n and \r
  // become \n, quoted or not.
  const text = (source.includes('\r') ? source.replace(/\r\n?/g, '\n') : source).replace(/^\uFEFF/, '')
  const records: SliceRecord[] = []
  let header: string[] | null = null
  const n = text.length
  let i = 0
  let row: string[] = []
  let record: SliceRecord = {}
  let col = 0
  let rowHasContent = false

  const push = (value: string): void => {
    if (header === null) row.push(value)
    else {
      if (value !== '' && col < header.length) record[header[col]!] = value
      col++
    }
    rowHasContent = true
  }
  const endRow = (): void => {
    if (header === null) {
      if (row.length > 0 && !(row.length === 1 && row[0] === '')) header = row
      row = []
    } else if (rowHasContent) {
      records.push(record)
    }
    record = {}
    col = 0
    rowHasContent = false
  }

  while (i < n) {
    // A field starts at i.
    const ch = text.charCodeAt(i)
    if (ch === 34) {
      // Quoted field.
      let value = ''
      i++
      for (;;) {
        const q = text.indexOf('"', i)
        if (q < 0) {
          value += text.slice(i)
          i = n
          break
        }
        value += text.slice(i, q)
        if (text.charCodeAt(q + 1) === 34) {
          value += '"'
          i = q + 2
        } else {
          i = q + 1
          break
        }
      }
      // Anything between the closing quote and the delimiter is kept as is.
      let end = i
      while (end < n) {
        const c = text.charCodeAt(end)
        if (c === 44 || c === 10 || c === 13) break
        end++
      }
      value += text.slice(i, end)
      i = end
      push(value)
    } else {
      let end = i
      while (end < n) {
        const c = text.charCodeAt(end)
        if (c === 44 || c === 10 || c === 13) break
        end++
      }
      push(end > i ? text.slice(i, end) : '')
      i = end
    }
    // The delimiter or line ending after the field.
    if (i >= n) {
      endRow()
      break
    }
    const c = text.charCodeAt(i)
    if (c === 44) {
      i++
      if (i >= n) {
        push('')
        endRow()
      }
      continue
    }
    // Line ending.
    if (c === 13 && text.charCodeAt(i + 1) === 10) i += 2
    else i++
    // A blank line (a lone empty field) is skipped by DictReader.
    endRow()
    while (i < n && (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13)) i++
  }
  return records
}

/** The CSV member of a slice archive as records (`parse_slice_csv`). */
export function parseSliceZip(payload: Uint8Array): SliceRecord[] {
  let archive: ReturnType<typeof openZip>
  try {
    archive = openZip(payload)
  } catch (err) {
    throw new Error(`The PPD payload is not a valid zip archive -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  const member = archive.entries.find((e) => e.name.toLowerCase().endsWith('.csv'))
  if (!member) throw new Error('The PPD archive contains no CSV member.')
  return parseSliceCsv(archive.readText(member))
}

/** One report date's slice records (`get_slice`). */
export async function getSlice(ctx: NativeCtx, assetClass: string, reportDate: D): Promise<SliceRecord[]> {
  const asset = normalizeAssetClass(assetClass)
  const manifest = await getManifest(ctx, assetClass)
  const entry = manifestByDate(manifest).get(reportDate)
  if (entry === undefined) throw new Error(`No PPD file published for ${JURISDICTION}/${asset} on ${reportDate}. Cumulative files are retained for 366 days.`)
  const url = entry.fullFilePath ?? ''
  const today = todayOf(ctx.now())
  const payload = await ctx.cache(`ppd-slice:${asset}:${reportDate}`, reportDate < today ? 1800_000 : 300_000, async () => {
    try {
      return await ctx.http.bytes(url, { timeoutMs: 120_000 })
    } catch (err) {
      throw new Error(`Failed to download ${url} -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  })
  return parseSliceZip(payload)
}

/** The report dates available for an asset class (`get_available_dates`). */
export async function getAvailableDates(ctx: NativeCtx, assetClass: string): Promise<D[]> {
  return [...manifestByDate(await getManifest(ctx, assetClass)).keys()].sort()
}

/** Today's not-yet-published OIS prints, from search, appended to a published slice (`_append_todays_rates`). */
async function appendTodaysRates(ctx: NativeCtx, records: SliceRecord[], ratesDate: D, reportDate: D, currencies: string[]): Promise<SliceRecord[]> {
  const today = todayOf(ctx.now())
  if (currencies.length === 0 || reportDate < today || ratesDate >= today) return records
  const start = addDays(ratesDate, 1)
  const extra: SliceRecord[] = []
  for (const currency of currencies) {
    try {
      extra.push(...(await searchTrades(ctx, 'rates', start, today, { currency, upiShortName: oisFisn(currency) })))
    } catch {
      continue
    }
  }
  if (extra.length === 0) return records
  return [...records, ...extra]
}

/** The most recent rates slice on or before a date holding OIS for each currency (`get_rates_slice_for`). */
export async function getRatesSliceFor(ctx: NativeCtx, reportDate: D, currencies: string[]): Promise<[SliceRecord[], D]> {
  const dates = await getAvailableDates(ctx, 'rates')
  let candidates = dates.filter((day) => day <= reportDate)
  if (candidates.length === 0) candidates = [dates[0]!]
  const wanted = new Set(currencies.map((c) => oisFisn(c)))
  for (const ratesDate of candidates.slice(-MAX_LOOKBACK_DAYS).reverse()) {
    const records = await getSlice(ctx, 'rates', ratesDate)
    const present = new Set(records.map((r) => (r['UPI FISN'] ?? '').trim()))
    if ([...wanted].every((w) => present.has(w))) return [await appendTodaysRates(ctx, records, ratesDate, reportDate, currencies), ratesDate]
  }
  throw new Error(`No rates file in the ${MAX_LOOKBACK_DAYS} days to ${candidates[candidates.length - 1]} priced ${[...currencies].sort().join(', ')}.`)
}

/** The most recent report date whose records satisfy `isViable` (`get_latest_viable_slice`). */
export async function getLatestViableSlice(
  ctx: NativeCtx,
  assetClass: string,
  isViable: (records: SliceRecord[], reportDate: D) => boolean,
  o: { maxLookback?: number; endDate?: D | null } = {},
): Promise<[SliceRecord[], D]> {
  let dates = await getAvailableDates(ctx, assetClass)
  if (o.endDate !== null && o.endDate !== undefined) dates = dates.filter((day) => day <= o.endDate!)
  if (dates.length === 0) throw new Error(`No PPD ${assetClass} files are currently published.`)
  const candidates = dates.slice(-(o.maxLookback ?? MAX_LOOKBACK_DAYS))
  for (const reportDate of [...candidates].reverse()) {
    const records = await getSlice(ctx, assetClass, reportDate)
    if (isViable(records, reportDate)) return [records, reportDate]
  }
  throw new Error(`No ${assetClass} file in the ${candidates.length} days to ${dates[dates.length - 1]} held usable data for this query. Widen the filters, or pass an explicit date.`)
}
