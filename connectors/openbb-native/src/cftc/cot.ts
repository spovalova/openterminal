// cftc/cot, cot_search, cot_index, cot_movers and cot_positioning, provider cftc. Ported from
// openbb_cftc/models/{cot,cot_search,cot_index,cot_movers,cot_positioning}.py and utils/cot_markets.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models; cot_index, cot_movers and
// cot_positioning ask Socrata only for the columns they score (and, for the first two, only the newest
// lookback_weeks + 1 reports) where Python downloads each market's whole report history, which gives the same
// scores; no on-disk response cache.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { COT_FIELDS, COT_SOURCE_TO_FIELD } from './cot-fields.js'
import { pyQuote, pyRound, REPORTS, reportKey, reportedNumber, socrataJson, SOCRATA, weekday, type SocrataRow } from './helpers.js'

type Rec = Record<string, unknown>

const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === '' || v === 0 || v === false)
const flag = (v: unknown, dflt: boolean): boolean => (v === undefined ? dflt : v === true || v === 'true')
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const iso = (d: Date): string => d.toISOString().slice(0, 10)

// ---- cftc/cot ------------------------------------------------------------------------------------------------------

/** `str.strip(chars)`. */
function stripChars(s: string, chars: string): string {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a]!)) a++
  while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

type CotQuery = { code: string; startDate?: string; endDate?: string; reportType: string; futuresOnly: boolean }

/** The Socrata URL of a COT query (the query half of `CftcCotFetcher.aextract_data`). */
function cotUrl(q: CotQuery, now: Date, extra: { select?: string[]; newest?: number } = {}): { url: string; id: string } {
  let id = q.code === 'all' ? '' : q.code
  if (id.startsWith('CFTC_')) id = id.slice(5)
  const isCode = id !== '' && /^\d{3}/.test(id)
  // Free-text searches default to the latest report (the last Tuesday); codes to the whole history.
  const defaultStart = isCode ? '1995-01-01' : iso(new Date(now.getTime() - ((weekday(now) - 1 + 7) % 7) * 86_400_000))
  const startDate = q.startDate ?? defaultStart
  const endDate = q.endDate ?? `${now.getUTCFullYear()}-12-31`
  const dateRange = `$where=Report_Date_as_YYYY_MM_DD between '${startDate}' AND '${endDate}'`
  const key = reportKey(q.reportType, q.futuresOnly)
  if (!isCode && id) id = `%${id}%`
  id = id.replace(/\+/g, '%2B').replace(/&/g, '%26')
  const limit = extra.newest ?? 1000000
  const select = extra.select ? `&$select=${extra.select.join(',')}` : ''
  const base = `${SOCRATA}/${REPORTS[key]}.json?$limit=${limit}${select}&${dateRange}`
  const order = extra.newest ? '&$order=Report_Date_as_YYYY_MM_DD DESC' : '&$order=Report_Date_as_YYYY_MM_DD ASC'
  const filtered = id
    ? `${base} AND (UPPER(contract_market_name) like UPPER('${id}') OR UPPER(commodity) like UPPER('${id}') OR UPPER(cftc_contract_market_code) like UPPER('${id}') OR UPPER(commodity_group_name) like UPPER('${id}') OR UPPER(commodity_subgroup_name) like UPPER('${id}'))`
    : base
  return { url: `${filtered}${order}`, id }
}

async function fetchCot(ctx: NativeCtx, q: CotQuery, extra?: { select?: string[]; newest?: number }): Promise<SocrataRow[]> {
  const { url, id } = cotUrl(q, ctx.now(), extra)
  const response = await socrataJson(ctx, url)
  if (!Array.isArray(response) || response.length === 0) throw new Error(`No data found for ${id.replace(/%/g, '')}.`)
  return response as SocrataRow[]
}

const STRING_COLS = new Set([
  'market_and_exchange_names', 'cftc_contract_market_code', 'cftc_market_code', 'cftc_region_code', 'cftc_commodity_code', 'cftc_contract_market_code_quotes', 'cftc_market_code_quotes', 'cftc_commodity_code_quotes', 'cftc_subgroup_code',
  'commodity_group_name', 'commodity', 'commodity_name', 'commodity_subgroup_name', 'contract_units', 'yyyy_report_week_ww', 'id', 'futonly_or_combined',
])

