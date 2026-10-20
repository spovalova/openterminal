// The keyless sources besides the bulk archives: the unitedstates legislators dataset and GovInfo's search backend.
// Ported from openbb_government_us/congress/utils/bulk.py (OpenBB Platform 5.0.0, Apache-2.0).
import type { NativeCtx } from '../types.js'
import { GOVINFO, type Rec } from './billstatus.js'
import { packageUrls } from './helpers.js'

const LEGISLATORS_BASE = 'https://unitedstates.github.io/congress-legislators'

/** A file of the unitedstates congress-legislators dataset (30 s timeout, as OpenBB). */
export function unitedstatesData<T>(ctx: NativeCtx, file: string): Promise<T> {
  return ctx.http.json<T>(`${LEGISLATORS_BASE}/${file}`, { timeoutMs: 30_000 })
}

const WSSEARCH_URL = `${GOVINFO}/wssearch/search`

/** GovInfo's keyless search backend (`wssearch`). */
export async function wssearch(ctx: NativeCtx, query: string, o: { offset?: number; pagesize?: number; sort?: string } = {}): Promise<Rec> {
  try {
    return await ctx.http.json<Rec>(WSSEARCH_URL, { method: 'POST', body: { query, offset: o.offset ?? 0, pageSize: o.pagesize ?? 20, sortBy: o.sort ?? '2', historical: false } })
  } catch (err) {
    throw new Error(`GovInfo search failed for '${query}' -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The chamber a GovInfo package id names (`_chamber_from_package`). */
function chamberFromPackage(packageId: string): string | null {
  const m = /-\d+([hsj])/.exec(packageId)
  return m ? ({ h: 'House', s: 'Senate', j: 'Joint' })[m[1]!]! : null
}

/** A search result item as a document record (`_wssearch_record`). */
export function wssearchRecord(item: Rec, docType: string, congress: number): Rec {
  const fieldMap = (item.fieldMap ?? {}) as Rec
  const packageId = (fieldMap.packageid as string | undefined) ?? ''
  const line1 = (item.line1 as string | undefined) ?? ''
  const line2 = (item.line2 as string | undefined) ?? ''
  const citationMatch = /^(.*?)\s+-\s+/s.exec(line1)
  const citation = citationMatch ? citationMatch[1]!.trim() : null
  let date: string | null = null
  const dateMatch = /([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(line2)
  if (dateMatch) {
    const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(dateMatch[1]!)
    const month = m ? MONTHS.findIndex((n) => n.toLowerCase() === m[1]!.toLowerCase()) : -1
    if (m && month >= 0) {
      const t = new Date(Date.UTC(Number(m[3]), month, Number(m[2])))
      if (t.getUTCMonth() === month && t.getUTCDate() === Number(m[2])) date = `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
    }
  }
  return {
    doc_type: docType,
    citation,
    title: (fieldMap.title as string | undefined) || line1,
    congress,
    chamber: chamberFromPackage(packageId),
    date,
    package_id: packageId,
    doc_url: packageId ? packageUrls(packageId).pdf : null,
  }
}
