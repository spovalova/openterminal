// derivatives/options/chains, provider nasdaq. Ported from openbb_nasdaq/models/options_chains.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: one row per contract instead of a columnar model, request fan-out bounded to 16 at a time.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { addDays, compact, getContractDetail, getNasdaqData, listParam, mapLimit, resolveAssetClass, today, toDate, toNumber, type Dict } from './helpers.js'

const MAX_CONCURRENCY = 16
const MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 500

const EXCHANGE_MAP: Record<string, string> = {
  composite: 'oprac',
  cbo: 'cbo',
  aoe: 'aoe',
  nyo: 'nyo',
  pho: 'pho',
  moe: 'moe',
  box: 'box',
  ise: 'ise',
  bto: 'bto',
  nso: 'nso',
  c2o: 'c2o',
  bxo: 'bxo',
  mio: 'mio',
  mpe: 'mpe',
  edo: 'edo',
  gem: 'gem',
  mcry: 'mcry',
  mxop: 'mxop',
}

/** The keys a contract row carries, in the model's order. */
const COLUMNS = ['underlying_symbol', 'underlying_price', 'contract_symbol', 'expiration', 'strike', 'option_type', 'last_trade_price', 'change', 'bid', 'ask', 'bid_size', 'ask_size', 'volume', 'open_interest', 'open', 'high', 'low', 'prev_close', 'contract_high', 'contract_low', 'tick', 'exchange', 'implied_volatility', 'delta', 'gamma', 'theta', 'vega', 'rho']


/** The underlying price out of the chain's lastTrade banner, "AAPL $333.02 +11.36 …". */
function underlyingPrice(lastTrade: string): number | null {
  const m = /\$([\d,]+\.?\d*)/.exec(lastTrade || '')
  return m ? Number(m[1]!.replaceAll(',', '')) : null
}

/** The OCC contract symbol from a drill-down URL ('…/aapl--260727c00205000'), for one side. */
function contractSymbol(url: unknown, side: 'call' | 'put'): string | null {
  if (typeof url !== 'string' || !url.includes('--')) return null
  const tail = url.slice(url.lastIndexOf('--') + 2)
  const last = url.slice(url.lastIndexOf('/') + 1)
  const root = last.split('--')[0]!
  if (tail.length < 15) return null
  return `${root}${tail.slice(0, 6)}${side === 'call' ? 'C' : 'P'}${tail.slice(7)}`.toUpperCase()
}

