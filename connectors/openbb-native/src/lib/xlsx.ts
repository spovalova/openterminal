// A minimal .xlsx reader (Office Open XML: a zip of XML parts) for the spreadsheets BLS, CFTC, the Fed and USDA
// publish: sheet names, cell values, shared and inline strings, booleans, and dates where the cell's number
// format is a date, as pandas.read_excel gives them. Legacy .xls (BIFF) is not supported.
import { unzipSync, strFromU8 } from 'fflate'
import { asArray, parseXml } from './xml.js'

export type Cell = string | number | boolean | null
export type Sheet = { name: string; rows: Cell[][] }

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** Excel's serial day number (1900 system) → "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM:SS" when it has a time. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  const iso = new Date(ms).toISOString()
  return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(0, 19)
}

function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function text(node: unknown): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  const o = node as Record<string, unknown>
  if ('#text' in o) return String(o['#text'])
  if ('t' in o) return text(o.t)
  if ('r' in o) return asArray(o.r).map((r) => text((r as Record<string, unknown>).t)).join('')
  return ''
}

/** Every sheet of a workbook, in workbook order. */
export function readXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzipSync(bytes)
  const part = (name: string): string | undefined => (files[name] ? strFromU8(files[name]!) : undefined)

  const shared = asArray((parseXml(part('xl/sharedStrings.xml') ?? '<sst/>', { trimValues: false }).sst as Record<string, unknown> | undefined)?.si).map(text)

  const styles = parseXml(part('xl/styles.xml') ?? '<styleSheet/>').styleSheet as Record<string, unknown> | undefined
  const customDates = new Set(
    asArray((styles?.numFmts as Record<string, unknown> | undefined)?.numFmt as Record<string, string>[] | undefined)
      .filter((f) => /[ymd]/i.test(String(f['@_formatCode']).replace(/"[^"]*"|\[[^\]]*\]/g, '')))
      .map((f) => Number(f['@_numFmtId'])),
  )
  const xfs = asArray((styles?.cellXfs as Record<string, unknown> | undefined)?.xf as Record<string, string>[] | undefined)
  const isDateStyle = (s: string | undefined): boolean => {
    if (s === undefined) return false
    const id = Number(xfs[Number(s)]?.['@_numFmtId'] ?? -1)
    return BUILTIN_DATE_FORMATS.has(id) || customDates.has(id)
  }

  const rels = new Map(
    asArray((parseXml(part('xl/_rels/workbook.xml.rels') ?? '<Relationships/>').Relationships as Record<string, unknown> | undefined)?.Relationship as Record<string, string>[] | undefined).map((r) => [r['@_Id'], r['@_Target']]),
  )
  const sheets = asArray(((parseXml(part('xl/workbook.xml') ?? '<workbook/>').workbook as Record<string, unknown> | undefined)?.sheets as Record<string, unknown> | undefined)?.sheet as Record<string, string>[] | undefined)

  return sheets.map((s) => {
    const target = String(rels.get(s['@_id'] ?? s['@_r:id'] ?? '') ?? '').replace(/^\/?xl\//, '')
    const xml = part(`xl/${target}`) ?? ''
    const data = ((parseXml(xml, { trimValues: false }).worksheet as Record<string, unknown> | undefined)?.sheetData ?? {}) as Record<string, unknown>
    const rows: Cell[][] = []
    for (const row of asArray(data.row as Record<string, unknown>[] | undefined)) {
      const r = Number(row['@_r'] ?? rows.length + 1) - 1
      const out: Cell[] = []
      for (const c of asArray(row.c as Record<string, unknown>[] | undefined)) {
        const col = columnIndex(String(c['@_r'] ?? ''))
        const t = c['@_t'] as string | undefined
        const v = c.v === undefined ? undefined : text(c.v)
        let value: Cell = null
        if (t === 's') value = v === undefined ? null : (shared[Number(v)] ?? null)
        else if (t === 'inlineStr') value = text(c.is)
        else if (t === 'b') value = v === '1'
        else if (t === 'str' || t === 'e') value = v ?? null
        else if (v !== undefined && v !== '') {
          const n = Number(v)
          value = isDateStyle(c['@_s'] as string | undefined) ? excelSerialToIso(n) : n
        }
        out[col] = value
      }
      rows[r] = Array.from(out, (x) => (x === undefined ? null : x))
    }
    return { name: s['@_name'] ?? '', rows: Array.from(rows, (x) => x ?? []) }
  })
}
