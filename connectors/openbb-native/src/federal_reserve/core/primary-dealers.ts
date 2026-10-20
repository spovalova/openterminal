// economy/primary_dealer_fails and economy/primary_dealer_positioning, provider federal_reserve. Ported from
// openbb_federal_reserve/models/{primary_dealer_fails,primary_dealer_positioning}.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain maps instead of pandas frames and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { EmptyDataError, inRange, request, str } from './helpers.js'
import { FAILS_SERIES_TO_TITLE, POSITION_GROUPS_TO_SERIES, POSITION_SERIES_TO_FIELD } from './primary-dealer-series.js'

type Observation = { asofdate: string; keyid: string; value: string }

async function timeseries(ctx: NativeCtx, url: string): Promise<Observation[]> {
  const body = await ctx.http.json<{ pd?: { timeseries?: Observation[] } }>(url, request({ timeoutMs: 60_000 }))
  return body.pd?.timeseries ?? []
}

/** `astype(int)` on a string cell. */
function asInt(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`invalid literal for int() with base 10: '${String(v)}'`)
  return Math.trunc(n)
}

export async function primaryDealerFails(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const assetClass = str(params, 'asset_class') ?? 'all'
  const unit = str(params, 'unit') ?? 'value'

  const base = 'https://markets.newyorkfed.org/api/pd/get/'
  let data: Observation[]
  try {
    data = await timeseries(ctx, `${base}PDFTD-CS_PDFTR-CS_PDFTD-FGEM_PDFTR-FGEM_PDFTD-FGM_PDFTR-FGM_PDFTD-OM_PDFTR-OM_PDFTD-UST_PDFTR-UST_PDFTD-USTET_PDFTR-USTET.json`)
    if (start && start < '2013-04-01') {
      if (start < '2001-07-01') data = data.concat(await timeseries(ctx, `${base}SBP2001/timeseries/PDFASUFDA_PDFASUFRA_PDFASFAFDA_PDFASFAFRA_PDFASMBFDA_PDFASMBFRA.json`))
      data = data.concat(await timeseries(ctx, `${base}SBP2013/timeseries/PDFASCFRA_PDFASCFDA_PDFASFAFRA_PDFASFAFDA_PDFASMBFRA_PDFASMBFDA_PDFASUFRA_PDFASUFDA.json`))
    }
  } catch {
    throw new Error('Failed to fetch data from the Federal Reserve API.')
  }
  if (data.length === 0) throw new EmptyDataError('No data returned from the Federal Reserve API.')

  // DataFrame.pivot(index="asofdate", columns="title", values="value"): a repeated (date, title) is an error.
  const byDate = new Map<string, Map<string, number>>()
  const titles = new Set<string>()
  for (const d of data) {
    const title = FAILS_SERIES_TO_TITLE[d.keyid]
    if (title === undefined) continue
    titles.add(title)
    const row = byDate.get(d.asofdate) ?? new Map<string, number>()
    if (row.has(title)) throw new Error('Index contains duplicate entries, cannot reshape')
    row.set(title, asInt(d.value))
    byDate.set(d.asofdate, row)
  }
  const sortedTitles = [...titles].sort()

  const keep = (name: string): boolean => {
    switch (assetClass) {
      case 'agency':
        return name.includes('Ex-MBS')
      case 'mbs':
        return name.includes('MBS') && !name.includes('Ex-MBS')
      case 'treasuries':
        return name.includes('Treasury Securities (Ex-TIPS)')
      case 'tips':
        return name.includes('TIPS') && !name.includes('Ex-TIPS')
      case 'corporate':
        return name.includes('Corporate')
      default:
        return true
    }
  }

  const out: Row[] = []
  for (const date of [...byDate.keys()].sort()) {
    if (!inRange(date, start, end)) continue
    const values = byDate.get(date)!
    const row: Row = { date }
    for (const target of ['FTD', 'FTR']) {
      const cols = sortedTitles.filter((t) => t.includes(target))
      const total = cols.reduce((s, c) => s + (values.get(c) ?? 0), 0)
      for (const [name, v] of [...cols.map((c) => [c, values.get(c)] as const), [`${target} Total`, total] as const]) {
        if (!keep(name) || v === undefined) continue
        const scaled = unit === 'percent' ? v / total : v
        if (Number.isNaN(scaled)) continue
        row[name] = unit === 'value' ? Math.trunc(scaled) : scaled
      }
    }
    out.push(row)
  }
  return out
}

export async function primaryDealerPositioning(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const category = str(params, 'category') ?? 'treasuries'
  const symbols = POSITION_GROUPS_TO_SERIES[category] ?? []
  const names = POSITION_SERIES_TO_FIELD.dealer_position!

  const results = (await Promise.all(symbols.map((s) => timeseries(ctx, `https://markets.newyorkfed.org/api/pd/get/${s}.json`)))).flat()
  if (results.length === 0) throw new EmptyDataError('The request was returned empty.')

  const records = results
    .map((r) => ({ date: r.asofdate.slice(0, 10), name: names[r.keyid], value: asInt(r.value) }))
    .filter((r) => inRange(r.date, start, end))
    .sort((a, b) => a.date.localeCompare(b.date))
  // pivot_wide: one row per date, the last value of a repeated field wins.
  const rows = new Map<string, Row>()
  for (const r of records) {
    const row = rows.get(r.date) ?? { date: r.date }
    if (r.name !== undefined) row[r.name] = r.value
    rows.set(r.date, row)
  }
  return [...rows.values()].filter((r) => Object.keys(r).length > 1)
}
