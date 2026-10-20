// etf/nport_disclosure and sec/nport_fund_metrics, provider sec. Ported from openbb_sec/models/nport_disclosure.py,
// nport_fund_metrics.py, openbb_sec/utils/nmfp.py and `get_nport_candidates`, `get_series_id` in
// openbb_sec/utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and
// pydantic models (`validateHolding` applies the data model's aliases, validators and types), xmltodict is
// fast-xml-parser, and holdings of equal weight keep their filing order (OpenBB's sort is numpy's unstable quicksort).
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { HEADERS, cachedRequest, containsIgnoreCase, getMfAndEtfMap, symbolMap } from '../helpers.js'
import { xmlToDict } from './xmltodict.js'

type Any = any
type Dict = Record<string, Any>

const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v)
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isDict(v) ? Object.keys(v).length > 0 : Boolean(v))
/** `float(value)`: a number or numeric text, else the TypeError or ValueError Python raises. */
function pyFloat(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v)
  if (typeof v === 'string' && /^\s*[+-]?(inf|infinity|nan)\s*$/i.test(v)) return Number(v.replace(/inf(inity)?/i, 'Infinity').replace(/nan/i, 'NaN'))
  throw new TypeError(`float() argument must be a string or a real number: ${JSON.stringify(v)}`)
}
/** `_to_float` of nmfp.py: null when it does not parse. */
const toFloatOrNull = (v: unknown): number | null => {
  try {
    return pyFloat(v)
  } catch {
    return null
  }
}
/** `dict.get(key)` on a value Python would fail on when it is not a dict. */
function get(v: Any, key: string): Any {
  if (!isDict(v)) throw new TypeError(`'${v === null ? 'NoneType' : typeof v}' object has no attribute 'get'`)
  return v[key]
}
function sub(v: Any, key: string): Any {
  if (!isDict(v) || !(key in v)) throw new Error(`KeyError: '${key}'`)
  return v[key]
}

// ---------------------------------------------------------------------------------------------------------------
// The data model: aliases, validators and field types of SecNportDisclosureData
// ---------------------------------------------------------------------------------------------------------------

/** `__alias_dict__` as `_use_alias` applies it: source key → field name. */
const ALIASES: Record<string, string> = {
  pctVal: 'weight',
  valUSD: 'value',
  derivative_payoff: 'payoff_profile',
  curCd: 'currency',
  assetCat: 'asset_category',
  issuerCat: 'issuer_category',
  invCountry: 'country',
  isRestrictedSec: 'is_restricted',
  fairValLevel: 'fair_value_level',
  loanVal: 'loan_value',
}

type Kind = 'str' | 'coerceStr' | 'float' | 'percent' | 'int' | 'intOrFloat' | 'strOrNumber' | 'date'
const STR_FIELDS = [
  'symbol', 'name', 'title', 'other_id', 'is_restricted', 'is_cash_collateral', 'is_non_cash_collateral', 'is_loan_by_fund', 'issuer_conditional', 'asset_conditional', 'payoff_profile', 'asset_category', 'issuer_category', 'country', 'currency', 'coupon_kind', 'rate_type', 'is_default', 'in_arrears', 'is_paid_kind', 'derivative_category', 'counterparty', 'underlying_name', 'option_type', 'derivative_payoff', 'exercise_currency', 'rate_type_rec', 'receive_currency', 'floating_rate_index_rec', 'rate_tenor_rec', 'reset_date_rec', 'rate_type_pmnt', 'payment_currency', 'floating_rate_index_pmnt', 'rate_tenor_pmnt', 'reset_date_pmnt', 'repo_type', 'is_cleared', 'is_tri_party', 'principal_currency', 'collateral_type', 'collateral_currency', 'exchange_currency', 'currency_sold', 'currency_bought', 'notional_currency',
]
const FLOAT_FIELDS = ['loan_value', 'exercise_price', 'shares_per_contract', 'upfront_receive', 'floating_rate_spread_rec', 'upfront_payment', 'floating_rate_spread_pmnt', 'principal_amount', 'collateral_amount', 'exchange_rate', 'currency_amount_sold', 'currency_amount_bought', 'notional_amount', 'unrealized_gain']
const KINDS: Record<string, Kind> = {
  ...Object.fromEntries(STR_FIELDS.map((f) => [f, 'str' as Kind])),
  ...Object.fromEntries(FLOAT_FIELDS.map((f) => [f, 'float' as Kind])),
  cusip: 'coerceStr',
  lei: 'coerceStr',
  isin: 'coerceStr',
  fair_value_level: 'int',
  balance: 'intOrFloat',
  value: 'intOrFloat',
  units: 'strOrNumber',
  delta: 'strOrNumber',
  rate_tenor_unit_rec: 'strOrNumber',
  reset_date_unit_rec: 'strOrNumber',
  rate_tenor_unit_pmnt: 'strOrNumber',
  reset_date_unit_pmnt: 'strOrNumber',
  weight: 'percent',
  annualized_return: 'percent',
  maturity_date: 'date',
  expiry_date: 'date',
}

