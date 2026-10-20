// equity/fundamental/dividends, equity/fundamental/historical_eps, equity/shorts/short_interest,
// equity/ownership/insider_trading and equity/ownership/institutional, provider nasdaq. Ported from
// openbb_nasdaq/models/{historical_dividends,historical_eps,equity_short_interest,insider_trading,institutional_ownership}.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, getNasdaqData, listParam, mdyToIso, parseLooseDate, pyFloat, resolveAssetClass, rowsFromTable, toDate, toNumber, toPercent, type Dict } from './helpers.js'

const EPOCH = '1900-01-01'
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** A single-symbol route's `symbol`: the list a caller passed, joined back and upper-cased. */
const oneSymbol = (params: NativeParams): string => listParam(params, 'symbol').join(',').toUpperCase()

// --- equity/fundamental/dividends ------------------------------------------------------------------------------

const DIVIDEND_ALIASES: Record<string, string> = { exOrEffDate: 'ex_dividend_date', declarationDate: 'declaration_date', recordDate: 'record_date', paymentDate: 'payment_date', type: 'dividend_type' }

/** `datetime.strptime(v, "%m/%d/%Y")` after `v.replace("N/A", "")`; null when empty. */
function usDate(v: unknown): string | null {
  const s = String(v ?? '').replaceAll('N/A', '')
  if (!s) return null
  const d = mdyToIso(s)
  if (d === null) throw new Error(`time data '${s}' does not match format '%m/%d/%Y'`)
  return d
}

export async function historicalDividends(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = oneSymbol(params).split(',')
  const results: Dict[] = []
  const batches = await Promise.all(
    symbols.map(async (symbol) => {
      const assetClass = await resolveAssetClass(ctx, symbol)
      let payload: Dict | undefined
      try {
        payload = await getNasdaqData(ctx, `quote/${symbol}/dividends?assetclass=${assetClass}`)
      } catch {
        payload = undefined
      }
      const data: Dict[] = ((payload ?? {}).dividends ?? {}).rows ?? []
      if (!data.length) ctx.log(`No data found for ${symbol}`)
      if (data.length && symbols.length > 1) for (const d of data) d.symbol = symbol
      return data
    }),
  )
  for (const b of batches) results.push(...b)
  if (!results.length) return [] // EmptyDataError
  const start = params.start_date as string | undefined
  const end = params.end_date as string | undefined
  const out: Row[] = []
  for (const d of results) {
    const dt = parseLooseDate(String(d.exOrEffDate))
    if (dt === null) throw new Error(`Unknown string format: ${String(d.exOrEffDate)}`)
    if (start && start > dt) continue
    if (end && end < dt) continue
    const row: Dict = {}
    for (const [k, v] of Object.entries(d)) row[DIVIDEND_ALIASES[k] ?? k] = v
    for (const k of ['ex_dividend_date', 'declaration_date', 'record_date', 'payment_date']) if (k in row) row[k] = usDate(row[k])
    if ('amount' in row) {
      const v = String(row.amount).replaceAll('$', '').replaceAll('N/A', '')
      row.amount = v ? pyFloat(v) : null
    }
    out.push(compact(row))
  }
  return out
}

// --- equity/fundamental/historical_eps -------------------------------------------------------------------------

export async function historicalEps(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = oneSymbol(params)
  const data = await getNasdaqData(ctx, `company/${symbol}/earnings-surprise`)
  const rows = rowsFromTable((data ?? {}).earningsSurpriseTable)
  if (!rows.length) return [] // EmptyDataError: no earnings history
  const results = rows
    .filter((row) => toDate(row.dateReported) !== null)
    .map((row) =>
      compact({
        symbol,
        date: toDate(row.dateReported),
        eps_actual: toNumber(row.eps),
        eps_estimated: toNumber(row.consensusForecast),
        surprise_percent: toPercent(row.percentageSurprise),
        fiscal_period_ending: row.fiscalQtrEnd,
      }),
    )
  return results.sort((a, b) => cmp(b.date as string, a.date as string))
}

