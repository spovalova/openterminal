// CFETS/NIFC daily bulletin client for CNY interest rate swaps. Ported from openbb_cftc/utils/cfets.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: dates are ISO strings, bulletins are memoised with ctx.cache instead of the
// on-disk store.
import { pyRound } from '../helpers.js'
import type { NativeCtx } from '../../types.js'
import { EmptyDataError, pyFloat, type Rec, type SliceRecord } from './curve.js'
import { addDays, type D } from './dates.js'
import { pyCommaFixed, pyFixed } from './format.js'
import { words } from './trades.js'

const CFETS_IRS_BULLETIN_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-dlrp/IrsDlyBltn'
const MAX_BULLETIN_LOOKBACK_DAYS = 10

const IRS_LEG_CONVENTIONS: Record<string, { day_count: string; basis: number; payment_period_days: number }> = {
  FR007: { day_count: 'ACT/365F', basis: 365.0, payment_period_days: 91 },
  SHIBOR3M: { day_count: 'ACT/360', basis: 360.0, payment_period_days: 91 },
  'SHIBORO/N': { day_count: 'ACT/360', basis: 360.0, payment_period_days: 91 },
  LPR1Y: { day_count: 'ACT/365F', basis: 365.0, payment_period_days: 91 },
  LPR5Y: { day_count: 'ACT/365F', basis: 365.0, payment_period_days: 91 },
}

/** Whether a print names CNY in its FISN or underlier (`mentions_cny`). */
export function mentionsCny(record: SliceRecord): boolean {
  return [...words(record['UPI Underlier Name'] ?? ''), ...words(record['UPI FISN'] ?? '')].includes('CNY')
}

/** A reference-rate name collapsed to its case- and space-insensitive key (`normalize_reference`). */
export const normalizeReference = (name: string): string => (name || '').replace(/ /g, '').toUpperCase()

/** The current trading date in China Coordinated Time (UTC+8) (`_today_cct`). */
const todayCct = (now: Date): D => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)

type Bulletin = {
  head?: { rep_code?: string }
  records?: BulletinRecord[]
  data?: { lastDate?: string }
}
type BulletinRecord = { refIntrstRateNmEn?: string; refIntrstRateNm?: string; rateList?: { wghtdAvgFxngRate?: unknown; sortNo?: unknown; trdVol?: unknown; prd?: string }[] }

/** POST the daily bulletin service for one search date (`_download_bulletin`). */
async function downloadBulletin(ctx: NativeCtx, searchDate: string): Promise<Bulletin> {
  let payload: Bulletin
  try {
    const text = await ctx.http.text(CFETS_IRS_BULLETIN_URL, {
      method: 'POST',
      body: `lang=en&searchDate=${searchDate}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Referer: 'https://www.chinamoney.com.cn/english/mdtrptdbl/',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })
    payload = JSON.parse(text) as Bulletin
  } catch (err) {
    throw new Error(`Failed to fetch the IRS bulletin -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if ((payload.head ?? {}).rep_code !== '200' || !payload.records || payload.records.length === 0) throw new Error(`Unexpected IRS bulletin response from CFETS for ${searchDate}.`)
  return payload
}

/** One day's IRS bulletin (`fetch_irs_bulletin`). */
export async function fetchIrsBulletin(ctx: NativeCtx, searchDate: D | null): Promise<Bulletin> {
  const today = todayCct(ctx.now())
  const target = searchDate ?? today
  return ctx.cache(`cfets-irs-bulletin:${target}`, 1800_000, async () => {
    let payload: Bulletin = {}
    for (let offset = 0; offset < MAX_BULLETIN_LOOKBACK_DAYS; offset++) {
      try {
        payload = await downloadBulletin(ctx, addDays(target, -offset))
        break
      } catch (err) {
        if (offset === MAX_BULLETIN_LOOKBACK_DAYS - 1) throw err
      }
    }
    return payload
  })
}

/** The FR007 par curve as tape-shaped CNY IRS records, for curve building (`cny_curve_records`). */
export async function cnyCurveRecords(ctx: NativeCtx, day: D): Promise<SliceRecord[]> {
  let nodes: Rec[]
  try {
    const payload = await fetchIrsBulletin(ctx, day)
    nodes = bulletinNodes(payload, 'FR007')
  } catch {
    return []
  }
  return nodes.map((node) => {
    const volume = node.volume as number | null
    const notional = volume ? volume * 1_000_000.0 : 1_000_000.0
    return {
      'UPI FISN': 'NA/Swap Fxd Flt CNY',
      'UPI Underlier Name': 'CNY-CNREPOFIX=CFXS-Reuters',
      'Action type': 'NEWT',
      'Event type': 'TRAD',
      'Notional currency-Leg 1': 'CNY',
      'Notional currency-Leg 2': 'CNY',
      'Fixed rate-Leg 1': pyFixed(node.par_rate as number, 8),
      'Effective Date': day,
      'Expiration Date': addDays(day, node.tenor_days as number),
      'Notional amount-Leg 1': pyCommaFixed(notional, 0),
      'Fixed rate day count convention-leg 1': 'A005',
      'Fixed rate payment frequency period-Leg 1': 'MNTH',
      'Fixed rate payment frequency period multiplier-Leg 1': '3',
      Cleared: 'Y',
      'Dissemination Timestamp': `${day}T00:00:00Z`,
    }
  })
}

/** The reference rates the bulletin published, in its own order (`bulletin_reference_names`). */
export const bulletinReferenceNames = (payload: Bulletin): string[] => (payload.records ?? []).map((r) => r.refIntrstRateNmEn || r.refIntrstRateNm || '')

/** `float(value)` for a JSON value; null where Python raises. */
function floatOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return pyFloat(v)
  return null
}

/** `int(value)` for a JSON value; null where Python raises. */
function intOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v.trim())
  return null
}

/** One reference rate's traded par nodes, sorted by tenor (`bulletin_nodes`). */
export function bulletinNodes(payload: Bulletin, referenceRate: string): Rec[] {
  const wanted = normalizeReference(referenceRate)
  const conventions = IRS_LEG_CONVENTIONS[wanted]
  for (const record of payload.records ?? []) {
    const name = record.refIntrstRateNmEn || record.refIntrstRateNm || ''
    if (normalizeReference(name) !== wanted) continue
    const nodes: Rec[] = []
    for (const row of record.rateList ?? []) {
      const rate = floatOf(row.wghtdAvgFxngRate)
      const days = intOf(row.sortNo)
      if (rate === null || days === null) continue
      const volume = floatOf(row.trdVol)
      nodes.push({
        tenor: (row.prd ?? '').trim(),
        tenor_days: days,
        tenor_years: pyRound(days / 365.0, 6),
        par_rate: rate / 100.0,
        volume,
        is_fixing: false,
        day_count: conventions?.day_count ?? null,
        day_count_basis: conventions?.basis ?? null,
        payment_period_days: conventions?.payment_period_days ?? null,
      })
    }
    nodes.sort((a, b) => (a.tenor_days as number) - (b.tenor_days as number))
    return nodes
  }
  const available = bulletinReferenceNames(payload).filter(Boolean).join(', ')
  throw new EmptyDataError(`'${referenceRate}' was not published in the bulletin for ${payload.data?.lastDate}.` + (available ? ` Published reference rates: ${available}.` : ''))
}