/** pydantic's `to_camel` of a field name (`is_cash_collateral` → `isCashCollateral`). */
const toCamel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const CAMEL_TO_FIELD = new Map(Object.keys(KINDS).map((f) => [toCamel(f), f]))

function numeric(v: Any, field: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v)
  if (typeof v === 'string' && /^\s*[+-]?(inf|nan)\s*$/i.test(v)) return Number(v.replace(/inf/i, 'Infinity').replace(/nan/i, 'NaN'))
  throw new Error(`Input should be a valid number for ${field}: ${JSON.stringify(v)}`)
}

function validateValue(field: string, kind: Kind, v: Any): unknown {
  switch (kind) {
    case 'str':
      if (typeof v === 'string') return v
      throw new Error(`Input should be a valid string for ${field}: ${JSON.stringify(v)}`)
    case 'coerceStr':
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      throw new Error(`Input should be a valid string for ${field}: ${JSON.stringify(v)}`)
    case 'float':
      return numeric(v, field)
    case 'percent':
      // `normalize_percent`: float(v) / 100 if v else None (a numeric zero never gets here: replace_zero made it None).
      return truthy(v) ? pyFloat(v) / 100 : null
    case 'int': {
      const n = numeric(v, field)
      if (!Number.isInteger(n)) throw new Error(`Input should be a valid integer for ${field}: ${JSON.stringify(v)}`)
      return n
    }
    case 'intOrFloat':
      return numeric(v, field)
    case 'strOrNumber':
      return typeof v === 'string' ? v : numeric(v, field)
    case 'date': {
      const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:[T ]00:00:00)?$/.exec(v.trim()) : null
      if (!m) throw new Error(`Input should be a valid date for ${field}: ${JSON.stringify(v)}`)
      return m[1]
    }
  }
}

/** `SecNportDisclosureData.model_validate(raw)`. */
function validateHolding(raw: Dict): Row {
  // replace_zero: a numeric zero becomes None.
  const values: Dict = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === 0 ? null : v]))
  const row: Row = {}
  // A field is filled from its own name (after the alias dict) or from its camelCase alias; the name wins, even when
  // it is None: the `derivative_payoff` column of a fund with any derivative hides `payoffProfile` on every holding.
  const named = new Map<string, Any>()
  const camel = new Map<string, Any>()
  for (const [key, v] of Object.entries(values)) {
    const renamed = ALIASES[key] ?? key
    if (renamed in KINDS) named.set(renamed, v)
    else if (CAMEL_TO_FIELD.has(renamed)) camel.set(CAMEL_TO_FIELD.get(renamed)!, v)
    else if (v !== null && v !== undefined) row[renamed] = v
  }
  for (const field of new Set([...named.keys(), ...camel.keys()])) {
    const v = named.has(field) ? named.get(field) : camel.get(field)
    // normalize_percent runs on a missing value too, and gives None.
    if (v === null || v === undefined) continue
    const out = validateValue(field, KINDS[field]!, v)
    if (out !== null) row[field] = out
  }
  return row
}