/** `int(value)` for a string; null when Python would raise ValueError. */
const pyInt = (v: unknown): number | null => (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? Number(v.trim()) : typeof v === 'number' && Number.isInteger(v) ? v : null)

/** Columns kept by `measure` besides the metadata (`transform_data`). */
const METADATA = new Set(['market_and_exchange_names', 'cftc_contract_market_code', 'cftc_market_code', 'cftc_region_code', 'cftc_commodity_code', 'cftc_contract_market_code_quotes', 'cftc_market_code_quotes', 'cftc_commodity_code_quotes', 'cftc_subgroup_code', 'commodity', 'commodity_group', 'commodity_subgroup', 'futonly_or_combined', 'contract_units', 'contract_market_name', 'report_week', 'id'])
const MEASURE_PREFIX: Record<string, string> = { changes: 'change_', percent_of_oi: 'open_interest_pct_', traders: 'traders_', concentration: 'concentration_' }

function transformCot(raw: SocrataRow[], measure: string, limit: number | undefined): Row[] {
  let rows: Rec[] = []
  for (const values of raw) {
    const nv: Rec = {}
    for (const [key, value] of Object.entries(values)) {
      const lower = key.toLowerCase()
      if (key === 'report_date_as_yyyy_mm_dd' && truthy(value)) nv[key] = String(value).split('T')[0]
      else if (STRING_COLS.has(key) && truthy(value)) {
        let v = String(value)
        if (key === 'contract_units') v = stripChars(v, '()')
        nv[lower] = v
      } else if (lower.startsWith('pct_') && truthy(value)) nv[lower.replace(/__/g, '_')] = Number(value) / 100
      else if (lower.startsWith('conc_') && truthy(value)) nv[lower.replace(/__/g, '_')] = Number(value)
      else if (truthy(value)) nv[lower.replace(/__/g, '_')] = pyInt(value) ?? value
    }
    if (Object.keys(nv).length === 0) continue
    // The model renames the Socrata columns it knows (`__alias_dict__`).
    rows.push(Object.fromEntries(Object.entries(nv).map(([k, v]) => [COT_SOURCE_TO_FIELD[k] ?? k, v])))
  }

  if (rows.length > 0) {
    // Fields that repeat their "all" or unnumbered twin on every report are blanked.
    const sample = new Set([...COT_FIELDS, ...Object.keys(rows[0]!)])
    const dup = new Set<string>()
    for (const fname of sample) {
      let base: string | null = null
      if (fname.endsWith('_old') || fname.endsWith('_other')) base = `${fname.slice(0, fname.lastIndexOf('_'))}_all`
      else if (fname.endsWith('_1') || fname.endsWith('_2')) base = fname.slice(0, -2)
      if (base === null || !sample.has(base)) continue
      const paired = rows.map((r) => [r[base!], r[fname]] as const).filter(([a, b]) => a !== undefined && a !== null && b !== undefined && b !== null)
      if (paired.length > 0 && paired.every(([a, b]) => a === b)) dup.add(fname)
    }
    if (dup.size > 0) rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !dup.has(k))))
  }

  if (measure !== 'all' && rows.length > 0) {
    const keep = (name: string): boolean => {
      if (name === 'date' || name === 'open_interest_all') return true
      if (METADATA.has(name)) return false
      if (measure === 'positions') return !Object.values(MEASURE_PREFIX).some((p) => name.startsWith(p))
      return name.startsWith(MEASURE_PREFIX[measure]!)
    }
    const keepFields = new Set<string>(['date', 'open_interest_all'])
    for (const r of rows) for (const [f, v] of Object.entries(r)) if (keep(f) && v !== null && v !== undefined && v !== 0) keepFields.add(f)
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keepFields.has(k))))
  }

  rows.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
  if (limit !== undefined && limit > 0) rows = rows.slice(-limit)
  return rows
}

async function cot(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const code = str(params.code)
  if (!code) throw new Error('A market code is required.')
  const reportType = str(params.report_type) ?? 'legacy'
  const raw = await fetchCot(ctx, { code, startDate: str(params.start_date), endDate: str(params.end_date), reportType, futuresOnly: flag(params.futures_only, false) })
  const limit = params.limit === undefined || params.limit === '' ? undefined : Number(params.limit)
  return transformCot(raw, str(params.measure) ?? 'all', limit)
}

