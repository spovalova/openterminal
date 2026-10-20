// ecb/eligible_assets, provider ecb. Ported from openbb_ecb/models/eligible_assets.py and the eligible-assets part of
// utils/non_sdmx.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, the UTF-16
// tab-separated file read with TextDecoder and lib/csv.
import { gunzipSync } from 'fflate'
import { parseCsvRecords } from '../lib/csv.js'
import { pyFloat, type SdmxRecord } from '../lib/sdmx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cachedRecords, flag, localDate, PLAIN_HEADERS, text, whole } from './helpers.js'

const BASE = 'https://www.ecb.europa.eu/paym/coll/assets/html/dla/ea_MID/ea_csv_'

const ASSET_TYPE: Record<string, string> = {
  AT01: 'Bond',
  AT02: 'Medium-term note',
  AT03: 'Treasury bill / commercial paper / certificate of deposit',
  AT10: 'EEA legislative covered bond',
  AT11: 'Asset-backed security (ABS)',
  AT12: 'Multi-cédulas',
  AT13: 'Non-EEA G10 legislative covered bond',
}
const ISSUER_GROUP: Record<string, string> = {
  IG1: 'Central bank',
  IG2: 'Central government',
  IG3: 'Corporate and other issuers',
  IG4: 'Credit institution (excluding agencies)',
  IG5: 'Regional/local government',
  IG6: 'Supranational issuer',
  IG7: 'Agency – non-credit institution',
  IG8: 'Agency – credit institution',
  IG9: 'Financial corporation other than credit institution',
  IG11: 'Public corporation',
}
const HAIRCUT_CATEGORY: Record<string, string> = {
  L1A: 'Category I – central government, EU, central banks',
  L1B: 'Category II – regional/local govt, agencies, supranationals, covered bonds',
  L1C: 'Category III – corporate and other issuers',
  L1D: 'Category IV – unsecured credit-institution debt',
  L1E: 'Category V – asset-backed securities',
}
const COUPON_DEFINITION: Record<string, string> = { CD1: 'Zero', CD2: 'Variable', CD4: 'Fixed' }
const COUNTRY: Record<string, string> = {
  AT: 'Austria', AU: 'Australia', BE: 'Belgium', BG: 'Bulgaria', CA: 'Canada', CH: 'Switzerland', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', EE: 'Estonia', ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GR: 'Greece', HR: 'Croatia', HU: 'Hungary', IE: 'Ireland', IS: 'Iceland', IT: 'Italy', JP: 'Japan', LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', MT: 'Malta', NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand', PL: 'Poland', PT: 'Portugal', RO: 'Romania', SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia', US: 'United States',
}
const byLabel = (m: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]))

/** File column → OpenBB field. */
const FIELDS: Record<string, string> = {
  ISIN_CODE: 'isin',
  HAIRCUT_CATEGORY: 'haircut_category',
  TYPE: 'asset_type',
  REFERENCE_MARKET: 'reference_market',
  DENOMINATION: 'currency',
  ISSUANCE_DATE: 'issuance_date',
  MATURITY_DATE: 'maturity_date',
  'COUPON_RATE (%)': 'coupon_rate',
  COUPON_DEFINITION: 'coupon_definition',
  ISSUER_NAME: 'issuer_name',
  ISSUER_RESIDENCE: 'issuer_residence',
  ISSUER_GROUP: 'issuer_group',
  GUARANTOR_NAME: 'guarantor_name',
  GUARANTOR_RESIDENCE: 'guarantor_residence',
  HAIRCUT: 'haircut',
  HAIRCUT_OWN_USE: 'haircut_own_use',
  POTENTIALLY_OWN_USABLE_COVERED_BOND: 'covered_bond',
  CLIMATE_FACTOR: 'climate_factor',
}
const DATE_FIELDS = new Set(['issuance_date', 'maturity_date'])
const FLOAT_FIELDS = new Set(['coupon_rate', 'haircut', 'haircut_own_use', 'climate_factor'])

/** `DD/MM/YYYY HH:MM:SS` → `YYYY-MM-DD`. */
function parseEaDate(value: string): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined
}

