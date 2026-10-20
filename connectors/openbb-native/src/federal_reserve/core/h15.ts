// fixedincome/government/treasury_rates, fixedincome/government/yield_curve and economy/money_measures, provider
// federal_reserve. Ported from openbb_federal_reserve/models/{treasury_rates,yield_curve,money_measures}.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pandas frames and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { ddpCsv, inRange, num, roundHalfEven, shiftDays, str, today } from './helpers.js'

const MATURITIES = ['month_1', 'month_3', 'month_6', 'year_1', 'year_2', 'year_3', 'year_5', 'year_7', 'year_10', 'year_20', 'year_30']
const H15_SERIES = 'bf17364827e38702b42a58cf8eaa3f78'

/** The H.15 constant-maturity table: a date and 11 yields (percent) per day, days with no yield at all dropped. */
async function h15(ctx: NativeCtx): Promise<{ date: string; values: (number | undefined)[] }[]> {
  const { rows } = await ddpCsv(ctx, 'H15', H15_SERIES)
  const out = rows.map((r) => ({ date: r[0] ?? '', values: MATURITIES.map((_, i) => num(r[i + 1])) }))
  return out.filter((r) => r.values.some((v) => v !== undefined))
}

export async function treasuryRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = today(ctx)
  const start = str(params, 'start_date') ?? shiftDays(now, -365)
  const end = str(params, 'end_date') ?? now
  const rows: Row[] = []
  for (const r of await h15(ctx)) {
    if (!inRange(r.date, start, end)) continue
    const row: Row = { date: r.date }
    MATURITIES.forEach((m, i) => {
      const v = r.values[i]
      if (v !== undefined) row[m] = v / 100
    })
    rows.push(row)
  }
  return rows
}

export async function yieldCurve(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await h15(ctx)
  const requested = str(params, 'date')
  const dates = requested ? requested.split(',').map((d) => d.trim()) : [data.reduce((m, r) => (r.date > m ? r.date : m), '')]
  // DatetimeIndex.asof: the last observation on or before each requested date.
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date))
  const nearest = new Set<string>()
  for (const d of dates) {
    let hit: string | undefined
    for (const r of sorted) if (r.date <= d) hit = r.date
    if (hit !== undefined) nearest.add(hit)
  }
  const rows: Row[] = []
  for (const r of sorted) {
    if (!nearest.has(r.date)) continue
    MATURITIES.forEach((maturity, i) => {
      const parts = maturity.split('_')
      const months = Number(parts[1]) * (parts[0] === 'year' ? 12 : 1)
      const v = r.values[i]
      rows.push({ date: r.date, maturity, ...(v !== undefined ? { rate: v / 100 } : {}), maturity_years: months / 12 })
    })
  }
  return rows
}

const MONEY_TITLES: Record<string, string> = {
  M1: 'm1',
  M2: 'm2',
  MCU: 'currency',
  MDD: 'demand_deposits',
  MMFGB: 'retail_money_market_funds',
  MDL: 'other_liquid_deposits',
  MDTS: 'small_denomination_time_deposits',
}

export async function moneyMeasures(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const now = today(ctx)
  const start = str(params, 'start_date') ?? shiftDays(now, -10 * 365)
  const end = str(params, 'end_date') ?? now
  const adjusted = params.adjusted === undefined ? true : params.adjusted === true || params.adjusted === 'true'
  const { header, rows } = await ddpCsv(ctx, 'H6', '798e2796917702a5f8423426ba7e6b42')
  // OpenBB asks for "<code>_N.M" when `adjusted` is true (that is the not seasonally adjusted series); so does this.
  const columns = Object.keys(MONEY_TITLES).map((code) => header.indexOf(`${code}${adjusted ? '_N' : ''}.M`))
  const names = Object.values(MONEY_TITLES)
  const out: Row[] = []
  for (const r of rows) {
    const month = `${(r[0] ?? '').slice(0, 7)}-01`
    if (!inRange(month, start, end)) continue
    const row: Row = { month }
    columns.forEach((c, i) => {
      const v = c >= 0 ? num(r[c]) : undefined
      if (v !== undefined) row[names[i]!] = roundHalfEven(v * 1e9)
    })
    out.push(row)
  }
  return out.sort((a, b) => String(a.month).localeCompare(String(b.month)))
}