// ---- cftc/cot_search -----------------------------------------------------------------------------------------------

const SUBCATEGORY = {
  currency_non_major: 'CURRENCY(NON-MAJOR)',
  digital_asset_non_major: 'DIGITAL ASSET (NON-MAJOR)',
  foodstuffs_softs: 'FOODSTUFFS/SOFTS',
  interest_rates_non_us_treasury: 'INTEREST RATES - NON U.S. TREASURY',
  interest_rates_us_treasury: 'INTEREST RATES - U.S. TREASURY',
  livestock_meat_products: 'LIVESTOCK/MEAT PRODUCTS',
  oilseed_and_products: 'OILSEED AND PRODUCTS',
} as Record<string, string>

async function cotSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = reportKey(str(params.report_type) ?? 'legacy', flag(params.futures_only, false))
  const select = 'cftc_contract_market_code,contract_market_name,commodity_name,commodity_group_name,commodity_subgroup_name,contract_units'
  let url = `${SOCRATA}/${REPORTS[key]}.json?$select=${select}&$group=${select}&$limit=50000&$order=commodity_group_name,commodity_subgroup_name,contract_market_name`
  const search = str(params.query)
  const where: string[] = []
  const cutoff = iso(new Date(ctx.now().getTime() - 52 * 7 * 86_400_000))
  where.push(`Report_Date_as_YYYY_MM_DD > '${cutoff}'`)
  if (search) {
    const escaped = search.replace(/'/g, "''")
    where.push(`(UPPER(contract_market_name) like UPPER('%${escaped}%') OR UPPER(cftc_contract_market_code) like UPPER('%${escaped}%') OR UPPER(commodity_name) like UPPER('%${escaped}%') OR UPPER(commodity_group_name) like UPPER('%${escaped}%') OR UPPER(commodity_subgroup_name) like UPPER('%${escaped}%'))`)
  }
  const category = str(params.category)
  if (category) where.push(`UPPER(commodity_group_name) = '${category.replace(/_/g, ' ').toUpperCase()}'`)
  const subcategory = str(params.subcategory)
  if (subcategory) where.push(`UPPER(commodity_subgroup_name) = '${SUBCATEGORY[subcategory] ?? subcategory.replace(/_/g, ' ').toUpperCase()}'`)
  url += `&$where=${pyQuote(where.join(' AND '))}`

  const response = await socrataJson(ctx, url)
  if (!Array.isArray(response) || response.length === 0) throw new Error(search ? `No results found for '${search}'.` : 'No results returned from the CFTC API.')
  const out: Row[] = []
  const seen = new Set<string>()
  for (const d of response as Rec[]) {
    const code = (d.cftc_contract_market_code as string | undefined) ?? ''
    if (!code || seen.has(code)) continue
    seen.add(code)
    const name = ((d.commodity_name as string | undefined) ?? '').trim().toUpperCase()
    if (!('commodity_group_name' in d) && name.endsWith('INDICES')) {
      d.commodity_group_name = 'FINANCIAL INSTRUMENTS'
      d.commodity_subgroup_name = 'STOCK INDICES'
    } else if (!('commodity_group_name' in d) && name.includes('CRYPTO')) {
      d.commodity_group_name = 'FINANCIAL INSTRUMENTS'
      d.commodity_subgroup_name = 'DIGITAL ASSET (NON-MAJOR)'
    }
    d.cftc_contract_market_code = `CFTC_${code}`
    const alias: Record<string, string> = { cftc_contract_market_code: 'code', contract_market_name: 'name', commodity_group_name: 'category', commodity_subgroup_name: 'subcategory' }
    out.push(Object.fromEntries(Object.entries(d).map(([k, v]) => [alias[k] ?? k, v])))
  }
  return out
}

// ---- the positioning scores (cot_index, cot_movers, cot_positioning) ---------------------------------------------------