// --- equity/shorts/short_interest ------------------------------------------------------------------------------

export async function shortInterest(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = oneSymbol(params)
  const data = await getNasdaqData(ctx, `quote/${symbol}/short-interest?assetClass=stocks`)
  const rows = rowsFromTable((data ?? {}).shortInterestTable)
  if (!rows.length) return [] // EmptyDataError
  const results: Row[] = []
  let previous: number | null = null
  for (const row of [...rows].sort((a, b) => cmp(toDate(a.settlementDate) ?? EPOCH, toDate(b.settlementDate) ?? EPOCH))) {
    const current = toNumber(row.interest)
    const change: number | null = current !== null && previous !== null ? current - previous : null
    results.push(
      compact({
        symbol,
        settlement_date: toDate(row.settlementDate),
        current_short_position: current,
        previous_short_position: previous,
        avg_daily_volume: toNumber(row.avgDailyShareVolume),
        days_to_cover: toNumber(row.daysToCover),
        change,
        change_pct: change !== null && previous ? change / previous : null,
      }),
    )
    previous = current
  }
  return results.reverse()
}

// --- equity/ownership/insider_trading --------------------------------------------------------------------------

export async function insiderTrading(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = oneSymbol(params)
  const limit = typeof params.limit === 'number' ? params.limit : 100
  const data = await getNasdaqData(ctx, `company/${symbol}/insider-trades?limit=${limit}&type=ALL&sortColumn=lastDate&sortOrder=DESC`)
  const rows = rowsFromTable((data ?? {}).transactionTable)
  if (!rows.length) return [] // EmptyDataError
  return rows.slice(0, limit).map((row) => {
    const url = row.url
    return compact({
      symbol,
      owner_name: row.insider,
      owner_title: row.relation,
      transaction_date: toDate(row.lastDate),
      transaction_type: row.transactionType,
      ownership_type: row.ownType,
      securities_transacted: toNumber(row.sharesTraded),
      transaction_price: toNumber(row.lastPrice),
      shares_held: toNumber(row.sharesHeld),
      url: url ? `https://www.nasdaq.com${url}` : null,
    })
  })
}

// --- equity/ownership/institutional ----------------------------------------------------------------------------

const HOLDER_TYPE_KEYS: Record<string, string> = { all: 'TOTAL', increased: 'INCREASED', decreased: 'DECREASED', new: 'NEW', sold_out: 'SOLDOUT' }
const HOLDER_SORT_KEYS: Record<string, string> = { owner_name: 'ownerName', date: 'date', shares_held: 'sharesHeld', shares_change: 'sharesChange', shares_change_percent: 'sharesChangePCT', market_value: 'marketValue' }

export async function institutionalOwnership(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = oneSymbol(params)
  const limit = typeof params.limit === 'number' ? params.limit : 50
  const holderType = String(params.holder_type ?? 'all')
  const sortBy = String(params.sort_by ?? 'market_value')
  const data = await getNasdaqData(ctx, `company/${symbol}/institutional-holdings?limit=${limit}&type=${HOLDER_TYPE_KEYS[holderType]}&sortColumn=${HOLDER_SORT_KEYS[sortBy]}&sortOrder=DESC`)
  const rows = rowsFromTable((data ?? {}).holdingsTransactions)
  if (!rows.length) return [] // EmptyDataError
  return rows.slice(0, limit).map((row) => {
    const url = row.url
    return compact({
      symbol,
      date: toDate(row.date),
      owner_name: row.ownerName,
      shares_held: toNumber(row.sharesHeld),
      shares_change: toNumber(row.sharesChange),
      shares_change_percent: toPercent(row.sharesChangePCT),
      market_value: toNumber(row.marketValue),
      url: url ? `https://www.nasdaq.com${url}` : null,
    })
  })
}
