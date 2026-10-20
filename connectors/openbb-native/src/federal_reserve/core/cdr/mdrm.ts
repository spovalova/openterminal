// The Federal Reserve's Micro Data Reference Manual (MDRM): item names and definitions by MDRM code. Ported from
// openbb_federal_reserve/utils/mdrm.py (OpenBB Platform 5.0.0, Apache-2.0); modified: one pass over the 90 MB CSV that
// keeps only what the ports read (every revision's name and dates, the newest revision's definition), ctx.cache
// instead of the on-disk cache.
import { unzipSync, strFromU8 } from 'fflate'
import type { NativeCtx } from '../../../types.js'
import { DAY_MS, request, unescapeHtml } from '../helpers.js'

const MDRM_URL = 'https://www.federalreserve.gov/apps/mdrm/pdf/MDRM.zip'

type Revision = { name: string; start: string; end: string }
export type MdrmCode = { revisions: Revision[]; /** Definition of the revision that ends last (the first of equals). */ description: string; bestEnd: string }
export type Mdrm = Map<string, MdrmCode>

/** Rows of a CSV text, one at a time (Python's `csv.reader`: quoted fields may hold commas, quotes and newlines). */
function* csvRecords(text: string): Generator<string[]> {
  const n = text.length
  let i = 0
  while (i < n) {
    const row: string[] = []
    for (;;) {
      if (text.charCodeAt(i) === 34) {
        let j = i + 1
        let value = ''
        for (;;) {
          const q = text.indexOf('"', j)
          if (q === -1) {
            value += text.slice(j)
            i = n
            break
          }
          value += text.slice(j, q)
          if (text.charCodeAt(q + 1) === 34) {
            value += '"'
            j = q + 2
          } else {
            i = q + 1
            break
          }
        }
        row.push(value)
      } else {
        let j = i
        for (; j < n; j++) {
          const c = text.charCodeAt(j)
          if (c === 44 || c === 10 || c === 13) break
        }
        row.push(text.slice(i, j))
        i = j
      }
      if (text.charCodeAt(i) === 44) {
        i++
        continue
      }
      if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i += 2
      else if (i < n) i++
      break
    }
    yield row
  }
}

/** An MDRM `MM/DD/YYYY ...` timestamp as an ISO date, '' when it does not parse. */
function parseDate(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value.trim())
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : ''
}

const cleanText = (value: string): string => unescapeHtml(value).split(/\s+/).filter(Boolean).join(' ')

/** The MDRM, by code. */
export function fetchMdrm(ctx: NativeCtx): Promise<Mdrm> {
  return ctx.cache('fed:mdrm', DAY_MS, async () => {
    const zip = await ctx.http.bytes(MDRM_URL, request({ timeoutMs: 120_000 }))
    const files = unzipSync(zip, { filter: (f) => f.name.toLowerCase().endsWith('.csv') })
    const member = Object.keys(files)[0]
    if (!member) throw new Error('MDRM archive has no CSV')
    const text = strFromU8(files[member]!)
    const out: Mdrm = new Map()
    let column: Record<string, number> | undefined
    for (const row of csvRecords(text)) {
      if (!column) {
        if (row.some((cell) => cell.toLowerCase().includes('nemonic'))) column = Object.fromEntries(row.map((name, i) => [name.trim(), i]))
        continue
      }
      const item = column['Item Name']!
      if (row.length <= item || !row[column.Mnemonic!]!.trim()) continue
      const code = (row[column.Mnemonic!]!.trim() + row[column['Item Code']!]!.trim()).toUpperCase()
      const start = parseDate(row[column['Start Date']!] ?? '')
      const end = parseDate(row[column['End Date']!] ?? '')
      let entry = out.get(code)
      if (!entry) {
        entry = { revisions: [], description: '', bestEnd: '' }
        out.set(code, entry)
      }
      // max(code_revisions, key=end or date.min): the first revision with the greatest end date.
      if (entry.revisions.length === 0 || end > entry.bestEnd) {
        const di = column.Description
        entry.description = di !== undefined && row.length > di ? cleanText(row[di]!) : ''
        entry.bestEnd = end
      }
      entry.revisions.push({ name: row[item]!.trim(), start, end })
    }
    return out
  })
}

/** `_resolve_revisions`: one revision per code, the one covering `asOf` when there is one, else the newest. */
export function resolveRevisions(mdrm: Mdrm, asOf?: string, prefix?: string): Map<string, { name: string; description: string | undefined }> {
  const out = new Map<string, { name: string; description: string | undefined }>()
  const upper = prefix?.toUpperCase()
  for (const [code, entry] of mdrm) {
    if (upper && !code.startsWith(upper)) continue
    let chosen: Revision | undefined
    if (asOf !== undefined) {
      let bestStart = ''
      for (const r of entry.revisions) {
        if ((r.start || '') <= asOf && asOf <= (r.end || '9999-99-99') && (chosen === undefined || (r.start || '') > bestStart)) {
          chosen = r
          bestStart = r.start || ''
        }
      }
    }
    if (chosen) out.set(code, { name: chosen.name, description: undefined })
    else {
      let best = entry.revisions[0]!
      for (const r of entry.revisions) if ((r.end || '') > (best.end || '')) best = r
      out.set(code, { name: best.name, description: entry.description })
    }
  }
  return out
}

/** `fetch_mdrm_dictionary`: item code to line-item name. */
export function mdrmDictionary(mdrm: Mdrm, asOf?: string, prefix?: string): Map<string, string> {
  return new Map([...resolveRevisions(mdrm, asOf, prefix)].map(([code, r]) => [code, r.name]))
}

/** `fetch_mdrm_definitions` (without `as_of`): item code to definition, where there is one. */
export function mdrmDefinitions(mdrm: Mdrm): Map<string, string> {
  const out = new Map<string, string>()
  for (const [code, r] of resolveRevisions(mdrm)) if (r.description) out.set(code, r.description)
  return out
}