const GROUP_LABELS: Record<string, string> = { large_specs: 'Large Specs', small_specs: 'Small Specs', commercials: 'Commercials' }
const TRADER_GROUPS: Record<string, [string, string]> = {
  large_specs: ['noncomm_positions_long_all', 'noncomm_positions_short_all'],
  small_specs: ['nonrept_positions_long_all', 'nonrept_positions_short_all'],
  commercials: ['comm_positions_long_all', 'comm_positions_short_all'],
}
const EXTREME_LOW = 15.0
const EXTREME_HIGH = 85.0
const SCORED_COLUMNS = ['report_date_as_yyyy_mm_dd', 'open_interest_all', ...Object.values(TRADER_GROUPS).flat()]

type Market = { code: string; label: string; asset_class: string; contract: string }
const m = (code: string, label: string, asset_class: string, contract: string): Market => ({ code: `CFTC_${code}`, label, asset_class, contract })
/** The curated market universe, pinned to exact contract market codes (`COT_MARKETS`). */
const COT_MARKETS: Market[] = [
  m('13874+', 'S&P 500', 'indices_bonds', 'S&P 500 Consolidated'),
  m('20974+', 'Nasdaq', 'indices_bonds', 'NASDAQ-100 Consolidated'),
  m('12460+', 'Dow', 'indices_bonds', 'DJIA Consolidated'),
  m('239742', 'Russell', 'indices_bonds', 'RUSSELL E-MINI'),
  m('042601', '2Y Note', 'indices_bonds', 'UST 2Y NOTE'),
  m('044601', '5Y Note', 'indices_bonds', 'UST 5Y NOTE'),
  m('043602', '10Y Treasury', 'indices_bonds', 'UST 10Y NOTE'),
  m('020601', '30Y Bond', 'indices_bonds', 'UST BOND'),
  m('098662', 'US Dollar', 'currencies', 'USD INDEX'),
  m('099741', 'Euro', 'currencies', 'EURO FX'),
  m('097741', 'Yen', 'currencies', 'JAPANESE YEN'),
  m('096742', 'Pound', 'currencies', 'BRITISH POUND'),
  m('092741', 'Franc', 'currencies', 'SWISS FRANC'),
  m('133741', 'Bitcoin', 'currencies', 'BITCOIN'),
  m('088691', 'Gold', 'hard_commodities', 'GOLD'),
  m('084691', 'Silver', 'hard_commodities', 'SILVER'),
  m('085692', 'Copper', 'hard_commodities', 'COPPER- #1'),
  m('076651', 'Platinum', 'hard_commodities', 'PLATINUM'),
  m('075651', 'Palladium', 'hard_commodities', 'PALLADIUM'),
  m('023651', 'Nat Gas', 'hard_commodities', 'NAT GAS NYME'),
  m('111659', 'Gasoline', 'hard_commodities', 'GASOLINE RBOB'),
  m('067411', 'WTI Oil', 'hard_commodities', 'CRUDE OIL, LIGHT SWEET-WTI'),
  m('06765T', 'Brent Oil', 'hard_commodities', 'BRENT LAST DAY'),
  m('002602', 'Corn', 'soft_commodities', 'CORN'),
  m('005602', 'Soybeans', 'soft_commodities', 'SOYBEANS'),
  m('080732', 'Sugar', 'soft_commodities', 'SUGAR NO. 11'),
  m('001602', 'Wheat', 'soft_commodities', 'WHEAT-SRW'),
  m('007601', 'Bean Oil', 'soft_commodities', 'SOYBEAN OIL'),
  m('026603', 'Bean Meal', 'soft_commodities', 'SOYBEAN MEAL'),
  m('083731', 'Coffee', 'soft_commodities', 'COFFEE C'),
  m('073732', 'Cocoa', 'soft_commodities', 'COCOA'),
  m('033661', 'Cotton', 'soft_commodities', 'COTTON NO. 2'),
  m('058644', 'Lumber', 'soft_commodities', 'LUMBER'),
  m('040701', 'Orange Juice', 'soft_commodities', 'FRZN CONCENTRATED ORANGE JUICE'),
]

const marketsFor = (assetClass: string): Market[] => (assetClass === 'all' ? [...COT_MARKETS] : COT_MARKETS.filter((x) => x.asset_class === assetClass))

/** Where the latest net position sits in its own range, 0 to 100 (`positioning_score`). */
function positioningScore(nets: number[]): number | null {
  if (nets.length === 0) return null
  const low = Math.min(...nets)
  const high = Math.max(...nets)
  if (high === low) return 50.0
  return pyRound((100.0 * (nets[nets.length - 1]! - low)) / (high - low), 1)
}