// ---------------------------------------------------------------------------------------------------------------
// N-MFP (nmfp.py)
// ---------------------------------------------------------------------------------------------------------------

function parseNmfp(response: Dict): { holdings: Dict[]; metadata: Dict } {
  const form: Dict = response.edgarSubmission?.formData || {}
  const general: Dict = form.generalInfo || {}
  const series: Dict = form.seriesLevelInfo || {}
  const schedule = form.scheduleOfPortfolioSecuritiesInfo
  const items: Any[] = Array.isArray(schedule) ? schedule : schedule ? [schedule] : []
  const holdings: Dict[] = []
  for (const item of items) {
    if (!isDict(item)) continue
    const weight = toFloatOrNull(item.percentageOfMoneyMarketFundNetAssets)
    const securityYield = toFloatOrNull(item.yieldOfTheSecurityAsOfReportingDate)
    holdings.push({
      name: item.nameOfIssuer,
      title: item.titleOfIssuer,
      cusip: item.CUSIPMember,
      isin: item.ISINId,
      lei: item.LEIID,
      asset_category: item.investmentCategory,
      maturity_date: item.finalLegalInvestmentMaturityDate,
      value: toFloatOrNull(item.includingValueOfAnySponsorSupport),
      weight: weight !== null ? weight * 100 : null,
      annualized_return: securityYield !== null ? securityYield * 100 : null,
      currency: 'USD',
    })
  }
  // `sort(key=(weight is not None, weight or 0), reverse=True)`: stable, so equal keys keep their order.
  const sorted = holdings.map((h, i) => ({ h, i })).sort((a, b) => {
    const [aHas, bHas] = [a.h.weight !== null, b.h.weight !== null]
    return Number(bHas) - Number(aHas) || (b.h.weight || 0) - (a.h.weight || 0) || a.i - b.i
  })
  let yields = series.sevenDayGrossYield || []
  if (isDict(yields) || typeof yields === 'string') yields = [yields]
  const latest = yields.length ? yields[yields.length - 1] : null
  const sevenDay = toFloatOrNull(isDict(latest) ? latest.sevenDayGrossYieldValue : latest)
  const metadata: Dict = {
    fund_name: general.nameOfSeries,
    series_id: general.seriesId,
    period_ending: general.reportDate,
    net_assets: toFloatOrNull(series.netAssetOfSeries),
    total_assets: toFloatOrNull(series.totalValuePortfolioSecurities),
    cash_and_equivalents: toFloatOrNull(series.cash),
    seven_day_gross_yield: sevenDay,
    weighted_average_maturity: toFloatOrNull(series.averagePortfolioMaturity),
    weighted_average_life: toFloatOrNull(series.averageLifeMaturity),
  }
  return { holdings: sorted.map(({ h }) => h), metadata }
}

// ---------------------------------------------------------------------------------------------------------------
// get_series_id, get_nport_candidates (helpers.py)
// ---------------------------------------------------------------------------------------------------------------

type Candidate = { name: string; cik: string; file_date: string; period_ending: string; form_type: string; primary_doc: string }

async function getSeriesId(ctx: NativeCtx, symbol: string, useCache: boolean): Promise<string | null> {
  const funds = await getMfAndEtfMap(ctx, useCache)
  const matches = containsIgnoreCase(symbol)
  const results = funds.filter((f) => matches(f.cik) || matches(f.seriesId) || matches(f.classId) || matches(f.symbol))
  if (!results.length) return null
  return results.find((f) => f.symbol === symbol)?.seriesId ?? null
}

