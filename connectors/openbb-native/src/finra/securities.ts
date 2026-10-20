// finra/equity/securities, provider finra. Ported from openbb_finra/models/equity_list.py, utils/directory.py and
// utils/generate_securities.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models,
// the bundled security-type asset (assets/security_types.json.gz) is embedded as security-types.json, and a symbol
// the asset does not know is left unclassified. OpenBB looks such symbols up in FINRA's Market Data Center
// (finra-markets.morningstar.com), which now redirects every request to a web page, so OpenBB itself fails
// whenever FINRA lists a symbol newer than its asset.
import { gunzipSync, strFromU8 } from 'fflate'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { queryApi, queryPartitions } from './client.js'
import { EQUITY_PRODUCT_TYPES, MARKET_DATA_DETAIL_URL, SECURITY_LIST_TYPES, SECURITY_TYPES } from './constants.js'
import { decode } from './helpers.js'
import { MARKET_NAMES } from './market-names.js'
import asset from './security-types.json' with { type: 'json' }

const TIERS = ['T1', 'T2', 'OTCE']
const SUMMARY_TYPES = ['ATS_W_SMBL', 'OTC_W_SMBL']
const UNIVERSE_FIELDS = ['issueSymbolIdentifier', 'issueName', 'tierDescription', 'productTypeCode']
/** The values of a classification, in the asset's order (`CLASS_FIELDS`). */
const CLASS_FIELDS = ['security_type', 'name', 'security_description', 'security_id', 'performance_id', 'exchange', 'listing_market_id', 'composite_exchange_id', 'country', 'domicile', 'currency', 'quote_symbol']

type Universe = Map<string, { issue_name: unknown; tier: unknown; product_type: unknown }>

/** The classification of every symbol known when the asset was built (the asset's `unresolved` symbols have none). */
function readAsset(ctx: NativeCtx): Promise<Record<string, (string | null)[]>> {
  return ctx.cache('finra:security_types', 7 * 24 * 3600 * 1000, async () => {
    const bytes = Uint8Array.from(Buffer.from(asset.data, 'base64'))
    return (JSON.parse(strFromU8(gunzipSync(bytes))) as { securities: Record<string, (string | null)[]> }).securities
  })
}

/** The newest published week of each tier (`latest_weeks`). */
function latestWeeks(partitions: string[][]): Map<string, string> {
  const weeks = new Map<string, string>()
  for (const p of partitions) {
    if (p.length > 1 && TIERS.includes(p[1]!)) weeks.set(p[1]!, [weeks.get(p[1]!) ?? p[0]!, p[0]!].sort().pop()!)
  }
  return weeks
}

/** Every symbol FINRA published OTC or ATS volume for in its latest weeks (`load_universe`). */
async function loadUniverse(ctx: NativeCtx): Promise<Universe> {
  const weeks = latestWeeks(await queryPartitions(ctx, 'otcMarket', 'weeklySummary'))
  const equal = (fieldName: string, fieldValue: string) => ({ compareType: 'EQUAL', fieldName, fieldValue })
  const jobs = [...weeks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([tier, week]) => SUMMARY_TYPES.map((summaryType) => ({ fields: UNIVERSE_FIELDS, compareFilters: [equal('weekStartDate', week), equal('tierIdentifier', tier), equal('summaryTypeCode', summaryType)] })))
  const pages = await Promise.all(jobs.map((payload) => queryApi(ctx, 'otcMarket', 'weeklySummary', payload)))

  const universe: Universe = new Map()
  for (const rows of pages) {
    for (const row of rows) {
      // First seen wins.
      const symbol = String(row.issueSymbolIdentifier || '').trim().toUpperCase()
      if (symbol && !universe.has(symbol)) universe.set(symbol, { issue_name: row.issueName, tier: row.tierDescription, product_type: row.productTypeCode })
    }
  }
  return universe
}

export async function securities(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const securityType = String(params.security_type ?? 'all')
  const [universe, classified] = await Promise.all([loadUniverse(ctx), readAsset(ctx)])

  const typed = new Set(Object.values(SECURITY_LIST_TYPES))
  const rows: Row[] = []
  for (const symbol of [...universe.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const classes = classified[symbol] ?? []
    const row: Row = { symbol, ...universe.get(symbol), ...Object.fromEntries(CLASS_FIELDS.map((f, i) => [f, classes[i]])) }
    const code = row.security_type as string | undefined
    if (securityType === 'other' ? typed.has(code as string) : securityType !== 'all' && code !== SECURITY_LIST_TYPES[securityType as keyof typeof SECURITY_LIST_TYPES]) continue

    const { listing_market_id: listing, composite_exchange_id: composite, ...values } = row
    const url = listing && row.performance_id ? `${MARKET_DATA_DETAIL_URL}?query=${String(listing)}:${String(row.performance_id)}` : undefined
    const out: Row = {
      ...values,
      security_type: decode(SECURITY_TYPES, code),
      product_type: decode(EQUITY_PRODUCT_TYPES, row.product_type),
      listing_market: decode(MARKET_NAMES, listing),
      composite_market: decode(MARKET_NAMES, composite),
      url,
    }
    rows.push(Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null)))
  }
  if (rows.length === 0) throw new Error(`No ${securityType} securities were found.`)
  return rows
}
