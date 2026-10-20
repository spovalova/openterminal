// economy/balance_of_payments, provider oecd. Ported from openbb_oecd/models/balance_of_payments.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import { parseSdmxCsvLabels } from '../lib/sdmx.js'
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { areaLabel, countryCodes, countryParam, observation } from './common.js'
import { makeRequest, oecdDate } from './query-builder.js'

/** (MEASURE, ACCOUNTING_ENTRY, UNIT_MEASURE) → the field it fills. */
const COL_MAP: Record<string, string> = {
  'CA|B|PT_B1GQ': 'balance_percent_of_gdp',
  'CA|B|USD_EXC': 'balance_total',
  'S|B|USD_EXC': 'balance_total_services',
  'IN2|B|USD_EXC': 'balance_total_secondary_income',
  'G|B|USD_EXC': 'balance_total_goods',
  'IN1|B|USD_EXC': 'balance_total_primary_income',
  'S|C|PT_GS': 'credits_services_percent_of_goods_and_services',
  'S|C|PT_CA': 'credits_services_percent_of_current_account',
  'S|C|USD_EXC': 'credits_total_services',
  'G|C|USD_EXC': 'credits_total_goods',
  'IN1|C|USD_EXC': 'credits_total_primary_income',
  'IN2|C|USD_EXC': 'credits_total_secondary_income',
  'CA|C|USD_EXC': 'credits_total',
  'S|D|PT_GS': 'debits_services_percent_of_goods_and_services',
  'S|D|PT_CA': 'debits_services_percent_of_current_account',
  'S|D|USD_EXC': 'debits_total_services',
  'G|D|USD_EXC': 'debits_total_goods',
  'IN1|D|USD_EXC': 'debits_total_primary_income',
  'CA|D|USD_EXC': 'debits_total',
  'IN2|D|USD_EXC': 'debits_total_secondary_income',
}
const FREQ_MAP: Record<string, string> = { annual: 'A', quarterly: 'Q' }
const Q_MAP = ['Q1', 'Q1', 'Q1', 'Q2', 'Q2', 'Q2', 'Q3', 'Q3', 'Q3', 'Q4', 'Q4', 'Q4']

/** A date as the period the API takes for a frequency: the year, or the year and quarter. */
function periodOf(iso: string, freq: string): string {
  const year = iso.slice(0, 4)
  const month = Number(iso.slice(5, 7))
  if (freq === 'A') return year
  if (freq === 'Q') return `${year}-${Q_MAP[month - 1]}`
  return `${year}-${iso.slice(5, 7)}`
}

const sortedUnique = (index: number): string[] => [...new Set(Object.keys(COL_MAP).map((k) => k.split('|')[index]!))].sort()

export async function balanceOfPayments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const frequency = text(params, 'frequency') ?? 'quarterly'
  if (frequency !== 'annual' && frequency !== 'quarterly') throw new Error(`Input should be 'annual' or 'quarterly', got '${frequency}' (frequency)`)
  const startDate = text(params, 'start_date')
  const endDate = text(params, 'end_date')
  const freqCode = FREQ_MAP[frequency]!

  // The request names the measures, entries and units the output uses and nothing else.
  const countryStr = countryCodes('DF_BOP', country)
  const filter = `${countryStr}..${sortedUnique(0).join('+')}.${sortedUnique(1).join('+')}..${freqCode}.${sortedUnique(2).join('+')}.Y`
  let url = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_BOP@DF_BOP,1.0/${filter}`
  const query: string[] = []
  if (startDate) query.push(`startPeriod=${periodOf(startDate, freqCode)}`)
  if (endDate) query.push(`endPeriod=${periodOf(endDate, freqCode)}`)
  if (query.length > 0) url += `?${query.join('&')}`
  const res = await makeRequest(ctx, url)
  if (res.status !== 200) throw new Error(`OECD BOP request failed (${res.status}): ${res.statusText}`)
  const body = res.text
  if (!body || !body.trim()) throw new Error(`Empty response from OECD BOP. URL: ${url}`)
  const data = parseSdmxCsvLabels(body)
  if (data.length === 0) throw new Error(`No BOP data rows. URL: ${url}`)

  // Long rows into one record per date and country.
  const groups = new Map<string, Row>()
  for (const row of data) {
    const value = observation(row)
    if (value === undefined) continue
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined) continue
    if (startDate && d < startDate) continue
    if (endDate && d > endDate) continue
    const column = COL_MAP[`${row.MEASURE ?? ''}|${row.ACCOUNTING_ENTRY ?? ''}|${row.UNIT_MEASURE ?? ''}`]
    if (column === undefined) continue
    const countryName = areaLabel(row)
    const key = JSON.stringify([d, countryName])
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { period: d, country: countryName }))
    group[column] = column === 'balance_percent_of_gdp' || column.includes('percent') ? value / 100 : value
  }
  return [...groups.values()].sort((a, b) => ((a.period as string) < (b.period as string) ? -1 : (a.period as string) > (b.period as string) ? 1 : 0))
}
