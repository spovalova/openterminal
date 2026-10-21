// FX forward, FX option and CDS index trade extraction from DTCC PPD slice records. Ported from
// openbb_cftc/utils/fx_forwards.py, fx_options.py and cds.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dates
// are ISO strings.
import { CDS_INDEX_FISNS, CDS_STANDARD_TENORS, CDS_TENOR_TOLERANCE_YEARS, DAYS_PER_YEAR } from './constants.js'
import { parseDate, parseNotional, type Rec, type SliceRecord } from './curve.js'
import { diffDays, type D } from './dates.js'
import { pyRound } from '../helpers.js'

const sf = (r: SliceRecord, name: string): string => (r[name] ?? '').trim()
/** `str.split()` on whitespace. */
export const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean)

const NOT_PROVIDED = new Set(['9.9999999999'])

const OPTION_TYPES: Record<string, string> = {
  Van: 'Vanilla',
  NDO: 'Non-Deliverable',
  Dig: 'Digital',
  Bar: 'Barrier',
  DigBar: 'Digital Barrier',
  Targ: 'Target',
}

/** Readable option family from the FISN token (`option_type`). */
export function optionType(fisn: string): string | null {
  const parts = words(fisn)
  if (parts.length < 2 || parts[0] !== 'NA/O') return null
  return OPTION_TYPES[parts[1]!] ?? parts[1]!
}

/** A pair filter split into ISO currency codes (`_split_currencies`). */
export function splitCurrencies(pair: string): Set<string> {
  const cleaned = (pair || '').toUpperCase().replace(/\//g, '').replace(/ /g, '').replace(/,/g, '')
  const out = new Set<string>()
  for (let i = 0; i < cleaned.length; i += 3) out.add(cleaned.slice(i, i + 3))
  return out
}

/** Group a package's legs: they execute atomically at one price or spread (`_package_id`). */
export function packageId(record: SliceRecord): string | null {
  if (sf(record, 'Package indicator').toUpperCase() !== 'TRUE') return null
  const executed = sf(record, 'Execution Timestamp')
  let price = sf(record, 'Package transaction price')
  if (NOT_PROVIDED.has(price)) price = ''
  const level = price || sf(record, 'Package transaction spread')
  return executed ? `${executed}|${level}` : null
}

const isSubset = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x))

/** Newest reported event first, ties in their original order (`sort(key=..., reverse=True)`). */
function sortNewestFirst(rows: Rec[]): Rec[] {
  const key = (r: Rec): string => String(r['Event timestamp'] || r['Execution Timestamp'] || '')
  return rows
    .map((row, i) => ({ row, k: key(row), i }))
    .sort((a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : a.i - b.i))
    .map((x) => x.row)
}

/** A print's dissemination date, pair, option family, tenor and package key, or null (`curate_option`). */
function curateOption(record: SliceRecord, disseminationDate: D): Rec | null {
  const executed = parseDate(record['Execution Timestamp'])
  const expiry = parseDate(record['Expiration Date'])
  const legs = words(sf(record, 'UPI Underlier Name'))
  if (executed === null || expiry === null || legs.length !== 2) return null
  return { ...record, dissemination_date: disseminationDate, pair: `${legs[0]}/${legs[1]}`, option_type: optionType(sf(record, 'UPI FISN')), days_to_expiry: diffDays(expiry, executed), package_id: packageId(record) }
}

type TradeFilter = { pair?: string | null; actionType?: string | null; settled?: string | null; minNotional?: number | null; ticker?: string | null; limit?: number | null }

/** The FX option prints matching a query, newest reported event first (`extract_option_trades`). */
export function extractOptionTrades(records: Iterable<SliceRecord>, disseminationDate: D, o: TradeFilter & { optionKind?: string | null } = {}): Rec[] {
  const wanted = o.pair ? splitCurrencies(o.pair) : new Set<string>()
  const settle = o.settled ? o.settled.trim().toUpperCase() : null
  const upi = o.ticker ? o.ticker.trim().toUpperCase() : null
  const rows: Rec[] = []
  for (const record of records) {
    const fisn = sf(record, 'UPI FISN')
    if (!fisn.startsWith('NA/O ')) continue
    if (upi && sf(record, 'Unique Product Identifier').toUpperCase() !== upi) continue
    if (o.actionType && sf(record, 'Action type').toUpperCase() !== o.actionType.trim().toUpperCase()) continue
    if (o.optionKind && (optionType(fisn) ?? '').toUpperCase() !== o.optionKind.trim().toUpperCase()) continue
    const legs = new Set(words(sf(record, 'UPI Underlier Name').toUpperCase()))
    if (wanted.size > 0 && !isSubset(wanted, legs)) continue
    if (settle && sf(record, 'Settlement currency-Leg 1').toUpperCase() !== settle) continue
    if (o.minNotional !== null && o.minNotional !== undefined) {
      const [first] = parseNotional(record['Notional amount-Leg 1'])
      const [second] = parseNotional(record['Notional amount-Leg 2'])
      if (Math.max(first || 0.0, second || 0.0) < o.minNotional) continue
    }
    const row = curateOption(record, disseminationDate)
    if (row !== null) rows.push(row)
  }
  const sorted = sortNewestFirst(rows)
  return o.limit ? sorted.slice(0, o.limit) : sorted
}