/** The expiration date of an OCC contract symbol (`datetime.strptime(digits[:6], "%y%m%d")`). */
function expirationOf(contract: string | null): string | null {
  if (!contract || contract.length < 15) return null
  const digits = [...contract].filter((c) => c >= '0' && c <= '9').join('')
  if (digits.length < 6) return null
  const yy = +digits.slice(0, 2)
  const year = yy >= 69 ? 1900 + yy : 2000 + yy
  const month = +digits.slice(2, 4)
  const day = +digits.slice(4, 6)
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const chainRows = (chain: Dict): Dict[] => (chain.table ?? {}).rows ?? []

/** The nearest expiration present in a chain payload. */
function frontExpiration(chain: Dict): string | null {
  const parsed = chainRows(chain)
    .map((row) => expirationOf(contractSymbol(row.drillDownURL, 'call')))
    .filter((e): e is string => e !== null)
    .sort()
  return parsed[0] ?? null
}

/** The greeks table indexed by expiration, strike and side. */
function greeksByContract(greeks: Dict): Map<string, Dict> {
  const indexed = new Map<string, Dict>()
  for (const row of (greeks.table ?? {}).rows ?? []) {
    const strike = toNumber(row.strike || row.Strike)
    if (strike === null) continue
    for (const [side, prefix] of [['call', 'c'], ['put', 'p']] as const) {
      const expiration = expirationOf(contractSymbol(row.url, side))
      if (expiration === null) continue
      indexed.set(`${expiration}|${strike}|${side}`, {
        delta: toNumber(row[`${prefix}Delta`]),
        gamma: toNumber(row[`${prefix}Gamma`]),
        theta: toNumber(row[`${prefix}Theta`]),
        vega: toNumber(row[`${prefix}Vega`]),
        rho: toNumber(row[`${prefix}Rho`]),
        implied_volatility: toNumber(row[`${prefix}IV`]),
      })
    }
  }
  return indexed
}

/** The (expiration, strike) pairs present in a chain, for the given expirations. */
function strikesFor(chain: Dict, expirations: Set<string>): [string, number][] {
  const pairs = new Map<string, [string, number]>()
  for (const row of chainRows(chain)) {
    const strike = toNumber(row.strike)
    if (strike === null) continue
    const expiration = expirationOf(contractSymbol(row.drillDownURL, 'call'))
    if (expiration !== null && (!expirations.size || expirations.has(expiration))) pairs.set(`${expiration}|${strike}`, [expiration, strike])
  }
  return [...pairs.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
}

export async function optionsChains(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = listParam(params, 'symbol').join(',').toUpperCase()
  const assetClass = await resolveAssetClass(ctx, symbol)
  const exchange = String(params.exchange ?? 'composite')
  const excode = EXCHANGE_MAP[exchange]
  if (excode === undefined) throw new Error(`unknown options exchange ${exchange}`)
  const now = today(ctx)
  const requested = new Set<string>()
  for (const part of listParam(params, 'expiration').join(',').split(',')) {
    if (!part) continue
    const d = toDate(part)
    if (d !== null) requested.add(d)
  }
  const sortedRequested = [...requested].sort()
  const chainPath =
    `quote/${symbol}/option-chain?assetclass=${assetClass}` +
    `&fromdate=${sortedRequested.length ? sortedRequested[0] : now}` +
    `&todate=${sortedRequested.length ? sortedRequested[sortedRequested.length - 1] : addDays(now, 1095)}` +
    `&limit=20000&excode=${excode}&callput=callput&money=all&type=all`
  const chain: Dict | null = await getNasdaqData(ctx, chainPath)
  if (!chain || !Object.keys(chain).length) return [] // EmptyDataError

  const front = frontExpiration(chain)
  const fanout = requested.size ? requested : front !== null ? new Set([front]) : new Set<string>()
  const detail = new Map<string, Dict>()

  const getOne = async ([expiration, strike]: [string, number]): Promise<void> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let sides
      try {
        sides = await getContractDetail(ctx, symbol, expiration, strike, assetClass)
      } catch {
        await ctx.sleep(RETRY_BACKOFF_MS * (attempt + 1))
        continue
      }
      for (const [side, fields] of Object.entries(sides)) if (fields) detail.set(`${expiration}|${strike}|${side}`, fields)
      return
    }
  }
  const getGreeks = async (expiration: string): Promise<Dict> => {
    try {
      return (await getNasdaqData(ctx, `quote/${symbol}/option-chain/greeks?assetclass=${assetClass}&date=${expiration}`)) ?? {}
    } catch {
      return {}
    }
  }
  const pairs = fanout.size ? strikesFor(chain, fanout) : []
  const [, greeksPayloads] = await Promise.all([mapLimit(pairs, MAX_CONCURRENCY, getOne), Promise.all([...fanout].sort().map(getGreeks))])
  const greeks = new Map<string, Dict>()
  for (const payload of greeksPayloads) for (const [k, v] of greeksByContract(payload)) greeks.set(k, v)

  const underlying = underlyingPrice(chain.lastTrade || '')
  const contracts: Dict[] = []
  for (const row of chainRows(chain)) {
    const strike = toNumber(row.strike)
    if (strike === null) continue
    for (const [side, prefix] of [['call', 'c_'], ['put', 'p_']] as const) {
      const contract = contractSymbol(row.drillDownURL, side)
      const expiration = expirationOf(contract)
      if (expiration === null || (requested.size && !requested.has(expiration))) continue
      const key = `${expiration}|${strike}|${side}`
      contracts.push({
        underlying_symbol: symbol,
        underlying_price: underlying,
        contract_symbol: contract,
        expiration,
        strike,
        option_type: side,
        last_trade_price: toNumber(row[`${prefix}Last`]),
        change: toNumber(row[`${prefix}Change`]),
        bid: toNumber(row[`${prefix}Bid`]),
        ask: toNumber(row[`${prefix}Ask`]),
        volume: toNumber(row[`${prefix}Volume`]),
        open_interest: toNumber(row[`${prefix}Openinterest`]),
        ...(greeks.get(key) ?? {}),
        ...(detail.get(key) ?? {}),
      })
    }
  }
  if (!contracts.length) return [] // EmptyDataError
  contracts.sort((a, b) => (a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : a.strike !== b.strike ? a.strike - b.strike : a.option_type < b.option_type ? -1 : a.option_type > b.option_type ? 1 : 0))
  return contracts.map((c) => compact(Object.fromEntries(COLUMNS.map((k) => [k, c[k]]))))
}
