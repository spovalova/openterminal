// federal_reserve/cleveland/inflation_nowcast, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/cleveland_inflation_nowcast.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { pivotWide } from '../workbook.js'
import { CLEVELAND_WEBCHARTS, dateParam, downloadText } from './helpers.js'

const BASE_URL = `${CLEVELAND_WEBCHARTS}/inflationnowcasting`
const FILES: Record<string, string> = { month: 'nowcast_month.json', quarter: 'nowcast_quarter.json', year: 'nowcast_year.json' }

type Chart = { chart?: { subcaption?: unknown }; dataset?: { seriesname?: string; data?: { value?: unknown }[] }[] }

/** The date a chart's subcaption ("2026:Q3", "2026-09", "2026") stands for. */
function targetDate(subcaption: unknown): string | undefined {
  const text = String(subcaption ?? '').trim()
  const pad = (n: number) => String(n).padStart(2, '0')
  let m = /^(\d{4}):?Q(\d)$/.exec(text)
  if (m) return `${m[1]}-${pad((Number(m[2]) - 1) * 3 + 1)}-01`
  m = /^(\d{4})[-/](\d{1,2})$/.exec(text)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-01`
  m = /^(\d{4})$/.exec(text)
  if (m) return `${m[1]}-01-01`
  return undefined
}

export async function inflationNowcast(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frequency = String(params.frequency ?? 'month')
  const text = await downloadText(ctx, `nowcast:${frequency}`, `${BASE_URL}/${FILES[frequency]!}`)
  const charts = JSON.parse(text) as Chart[]
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const records: Row[] = []
  for (const chart of charts) {
    const target = targetDate(chart.chart?.subcaption ?? '')
    if (target === undefined) continue
    if (start && target < start) continue
    if (end && target > end) continue
    for (const series of chart.dataset ?? []) {
      let final: number | undefined
      for (const point of series.data ?? []) {
        const raw = point.value
        if (raw !== undefined && raw !== null && raw !== '') final = Number(raw)
      }
      if (final !== undefined) records.push({ date: target, series: series.seriesname, value: final })
    }
  }
  records.sort((a, b) => (a.date === b.date ? ((a.series as string) < (b.series as string) ? -1 : (a.series as string) > (b.series as string) ? 1 : 0) : (a.date as string) < (b.date as string) ? -1 : 1))
  return pivotWide(records, 'date', 'series', 'value')
}