const FORWARD_PRODUCTS: Record<string, string> = {
  'NA/Fwd': 'Forward',
  'NA/Fwd NDF': 'Non-Deliverable Forward',
  'NA/Swaps': 'FX Swap',
  'NA/Swaps NDS': 'Non-Deliverable Swap',
  'NA/FX Fwd Nstd': 'Non-Standard Forward',
}

/** Readable product from the FISN prefix, or null when it is not a plain forward or swap (`forward_product`). */
export function forwardProduct(fisn: string): string | null {
  const parts = words(fisn)
  if (parts.length < 3) return null
  return FORWARD_PRODUCTS[parts.slice(0, -2).join(' ')] ?? null
}

/** A print's dissemination date, pair, product, tenor and package key, or null (`curate_forward`). */
function curateForward(record: SliceRecord, disseminationDate: D): Rec | null {
  const executed = parseDate(record['Execution Timestamp'])
  const expiry = parseDate(record['Expiration Date'])
  const legs = words(sf(record, 'UPI Underlier Name'))
  if (executed === null || expiry === null || legs.length !== 2) return null
  return { ...record, dissemination_date: disseminationDate, pair: `${legs[0]}/${legs[1]}`, product_type: forwardProduct(sf(record, 'UPI FISN')), days_to_expiry: diffDays(expiry, executed), package_id: packageId(record) }
}

/** The FX forward and swap prints matching a query, newest reported event first (`extract_forward_trades`). */
export function extractForwardTrades(records: Iterable<SliceRecord>, disseminationDate: D, o: TradeFilter & { product?: string | null } = {}): Rec[] {
  const wanted = o.pair ? splitCurrencies(o.pair) : new Set<string>()
  const settle = o.settled ? o.settled.trim().toUpperCase() : null
  const upi = o.ticker ? o.ticker.trim().toUpperCase() : null
  const rows: Rec[] = []
  for (const record of records) {
    const productType = forwardProduct(sf(record, 'UPI FISN'))
    if (productType === null) continue
    if (upi && sf(record, 'Unique Product Identifier').toUpperCase() !== upi) continue
    if (o.actionType && sf(record, 'Action type').toUpperCase() !== o.actionType.trim().toUpperCase()) continue
    if (o.product && productType.toUpperCase() !== o.product.trim().toUpperCase()) continue
    const legs = new Set(words(sf(record, 'UPI Underlier Name').toUpperCase()))
    if (wanted.size > 0 && !isSubset(wanted, legs)) continue
    if (settle && sf(record, 'Settlement currency-Leg 1').toUpperCase() !== settle) continue
    if (o.minNotional !== null && o.minNotional !== undefined) {
      const [first] = parseNotional(record['Notional amount-Leg 1'])
      const [second] = parseNotional(record['Notional amount-Leg 2'])
      if (Math.max(first || 0.0, second || 0.0) < o.minNotional) continue
    }
    const row = curateForward(record, disseminationDate)
    if (row !== null) rows.push(row)
  }
  const sorted = sortNewestFirst(rows)
  return o.limit ? sorted.slice(0, o.limit) : sorted
}

/** Snap the years from execution to maturity onto a standard CDS index tenor (`tenor_at_execution`). */
export function tenorAtExecution(maturity: D, executed: D): string | null {
  const years = diffDays(maturity, executed) / DAYS_PER_YEAR
  if (years <= 0) return null
  let nearest: number = CDS_STANDARD_TENORS[0]
  for (const t of CDS_STANDARD_TENORS) if (Math.abs(years - t) < Math.abs(years - nearest)) nearest = t
  if (Math.abs(years - nearest) <= CDS_TENOR_TOLERANCE_YEARS) return `${nearest}Y`
  return `${Math.max(pyRound(years, 0), 1)}Y`
}

/** Whether a credits record is a CDS index print (`is_index_print`). */
export const isIndexPrint = (record: SliceRecord): boolean => (CDS_INDEX_FISNS as readonly string[]).includes(sf(record, 'UPI FISN'))

/** A print's dissemination date and tenor, or null when it cannot be dated (`curate_print`). */
function curatePrint(record: SliceRecord, disseminationDate: D): Rec | null {
  const maturity = parseDate(record['Expiration Date'])
  const executed = parseDate(record['Execution Timestamp'])
  if (maturity === null || executed === null) return null
  return { ...record, dissemination_date: disseminationDate, tenor: tenorAtExecution(maturity, executed) }
}

/** The CDS index prints matching a query, each curated into a row (`extract_prints`). */
export function extractPrints(records: Iterable<SliceRecord>, disseminationDate: D, o: { index?: string | null; tenor?: string | null; minNotional?: number | null; limit?: number | null } = {}): Rec[] {
  const rows: Rec[] = []
  for (const record of records) {
    if (!isIndexPrint(record)) continue
    if (o.index && sf(record, 'UPI Underlier Name').toUpperCase() !== o.index.trim().toUpperCase()) continue
    const row = curatePrint(record, disseminationDate)
    if (row === null) continue
    if (o.tenor && String(row.tenor ?? '').toUpperCase() !== o.tenor.trim().toUpperCase()) continue
    if (o.minNotional !== null && o.minNotional !== undefined) {
      const [notional] = parseNotional(record['Notional amount-Leg 1'])
      if (notional === null || notional < o.minNotional) continue
    }
    rows.push(row)
    if (o.limit && rows.length >= o.limit) break
  }
  return rows
}