/** The commercials' score on the shared exposure scale: the hedging side is inverted. */
const exposureScore = (score: number | null, group: string): number | null => (score === null || group !== 'commercials' ? score : pyRound(100.0 - score, 1))

/** Net position per report, oldest first, for one trader group. */
function netSeries(rows: Rec[], group: string): number[] {
  const [longField, shortField] = TRADER_GROUPS[group]!
  const out: number[] = []
  for (const row of rows) {
    const longs = reportedNumber(row[longField])
    const shorts = reportedNumber(row[shortField])
    if (longs !== null && shorts !== null) out.push(longs - shorts)
  }
  return out
}

function zoneFor(score: number | null, group: string): string | null {
  if (score === null) return null
  const zones = group === 'commercials' ? ['exposed', 'neutral', 'heavily hedged'] : ['under-owned', 'neutral', 'crowded']
  if (score <= EXTREME_LOW) return zones[0]!
  if (score >= EXTREME_HIGH) return zones[2]!
  return zones[1]!
}

const dateOf = (r: Rec): string => String(r.report_date_as_yyyy_mm_dd ?? '')
const byDate = (a: Rec, b: Rec): number => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : 0)

/** Score one market's trader groups against their own lookback range (`score_market`). */
function scoreMarket(market: Market, rows: Rec[], lookbackWeeks: number): Rec | null {
  if (rows.length === 0) return null
  const ordered = [...rows].sort(byDate)
  const window = ordered.slice(-lookbackWeeks)
  const priorWindow = ordered.length > lookbackWeeks ? ordered.slice(-lookbackWeeks - 1, -1) : ordered.slice(0, -1)
  const latest = window[window.length - 1]!
  const openInterest = reportedNumber(latest.open_interest_all)
  const scored: Rec = { report_date: dateOf(latest).slice(0, 10), market: market.label, open_interest: openInterest !== null ? Math.trunc(openInterest) : null }
  for (const group of Object.keys(TRADER_GROUPS)) {
    const nets = netSeries(window, group)
    const score = exposureScore(positioningScore(nets), group)
    const prior = exposureScore(positioningScore(netSeries(priorWindow, group)), group)
    scored[group] = score
    scored[`${group}_change`] = score !== null && prior !== null ? pyRound(score - prior, 1) : null
    scored[`${group}_net_pct_oi`] = nets.length > 0 && openInterest ? pyRound((100.0 * nets[nets.length - 1]!) / openInterest, 2) : null
    scored[`${group}_zone`] = zoneFor(score, group)
  }
  return scored
}

/** The score rows of every curated market in the asset class (`CftcCotIndexFetcher.aextract_data`). */
async function scoreMarkets(params: NativeParams, ctx: NativeCtx): Promise<Rec[]> {
  const markets = marketsFor(str(params.asset_class) ?? 'all')
  const lookbackWeeks = params.lookback_weeks === undefined ? 52 : Number(params.lookback_weeks)
  const futuresOnly = flag(params.futures_only, true)
  const one = async (market: Market): Promise<Rec | null> => {
    try {
      const rows = await fetchCot(ctx, { code: market.code, reportType: 'legacy', futuresOnly }, { select: SCORED_COLUMNS, newest: lookbackWeeks + 1 })
      return scoreMarket(market, rows, lookbackWeeks)
    } catch {
      return null
    }
  }
  const scored: (Rec | null)[] = []
  for (let i = 0; i < markets.length; i += 6) scored.push(...(await Promise.all(markets.slice(i, i + 6).map(one))))
  const results = scored.filter((r): r is Rec => r !== null)
  if (results.length === 0) throw new Error('No curated COT market returned a scoreable report history.')
  return results
}

async function cotIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await scoreMarkets(params, ctx)
  const order = new Map(COT_MARKETS.map((x, i) => [x.label, i] as const))
  return data.sort((a, b) => (order.get(a.market as string) ?? 0) - (order.get(b.market as string) ?? 0))
}

