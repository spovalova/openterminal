// economy/balance_of_payments, provider imf. Ported from openbb_imf/models/balance_of_payments.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models; the countries the BOP dataflow offers come from
// the metadata data file.
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compareText } from './helpers.js'
import { dataflowParameters } from './metadata.js'
import { fetchImfData } from './query-builder.js'

const BALANCE_FIELD: Record<string, string> = { CAB: 'balance_total', G: 'balance_total_goods', S: 'balance_total_services', IN1: 'balance_total_primary_income', IN2: 'balance_total_secondary_income' }
const CREDIT_FIELD: Record<string, string> = { G: 'credits_total_goods', S: 'credits_total_services', IN1: 'credits_total_primary_income', IN2: 'credits_total_secondary_income' }
const DEBIT_FIELD: Record<string, string> = { G: 'debits_total_goods', S: 'debits_total_services', IN1: 'debits_total_primary_income', IN2: 'debits_total_secondary_income' }
const FREQ_CODE: Record<string, string> = { annual: 'A', quarterly: 'Q', monthly: 'M' }

/** The countries of the BOP dataflow: by name (`united_states`) and by ISO3 code. */
function bopCountries(): { labelToCode: Map<string, string>; codes: Set<string> } {
  const countries = [...(dataflowParameters('BOP').COUNTRY ?? [])].sort((a, b) => compareText(a.label, b.label))
  const labelToCode = new Map<string, string>()
  const codes = new Set<string>()
  for (const entry of countries) {
    if (!entry.value) continue
    codes.add(entry.value.toUpperCase())
    labelToCode.set(entry.label.toLowerCase().replace(/ /g, '_'), entry.value.toUpperCase())
  }
  return { labelToCode, codes }
}

/** Country names or ISO3 codes as the dataflow's `COUNTRY` selection (`validate_country`). */
function resolveCountry(raw: string): string {
  const { labelToCode, codes } = bopCountries()
  return raw.replace(/ /g, '_').split(',').map((token) => {
    const upper = token.toUpperCase()
    if (codes.has(upper)) return upper
    const code = labelToCode.get(token.toLowerCase())
    if (code !== undefined) return code
    throw new Error(`Country '${token}' is not in the IMF BOP dataflow's country list (value must be one of ${codes.size} ISO3 codes or matching country labels).`)
  }).join('+')
}

export async function balanceOfPayments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frequency = text(params, 'frequency') ?? 'quarterly'
  if (frequency !== 'annual' && frequency !== 'quarterly') throw new Error(`Input should be 'annual' or 'quarterly', got '${frequency}' (frequency)`)
  const country = resolveCountry(text(params, 'country') ?? 'USA')
  const { data } = await fetchImfData(ctx, 'BOP', {
    startDate: text(params, 'start_date'),
    endDate: text(params, 'end_date'),
    dimensions: { COUNTRY: country, BOP_ACCOUNTING_ENTRY: 'NETCD_T+CD_T+DB_T', INDICATOR: 'CAB+G+S+IN1+IN2', UNIT: 'USD', FREQUENCY: FREQ_CODE[frequency]! },
  })
  if (data.length === 0) throw new Error('No BOP data for the selected query.')

  // Long rows (one per indicator, entry and period) into one record per period and country.
  const groups = new Map<string, Row>()
  for (const row of data) {
    const indicator = String(row.INDICATOR_code || row.INDICATOR || '')
    const entry = (row.BOP_ACCOUNTING_ENTRY_code || row.BOP_ACCOUNTING_ENTRY) as string | undefined
    const field = entry === 'NETCD_T' ? BALANCE_FIELD[indicator] : entry === 'CD_T' ? CREDIT_FIELD[indicator] : entry === 'DB_T' ? DEBIT_FIELD[indicator] : undefined
    if (field === undefined) continue
    const period = row.TIME_PERIOD as string | undefined
    if (!period) continue
    const countryName = String(row.COUNTRY_label || row.COUNTRY_code || row.COUNTRY || '')
    const value = row.OBS_VALUE
    if (value === undefined || value === null || value === '') continue
    const fval = Number(value)
    const key = JSON.stringify([period, countryName])
    let bucket = groups.get(key)
    if (!bucket) groups.set(key, (bucket = { period, country: countryName }))
    bucket[field] = fval
  }

  const sum = (b: Row, fields: string[]): number | undefined => {
    const parts = fields.map((f) => b[f] as number | undefined).filter((v): v is number => v !== undefined)
    return parts.length === 4 ? parts.reduce((a, c) => a + c, 0) : undefined
  }
  for (const b of groups.values()) {
    const credits = sum(b, ['credits_total_goods', 'credits_total_services', 'credits_total_primary_income', 'credits_total_secondary_income'])
    const debits = sum(b, ['debits_total_goods', 'debits_total_services', 'debits_total_primary_income', 'debits_total_secondary_income'])
    if (credits !== undefined) b.credits_total = credits
    if (debits !== undefined) b.debits_total = debits
    const sc = b.credits_total_services as number | undefined
    const sd = b.debits_total_services as number | undefined
    const gc = b.credits_total_goods as number | undefined
    const gd = b.debits_total_goods as number | undefined
    const creditsTotal = b.credits_total as number | undefined
    const debitsTotal = b.debits_total as number | undefined
    if (sc !== undefined && gc !== undefined && sc + gc) b.credits_services_percent_of_goods_and_services = sc / (sc + gc)
    if (sc !== undefined && creditsTotal) b.credits_services_percent_of_current_account = sc / creditsTotal
    if (sd !== undefined && gd !== undefined && sd + gd) b.debits_services_percent_of_goods_and_services = sd / (sd + gd)
    if (sd !== undefined && debitsTotal) b.debits_services_percent_of_current_account = sd / debitsTotal
  }
  return [...groups.values()].sort((a, b) => compareText(String(a.period), String(b.period)) || compareText(String(a.country ?? ''), String(b.country ?? '')))
}