async function getNportCandidates(ctx: NativeCtx, symbol: string, useCache: boolean): Promise<Candidate[]> {
  const seriesId = (await getSeriesId(ctx, symbol, useCache)) ?? (await symbolMap(ctx, symbol, useCache))
  if (!seriesId) throw new Error(`Fund not found for, the symbol: ${symbol}`)
  const forms = 'NPORT-P,N-MFP,N-MFP1,N-MFP2,N-MFP3'
  const base = `https://efts.sec.gov/LATEST/search-index?q=${seriesId}&dateRange=all&forms=${forms}`
  const results: Candidate[] = []
  let offset = 0
  while (offset < 10000) {
    const response = (await cachedRequest(ctx, `${base}&from=${offset}`, { kind: 'sec', headers: HEADERS, useCache })) as Dict
    const hits: Dict[] = isDict(response) ? (response.hits?.hits ?? []) : []
    if (!hits.length) break
    for (const d of hits) {
      const source = d._source
      results.push({
        name: source.display_names[0],
        cik: source.ciks[0],
        file_date: source.file_date,
        period_ending: source.period_ending || source.file_date,
        form_type: source.form,
        primary_doc: `https://www.sec.gov/Archives/edgar/data/${parseInt(source.ciks[0], 10)}/${String(d._id).replaceAll('-', '').replaceAll(':', '/')}`,
      })
    }
    offset += hits.length
    if (offset >= response.hits.total.value) break
  }
  // `sorted(reverse=True)` keeps equal dates in their original order.
  return results.map((r, i) => ({ r, i })).sort((a, b) => (a.r.file_date < b.r.file_date ? 1 : a.r.file_date > b.r.file_date ? -1 : a.i - b.i)).map(({ r }) => r)
}

// ---------------------------------------------------------------------------------------------------------------
// The fetcher (nport_disclosure.py)
// ---------------------------------------------------------------------------------------------------------------

const quarterEnd = (year: number, quarter: number): string => {
  const month = quarter * 3
  return `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`
}

async function extractData(ctx: NativeCtx, params: NativeParams): Promise<Dict> {
  const symbol = String(params.symbol ?? '').toUpperCase()
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)
  const year = params.year === undefined || params.year === null ? undefined : Number(params.year)
  let quarter = params.quarter === undefined || params.quarter === null ? undefined : Number(params.quarter)
  const date = typeof params.date === 'string' && params.date ? params.date : undefined

  // A retry mechanism in case of RemoteDisconnected Error.
  const retries = 3
  let filings: Candidate[] = []
  for (let i = 0; i < retries; i++) {
    filings = []
    try {
      filings = await getNportCandidates(ctx, symbol, useCache)
      if (filings.length) break
    } catch (err) {
      if (i < retries - 1) {
        ctx.log(`Error: ${err instanceof Error ? err.message : String(err)}. Retrying...`)
        continue
      }
      throw err
    }
  }
  if (!filings.length) throw new Error(`No N-Port records found for ${symbol}.`)

  let filingUrl: string
  if (date !== undefined) {
    const matched = filings.filter((f) => f.period_ending.slice(0, 10) === date.slice(0, 10))
    filingUrl = matched.length ? matched[0]!.primary_doc : filings[0]!.primary_doc
  } else if (year !== undefined) {
    const dates = filings.map((f) => f.period_ending)
    if (quarter === undefined) quarter = year < Math.max(...dates.map((d) => Number(d.slice(0, 4)))) ? 4 : 1
    const target = Date.parse(`${quarterEnd(year, quarter)}T00:00:00Z`)
    let best = 0
    let bestDiff = Infinity
    dates.forEach((d, i) => {
      const diff = Math.abs(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) - target)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    })
    const newDate = dates[best]!.slice(0, 10)
    filingUrl = filings.find((f) => f.period_ending === newDate)?.primary_doc ?? (() => { throw new Error('index 0 is out of bounds for axis 0 with size 0') })()
  } else filingUrl = filings[0]!.primary_doc

  const bytes = (await cachedRequest(ctx, filingUrl, { kind: 'bytes', headers: HEADERS, useCache })) as Uint8Array
  return xmlToDict(new TextDecoder('utf-8').decode(bytes))
}

