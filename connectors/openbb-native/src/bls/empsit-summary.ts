// bls/employment_situation/summary_household and summary_establishment, provider bls. Ported from
// openbb_bls/models/empsit_summary.py and utils/empsit_summary.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// node-html-parser instead of BeautifulSoup, plain rows keeping the fields the Data models declare.
import type { NativeCtx, NativeHandler, Row } from '../types.js'
import { fetchPage, findAll, htmlTables, squish, textOf } from './helpers.js'

const BASE = 'https://www.bls.gov/news.release'

const SPECS = {
  a: { slug: 'empsit.a', label: 'Summary Table A — Household Data (Seasonally Adjusted)', hasChange: true },
  b: { slug: 'empsit.b', label: 'Summary Table B — Establishment Data (Seasonally Adjusted)', hasChange: false },
} as const

/** Strip footnote markers like `( 1 )` and `( p )` and collapse whitespace (`_clean_label`). */
const cleanLabel = (text: string): string => squish(text.replace(/\(\s*[0-9p]+\s*\)/gi, ''))

const NO_VALUE = new Set(['', '-', '--', '(NA)', 'NA', 'N/A'])
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A summary cell (`$`, commas, `%`) as a number; blanks are null (`_to_value`). */
function toValue(text: string | undefined): number | null {
  if (text === undefined) return null
  const cleaned = text.replace(/ /g, ' ').replace(/\$/g, '').replace(/,/g, '').replace(/%/g, '').trim()
  return NO_VALUE.has(cleaned) || !FLOAT_RE.test(cleaned) ? null : Number(cleaned)
}

function summaryHandler(key: 'a' | 'b'): NativeHandler {
  const spec = SPECS[key]
  return async (_params, ctx: NativeCtx): Promise<Row[]> => {
    const html = await fetchPage(ctx, `${BASE}/${spec.slug}.htm`)
    const table = htmlTables(html).find((t) => t.classList.contains('regular'))
    if (!table) throw new Error(`BLS Employment Situation summary table '${key}' page has no data table.`)
    const tableId = table.getAttribute('id') || `empsit-summary-${key}`
    const body = findAll(table, ['tbody'])[0] ?? table
    const out: Row[] = []
    let section: string | null = null
    for (const tr of findAll(body, ['tr'])) {
      const cells = findAll(tr, ['th', 'td']).map((c) => textOf(c))
      if (cells.length === 0) continue
      const label = cleanLabel(cells[0]!)
      const values = cells.slice(1)
      if (!values.some((v) => v.trim())) {
        // A label with no values is a section header; a fully blank row is a separator.
        if (label) section = label
        continue
      }
      out.push({
        section,
        category: label,
        year_ago: toValue(values[0]),
        two_months_prior: toValue(values[1]),
        prior_month: toValue(values[2]),
        latest: toValue(values[3]),
        ...(spec.hasChange ? { change_1_month: toValue(values[4]) } : {}),
        table_id: tableId,
      })
    }
    if (out.length === 0) throw new Error(`No rows parsed from Employment Situation summary table '${key}'.`)
    return out
  }
}

export const empsitSummaryRoutes: Record<string, NativeHandler> = {
  'bls/employment_situation/summary_household': summaryHandler('a'),
  'bls/employment_situation/summary_establishment': summaryHandler('b'),
}
