// The BLS chart-pack routes (bls/cpi/by_category … bls/productivity/wr_longterm_change), provider bls. Ported from
// openbb_bls/utils/{cpi,empsit,ppi,productivity,ximpim,jolts,tfp,wholesale_retail,mining_manufacturing}_charts.py,
// charts_common.py and models/*_charts.py (OpenBB Platform 5.0.0, Apache-2.0); modified: one parser for every pack
// (the packs differ only in the specs in chart-specs.ts, the stub column's period and row de-duplication), and
// node-html-parser instead of BeautifulSoup.
import type { HTMLElement } from 'node-html-parser'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { CHART_PACKS, type ChartPack, type ChartSpec } from './chart-specs.js'
import { applyDateWindow, fetchPage, findAll, parseHtml, parseMonth, parseQuarter, parseYear, squish, str, textOf, toNum } from './helpers.js'

const STUB_PARSERS = { month: parseMonth, quarter: parseQuarter, year: parseYear } as const

/** One chart page's data table as wide rows (`parse_chart_table`). */
export function parseChartTable(html: string, pack: ChartPack, spec: ChartSpec): Row[] {
  const table = findAll(parseHtml(html), ['table']).find((t) => t.classList.contains('regular'))
  if (!table) throw new Error(`BLS ${spec.slug} chart '${spec.key}' page has no data table.`)
  const caption = findAll(table, ['caption'])[0]
  const chartTitle = caption ? squish(textOf(caption)) : spec.label
  const tableId = table.getAttribute('id') || `${pack.prefix}-${spec.key}`
  const body = findAll(table, ['tbody'])[0]
  const rows: HTMLElement[] = body ? findAll(body, ['tr']) : []
  const isTs = spec.kind === 'ts'
  const parsePeriod = STUB_PARSERS[pack.period]

  const out: Row[] = []
  const seen = new Set<string>()
  for (const tr of rows) {
    const cells = findAll(tr, ['th', 'td'])
    if (cells.length === 0) continue
    const stub = textOf(cells[0]!)
    const record: Row = { chart: spec.key, chart_title: chartTitle, table_id: tableId }
    let stubValue: string
    if (isTs) {
      const period = parsePeriod(stub)
      if (period === null) continue
      stubValue = period
      record.date = period
    } else {
      stubValue = squish(stub)
      if (!stubValue) continue
      record[pack.stub ?? spec.kind] = stubValue
    }
    spec.fields.forEach((field, i) => {
      const cell = cells[i + 1]
      record[field] = cell ? toNum(textOf(cell)) : null
    })
    if (pack.dedupe) {
      // Some BLS bar-chart pages repeat a row verbatim (a styled copy that highlights the chart).
      const signature = JSON.stringify([stubValue, spec.fields.map((f) => record[f])])
      if (seen.has(signature)) continue
      seen.add(signature)
    }
    out.push(record)
  }
  return out
}

function chartHandler(pack: ChartPack, spec: ChartSpec): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const html = await fetchPage(ctx, `${pack.base}/${spec.slug}.htm`)
    let rows = parseChartTable(html, pack, spec)
    if (spec.kind === 'ts') rows = applyDateWindow(rows, str(params.start_date), str(params.end_date))
    if (rows.length === 0) throw new Error(`No rows parsed from the BLS chart '${spec.key}'.`)
    return rows
  }
}

/** Route → handler for every chart route. */
export const chartRoutes: Record<string, NativeHandler> = Object.fromEntries(
  Object.values(CHART_PACKS).flatMap((pack) => Object.entries(pack.charts).map(([route, spec]) => [route, chartHandler(pack, spec)] as const)),
)