/** `transform_data`: the holdings of the filing and the fund-level facts around them. */
function transformData(ctx: NativeCtx, query: { symbol: string }, data: Dict): { results: Row[]; metadata: Dict } {
  if (!truthy(data)) throw new Error(`No data was returned for the symbol, ${query.symbol}`)
  const response = data
  const submissionType: string = response.edgarSubmission?.headerData?.submissionType ?? ''
  if (submissionType.startsWith('N-MFP')) {
    const { holdings, metadata } = parseNmfp(response)
    if (!holdings.length) throw new Error(`No holdings were found for the symbol, ${query.symbol}`)
    return { results: holdings.map(validateHolding), metadata }
  }

  let results: Dict[] = []
  const sub0 = response.edgarSubmission
  if (isDict(sub0) && 'formData' in sub0 && sub0.headerData.submissionType === 'NPORT-P' && isDict(sub0.formData) && 'invstOrSecs' in sub0.formData && isDict(sub0.formData.invstOrSecs) && 'invstOrSec' in sub0.formData.invstOrSecs) {
    let invst: Any = sub0.formData.invstOrSecs.invstOrSec
    if (isDict(invst)) invst = [invst]
    for (const rec of invst as Dict[]) {
      const identifiers = rec.identifiers
      if (!isDict(identifiers)) throw new TypeError('argument of type NoneType is not iterable')
      if ('isin' in identifiers) rec.isin = get(identifiers.isin, '@value')
      if ('other' in identifiers && isDict(identifiers.other) && '@value' in identifiers.other) rec.other_id = get(identifiers.other, '@value')

      if ('securityLending' in rec) {
        const securityLending = rec.securityLending
        if (isDict(securityLending)) {
          if ('loanByFundCondition' in securityLending) {
            const loanByFundCondition = securityLending.loanByFundCondition
            rec.isLoanByFund = get(loanByFundCondition, '@isLoanByFund')
            rec.loanVal = get(loanByFundCondition, '@loanVal')
          }
          if ('isCashCollateral' in securityLending) rec.isCashCollateral = securityLending.isCashCollateral
          if ('isNonCashCollateral' in securityLending) rec.isNonCashCollateral = securityLending.isNonCashCollateral
        }
      }

      if ('debtSec' in rec && isDict(rec.debtSec)) {
        const debtSec = rec.debtSec
        rec.maturity_date = debtSec.maturityDt
        rec.coupon_kind = debtSec.couponKind
        rec.annualized_return = debtSec.annualizedRt
        rec.is_default = debtSec.isDefault
        rec.in_arrears = debtSec.areIntrstPmntsInArrs
        rec.is_paid_kind = debtSec.isPaidKind
      }
      if ('issuerConditional' in rec && isDict(rec.issuerConditional)) rec.issuer_conditional = rec.issuerConditional['@desc']
      if ('assetConditional' in rec && isDict(rec.assetConditional)) rec.asset_conditional = rec.assetConditional['@desc']

      if ('derivativeInfo' in rec && isDict(rec.derivativeInfo)) {
        const derivativeInfo = rec.derivativeInfo
        if ('optionSwaptionWarrantDeriv' in derivativeInfo) {
          const o = derivativeInfo.optionSwaptionWarrantDeriv
          rec.derivative_category = o['@derivCat']
          rec.counterparty = sub(o, 'counterparties').counterpartyName
          rec.lei = o.counterparties.counterpartyLei
          const ref = sub(o, 'descRefInstrmnt')
          rec.underlying_name = (ref.otherRefInst ?? {}).issueTitle
          rec.underlying_name = (((ref.nestedDerivInfo ?? {}).fwdDeriv ?? {}).derivAddlInfo ?? {}).title || (ref.otherRefInst ?? {}).issueTitle
          rec.option_type = o.putOrCall
          rec.derivative_payoff = o.writtenOrPur
          rec.expiry_date = o.expDt
          rec.exercise_price = o.exercisePrice
          rec.exercise_currency = o.exercisePriceCurCd
          rec.shares_per_contract = o.shareNo
          if (o.delta !== 'XXXX') rec.delta = o.delta
          rec.unrealized_gain = pyFloat(o.unrealizedAppr)
        }
        if ('futrDeriv' in derivativeInfo) {
          const f = derivativeInfo.futrDeriv
          rec.derivative_category = f['@derivCat']
          if (isDict(f.counterparties)) {
            rec.counterparty = f.counterparties.counterpartyName
            rec.lei = f.counterparties.counterpartyLei
          }
          const basket = (sub(f, 'descRefInstrmnt').indexBasketInfo ?? {}) as Dict
          rec.underlying_name = basket.indexName
          rec.other_id = basket.indexIdentifier
          rec.derivative_payoff = f.payOffProf
          rec.expiry_date = f.expDt || f.expDate
          rec.notional_amount = pyFloat(f.notionalAmt)
          rec.notional_currency = f.curCd
          rec.unrealized_gain = pyFloat(f.unrealizedAppr)
        }
        if ('fwdDeriv' in derivativeInfo) {
          const f = derivativeInfo.fwdDeriv
          rec.derivative_category = f['@derivCat']
          rec.counterparty = sub(f, 'counterparties').counterpartyName
          rec.currency_sold = f.curSold
          rec.currency_amount_sold = pyFloat(f.amtCurSold)
          rec.currency_bought = f.curPur
          rec.currency_amount_bought = pyFloat(f.amtCurPur)
          rec.expiry_date = f.settlementDt
          rec.unrealized_gain = pyFloat(f.unrealizedAppr)
        }
        if ('swapDeriv' in derivativeInfo) {
          const s = derivativeInfo.swapDeriv
          rec.derivative_category = s['@derivCat']
          rec.counterparty = sub(s, 'counterparties').counterpartyName
          rec.lei = s.counterparties.counterpartyLei
          const ref = sub(s, 'descRefInstrmnt')
          if ('otherRefInst' in ref) rec.underlying_name = ref.otherRefInst.issueTitle
          if ('indexBasketInfo' in ref) {
            rec.underlying_name = ref.indexBasketInfo.indexName
            rec.other_id = ref.indexBasketInfo.indexIdentifier
          }
          rec.swap_description = 'otherRecDesc' in ref ? sub(s, 'otherRecDesc')['#text'] : null
          const leg = (desc: Dict, suffix: 'rec' | 'pmnt', unitSuffix: 'rec' | 'pmnt') => {
            const tenor = sub(sub(desc, 'rtResetTenors'), 'rtResetTenor')
            rec[`rate_type_${suffix}`] = desc['@fixedOrFloating']
            rec[`floating_rate_index_${suffix}`] = desc['@floatingRtIndex']
            rec[`floating_rate_spread_${suffix}`] = pyFloat(desc['@floatingRtSpread'])
            rec[`payment_amount_${suffix}`] = pyFloat(desc['@pmntAmt'])
            rec[`rate_tenor_${suffix}`] = tenor['@rateTenor']
            rec[`rate_tenor_unit_${suffix}`] = tenor['@rateTenorUnit']
            rec[`reset_date_${suffix}`] = tenor['@resetDt']
            // OpenBB writes the payment leg's reset unit into the receivable column (a typo that is part of its output).
            rec[`reset_date_unit_${unitSuffix}`] = tenor['@resetDtUnit']
          }
          if ('floatingRecDesc' in s) leg(s.floatingRecDesc, 'rec', 'rec')
          if ('floatingPmntDesc' in s) leg(s.floatingPmntDesc, 'pmnt', 'rec')
          rec.expiry_date = s.terminationDt
          rec.upfront_payment = pyFloat(s.upfrontPmnt)
          rec.payment_currency = s.pmntCurCd
          rec.upfront_receive = pyFloat(s.upfrontRcpt)
          rec.receive_currency = s.rcptCurCd
          rec.notional_amount = pyFloat(s.notionalAmt)
          rec.notional_currency = s.curCd
          rec.unrealized_gain = pyFloat(s.unrealizedAppr)
        }
      }

      if ('repurchaseAgrmt' in rec && isDict(rec.repurchaseAgrmt)) {
        const r = rec.repurchaseAgrmt
        rec.repo_type = r.transCat
        if ('clearedCentCparty' in r && isDict(r.clearedCentCparty)) {
          rec.is_cleared = r.clearedCentCparty['@isCleared']
          rec.counterparty = r.clearedCentCparty['@centralCounterparty']
        }
        rec.is_tri_party = r.isTriParty
        rec.annualized_return = r.repurchaseRt
        rec.maturity_date = r.maturityDt
        if ('repurchaseCollaterals' in r && isDict(r.repurchaseCollaterals) && 'repurchaseCollateral' in r.repurchaseCollaterals) {
          const c = r.repurchaseCollaterals.repurchaseCollateral
          rec.principal_amount = pyFloat(c.principalAmt)
          rec.principal_currency = c['@principalCd']
          rec.collateral_amount = pyFloat(c.collateralVal)
          rec.collateral_currency = c['@collateralCd']
          rec.collateral_type = c['@invstCat']
        }
      }
      if ('currencyConditional' in rec && isDict(rec.currencyConditional)) {
        rec.exchange_currency = rec.currencyConditional['@curCd']
        rec.exchange_rate = rec.currencyConditional['@exchangeRt']
      }
    }

    // DataFrame.from_records: every record has every column (None where it has none).
    const columns = [...new Set((invst as Dict[]).flatMap((r) => Object.keys(r)))]
    const toDrop = new Set(['identifiers', 'securityLending', 'issuerConditional', 'assetConditional', 'debtSec', 'currencyConditional', 'derivativeInfo', 'repurchaseAgrmt'])
    const rows = (invst as Dict[]).map((r) => {
      const row: Dict = {}
      for (const c of columns) if (!toDrop.has(c)) row[c] = r[c] === undefined ? null : r[c]
      // df["pctVal"].astype(float): None is NaN.
      row.pctVal = r.pctVal === undefined || r.pctVal === null ? null : pyFloat(r.pctVal)
      return row
    })
    // Sorted by pctVal, largest first, missing last.
    const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const [x, y] = [a.r.pctVal as number | null, b.r.pctVal as number | null]
      if (x === null || y === null) return x === y ? a.i - b.i : x === null ? 1 : -1
      return y - x || a.i - b.i
    })
    results = sorted.map(({ r }) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && !v.trim() ? null : v])))
  }

  // Extract additional information from the form that doesn't belong in the holdings table.
  const metadata: Dict = {}
  let month1 = ''
  let month2 = ''
  let month3 = ''
  try {
    const formData = response.edgarSubmission.formData
    const genInfo = formData.genInfo ?? {}
    if (truthy(genInfo)) {
      const periodEnding: string = genInfo.repPdDate
      metadata.fund_name = genInfo.seriesName
      metadata.series_id = genInfo.seriesId
      metadata.lei = genInfo.seriesLei
      metadata.period_ending = periodEnding
      metadata.fiscal_year_end = genInfo.repPdEnd
      const [y, m, d] = [Number(periodEnding.slice(0, 4)), Number(periodEnding.slice(5, 7)), Number(periodEnding.slice(8, 10))]
      if (!y || !m || !d) throw new Error(`Unknown datetime string format: ${periodEnding}`)
      const monthEnd = (offset: number) => {
        const t = new Date(Date.UTC(y, m - 1 - offset + 1, 0))
        return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
      }
      month1 = monthEnd(2)
      month2 = monthEnd(1)
      month3 = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
    const fundInfo: Dict = formData.fundInfo ?? {}
    if (truthy(fundInfo)) {
      const pop = (key: string) => {
        const v = fundInfo[key]
        delete fundInfo[key]
        return v === undefined ? null : v
      }
      metadata.total_assets = pyFloat(pop('totAssets'))
      metadata.total_liabilities = pyFloat(pop('totLiabs'))
      metadata.net_assets = pyFloat(pop('netAssets'))
      metadata.cash_and_equivalents = pop('cshNotRptdInCorD')
      const monthly = sub(sub(fundInfo, 'returnInfo'), 'monthlyTotReturns').monthlyTotReturn || {}
      const returnInfo = Array.isArray(monthly) && monthly.length ? monthly[0] : monthly
      metadata.returns = {
        [month1]: pyFloat(get(returnInfo, '@rtn1')) / 100,
        [month2]: pyFloat(get(returnInfo, '@rtn2')) / 100,
        [month3]: pyFloat(get(returnInfo, '@rtn3')) / 100,
      }
      const flow = (name: string) => ({ creation: pyFloat(get(sub(fundInfo, name), '@sales')), redemption: pyFloat(get(sub(fundInfo, name), '@redemption')) })
      metadata.flow = { [month1]: flow('mon1Flow'), [month2]: flow('mon2Flow'), [month3]: flow('mon3Flow') }
      const gain = (name: string) => ({ realized: pyFloat(get(sub(sub(fundInfo, 'returnInfo'), name), '@netRealizedGain')), unrealized: pyFloat(get(sub(sub(fundInfo, 'returnInfo'), name), '@netUnrealizedAppr')) })
      metadata.gains = { [month1]: gain('othMon1'), [month2]: gain('othMon2'), [month3]: gain('othMon3') }
      const borrowers = (fundInfo.borrowers || {}).borrower ?? []
      if (truthy(borrowers)) metadata.borrowers = (Array.isArray(borrowers) ? borrowers : borrowers).map((d: Dict) => ({ name: d['@name'], lei: d['@lei'], value: pyFloat(d['@aggrVal']) }))
    }
  } catch (err) {
    ctx.log(`Error extracting metadata: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { results: results.map(validateHolding), metadata }
}

async function fetchNport(ctx: NativeCtx, params: NativeParams): Promise<{ results: Row[]; metadata: Dict }> {
  const data = await extractData(ctx, params)
  return transformData(ctx, { symbol: String(params.symbol ?? '').toUpperCase() }, data)
}

export async function nportDisclosure(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return (await fetchNport(ctx, params)).results
}

// ---------------------------------------------------------------------------------------------------------------
// sec/nport_fund_metrics
// ---------------------------------------------------------------------------------------------------------------

export async function nportFundMetrics(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = typeof params.symbol === 'string' ? params.symbol.toUpperCase() : params.symbol
  const { metadata: data } = await fetchNport(ctx, { ...params, symbol: symbol as string })
  const f = (v: unknown): number | null => toFloatOrNull(v)
  const returns: Dict = data.returns || {}
  const flow: Dict = data.flow || {}
  const gains: Dict = data.gains || {}
  const months = [...new Set([...Object.keys(returns), ...Object.keys(flow), ...Object.keys(gains)])].sort().reverse()
  const netAssets = f(data.net_assets)
  const totalAssets = f(data.total_assets)
  const cash = f(data.cash_and_equivalents)
  const dateOf = (v: unknown): string => {
    const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(v) : null
    if (!m) throw new Error(`Input should be a valid date for period: ${JSON.stringify(v)}`)
    return m[1]!
  }

  if (!months.length) {
    const period = data.period_ending
    if (!period) throw new Error('No fund metrics were found in the filing.')
    return [{ period: dateOf(period), fund_name: data.fund_name, net_assets: netAssets, total_assets: totalAssets, cash_and_equivalents: cash, seven_day_gross_yield: f(data.seven_day_gross_yield), weighted_average_maturity: f(data.weighted_average_maturity), weighted_average_life: f(data.weighted_average_life) }]
  }
  return months.map((month) => {
    const monthFlow: Dict = flow[month] || {}
    const monthGains: Dict = gains[month] || {}
    const creation = f(monthFlow.creation)
    const redemption = f(monthFlow.redemption)
    return {
      period: dateOf(month),
      fund_name: data.fund_name,
      total_return: returns[month],
      net_assets: netAssets,
      total_assets: totalAssets,
      cash_and_equivalents: cash,
      creation,
      redemption,
      net_flow: creation !== null && redemption !== null ? creation - redemption : null,
      realized_gains: f(monthGains.realized),
      unrealized_gains: f(monthGains.unrealized),
    }
  })
}