/** The tab-separated assets file, UTF-16 with a byte order mark. */
function parseEligibleAssetsCsv(raw: Uint8Array): SdmxRecord[] {
  const bigEndian = raw[0] === 0xfe && raw[1] === 0xff
  const csv = new TextDecoder(bigEndian ? 'utf-16be' : 'utf-16le').decode(raw)
  const rows: SdmxRecord[] = []
  for (const row of parseCsvRecords(csv, '\t')) {
    const record: SdmxRecord = {}
    for (const [column, field] of Object.entries(FIELDS)) {
      const value = (row[column] ?? '').trim()
      if (!value) continue
      if (DATE_FIELDS.has(field)) record[field] = parseEaDate(value) ?? null
      else if (FLOAT_FIELDS.has(field)) {
        const n = pyFloat(value)
        record[field] = n === undefined ? null : n
      } else record[field] = value
    }
    if (record.isin) rows.push(record)
  }
  return rows
}

/** The list for the nearest day with a file, looking back up to a week from `base` (`fetch_eligible_assets`). */
async function fetchEligibleAssets(ctx: NativeCtx, base: string): Promise<{ day: string; rows: SdmxRecord[] }> {
  for (let back = 0; back < 8; back++) {
    const day = new Date(Date.parse(`${base}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10)
    const stamp = `${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}`
    const res = await ctx.http.response(`${BASE}${stamp}.csv.gz`, { headers: PLAIN_HEADERS })
    let raw = new Uint8Array(await res.arrayBuffer())
    if (res.status === 200 && raw.length > 0) {
      try {
        raw = gunzipSync(raw)
      } catch {
        // already plain
      }
      return { day, rows: parseEligibleAssetsCsv(raw) }
    }
  }
  throw new Error(`No eligible-assets file found near ${base} (checked the prior 7 days).`)
}

const toCode = (value: string | undefined, labels: Record<string, string>): string | undefined => (value ? (labels[value] ?? value) : undefined)

/** `<prefix><ISO2>` → the country's name. */
function decodeCountry(code: string, prefix: string): string {
  if (code.toUpperCase().startsWith(prefix) && code.length >= prefix.length + 2) {
    const iso2 = code.slice(prefix.length, prefix.length + 2).toUpperCase()
    return COUNTRY[iso2] ?? code
  }
  return code
}

/** `RM<ISO2><nn>` → `<country> (<nn>)`. */
function decodeReferenceMarket(code: string): string {
  if (code.toUpperCase().startsWith('RM') && code.length >= 4) {
    const country = COUNTRY[code.slice(2, 4).toUpperCase()] ?? code.slice(2, 4)
    const rest = code.slice(4)
    return rest ? `${country} (${rest})` : country
  }
  return code
}

/** Replace the MID codes with their labels. */
function decode(row: SdmxRecord): Row {
  const out: Row = { ...row }
  for (const [field, mapping] of [['asset_type', ASSET_TYPE], ['issuer_group', ISSUER_GROUP], ['haircut_category', HAIRCUT_CATEGORY], ['coupon_definition', COUPON_DEFINITION]] as const) {
    const code = row[field] as string | undefined
    if (code) out[field] = mapping[code] ?? code
  }
  for (const field of ['issuer_residence', 'guarantor_residence']) {
    const code = row[field] as string | undefined
    if (code) out[field] = decodeCountry(code, 'IR')
  }
  if (row.reference_market) out.reference_market = decodeReferenceMarket(row.reference_market as string)
  return out
}

export async function eligibleAssets(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const date = text(params, 'date')
  const rows = await cachedRecords(ctx, 'eligible_assets', JSON.stringify({ date: date ?? 'latest' }), flag(params, 'use_cache', true), async () => {
    const { day, rows: loaded } = await fetchEligibleAssets(ctx, date ?? localDate(ctx.now()))
    return loaded.map((r) => ({ ...r, snapshot_date: day }))
  })

  const isinParam = text(params, 'isin')
  const isins = isinParam ? new Set(isinParam.split(',').map((i) => i.trim().toUpperCase())) : undefined
  const assetType = toCode(text(params, 'asset_type'), byLabel(ASSET_TYPE))
  const haircut = toCode(text(params, 'haircut_category'), byLabel(HAIRCUT_CATEGORY))
  const issuerGroup = toCode(text(params, 'issuer_group'), byLabel(ISSUER_GROUP))
  const currency = text(params, 'currency')

  let filtered = rows.filter((row) => {
    if (isins && !isins.has(((row.isin as string | undefined) ?? '').toUpperCase())) return false
    if (assetType && row.asset_type !== assetType) return false
    if (haircut && row.haircut_category !== haircut) return false
    if (currency && row.currency !== currency.toUpperCase()) return false
    return !(issuerGroup && row.issuer_group !== issuerGroup)
  })
  const limit = whole(params, 'limit')
  if (limit) filtered = filtered.slice(0, limit)
  if (filtered.length === 0) throw new Error('No eligible assets matched the query.')
  return filtered.map(decode)
}