/** What a week's score move did to a group's stance (`describe_move`). */
function describeMove(group: string, score: number, change: number): string {
  const hedging = group === 'commercials'
  if (score >= EXTREME_HIGH) return hedging ? 'Moved to max hedged' : change > 0 ? 'Pushed into one-year highs' : 'Held near one-year highs'
  if (score <= EXTREME_LOW) return hedging ? 'Moved to max exposed' : change < 0 ? 'Dropped to one-year lows' : 'Held near one-year lows'
  if (change > 0) return hedging ? 'Eased off max exposed' : 'Lifted off one-year lows'
  return hedging ? 'Eased off max hedged' : 'Pulled back from highs'
}

async function cotMovers(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows = await scoreMarkets(params, ctx)
  const limit = params.limit === undefined ? 8 : Number(params.limit)
  const movers: Rec[] = []
  for (const row of rows) {
    for (const group of Object.keys(TRADER_GROUPS)) {
      const score = row[group] as number | null
      const change = row[`${group}_change`] as number | null
      if (score === null || change === null) continue
      const hedging = group === 'commercials'
      movers.push({ market: row.market, trader_group: GROUP_LABELS[group], spec_score: hedging ? null : score, commercial_score: hedging ? score : null, change, signal: describeMove(group, score, change) })
    }
  }
  movers.sort((a, b) => Math.abs(b.change as number) - Math.abs(a.change as number) || ((a.market as string) < (b.market as string) ? -1 : (a.market as string) > (b.market as string) ? 1 : 0))
  const ranked: Rec[] = []
  const seen = new Set<string>()
  for (const mover of movers) {
    if (seen.has(mover.market as string)) continue
    seen.add(mover.market as string)
    ranked.push(mover)
  }
  return limit > 0 ? ranked.slice(0, limit) : ranked
}

/** Each week's net position scored against its own trailing window (`_rolling_scores`). */
function rollingScores(nets: (number | null)[], lookbackWeeks: number, group: string): (number | null)[] {
  return nets.map((_n, index) => {
    const window = nets.slice(Math.max(0, index - lookbackWeeks + 1), index + 1).filter((v): v is number => v !== null)
    return window.length > 0 ? exposureScore(positioningScore(window), group) : null
  })
}

async function cotPositioning(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const code = str(params.code) ?? 'CFTC_13874+'
  const lookbackWeeks = params.lookback_weeks === undefined ? 52 : Number(params.lookback_weeks)
  const market = COT_MARKETS.find((x) => x.code === code.trim()) ?? { code: code.trim(), label: code.trim(), asset_class: 'all', contract: code.trim() }
  const rows = await fetchCot(ctx, { code: market.code, reportType: 'legacy', futuresOnly: flag(params.futures_only, true) }, { select: SCORED_COLUMNS })

  const ordered = [...rows].sort(byDate)
  const dates = ordered.map((r) => dateOf(r).slice(0, 10))
  const interest = ordered.map((r) => reportedNumber(r.open_interest_all))
  const series: Record<string, (number | null)[]> = {}
  for (const [group, [longField, shortField]] of Object.entries(TRADER_GROUPS)) {
    const nets = ordered.map((row) => {
      const longs = reportedNumber(row[longField])
      const shorts = reportedNumber(row[shortField])
      return longs === null || shorts === null ? null : longs - shorts
    })
    series[group] = nets
    series[`${group}_score`] = rollingScores(nets, lookbackWeeks, group)
  }
  const built: Row[] = []
  dates.forEach((reportDate, index) => {
    if (!reportDate) return
    const openInterest = interest[index]!
    const row: Row = { report_date: reportDate, open_interest: openInterest ? Math.trunc(openInterest) : null }
    for (const group of Object.keys(TRADER_GROUPS)) {
      const net = series[group]![index]!
      row[`${group}_net`] = net !== null ? Math.trunc(net) : null
      row[`${group}_net_pct_oi`] = net !== null && openInterest ? pyRound((100.0 * net) / openInterest, 2) : null
      row[`${group}_score`] = series[`${group}_score`]![index]
    }
    built.push(row)
  })
  return built
}

export const cotRoutes: Record<string, NativeHandler> = {
  'cftc/cot': cot,
  'cftc/cot_search': cotSearch,
  'cftc/cot_index': cotIndex,
  'cftc/cot_movers': cotMovers,
  'cftc/cot_positioning': cotPositioning,
}
