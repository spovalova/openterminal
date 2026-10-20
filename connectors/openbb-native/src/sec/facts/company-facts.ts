// Company Facts: standardized financial statements from SEC XBRL data, provider sec. Ported from
// openbb_sec/utils/company_facts.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the clock is passed in from ctx.now(),
// the company-facts download goes through the shared SEC helpers, and records are plain objects.
import type { NativeCtx } from '../../types.js'
import { HEADERS, cachedRequest, symbolMap } from '../helpers.js'
import { detectCompanyType, extractAll, mergeFacts, STATEMENTS } from './schema.js'
import { pyRound } from './py.js'
import type { CompanyType, Facts, Frequency, StatementName, StatementResult, ValidationWarning } from './types.js'

export type PeriodType = 'annual' | 'quarterly' | 'both' | 'ttm' | 'yoy' | 'yoy_quarterly' | 'pop'

/** One line item of one period, in long format. */
export type StatementRecord = {
  period_ending: string
  fiscal_year: number
  fiscal_period: string
  calendar_year: number
  calendar_period: string
  tag: string
  label: string
  description: string
  parent: string | null
  sequence: number
  factor: string
  balance: string
  unit: string
  period_type: string
  currency: string
  value: number
  source: string
  frequency?: string
}

// Tickers whose full history requires merging facts from multiple CIKs. Order: newest CIK first.
const MULTI_CIK_TICKERS: Record<string, string[]> = {
  DIS: ['0001744489', '0001001039'],
  BLK: ['0002012383', '0001364742'],
  GOOG: ['0001652044', '0001288776'],
  XOM: ['0000034088', '0002115436'],
}

export type StandardizedStatements = {
  entity_name: string
  cik: number | string
  company_type: CompanyType
  currency: string
  income_statement: StatementRecord[]
  balance_sheet: StatementRecord[]
  cash_flow: StatementRecord[]
  diagnostics: ValidationWarning[]
}

/** Map a period-ending date to its calendar quarter (Q1-Q4). */
function calendarQuarter(date: string): string {
  const month = parseInt(date.slice(5, 7), 10)
  return `Q${Math.floor((month - 1) / 3) + 1}`
}

/** Convert a StatementResult into long-format records: one per line item in one period. */
function buildRecords(result: StatementResult, fiscalYears: number[] | null = null): StatementRecord[] {
  const records: StatementRecord[] = []
  const currency = result.currency

  const allZeroTags = new Set<string>()
  for (const r of result.rows) {
    const vals = Object.values(r.values)
    if (vals.length && vals.every((v) => v === 0) && (Object.keys(r.sources).length === 0 || !Object.values(r.sources).some((s) => ['imputed', 'corrected', 'reconciled'].some((p) => s.startsWith(p))))) allZeroTags.add(r.tag)
  }

  for (const date of result.dates) {
    const fm = result.fiscal_data[date]
    const fiscalYear = fm?.fiscal_year ?? parseInt(date.slice(0, 4), 10)
    const fiscalPeriod = fm?.fiscal_period ?? 'FY'
    if (fiscalYears && !fiscalYears.includes(fiscalYear)) continue

    const calendarYear = parseInt(date.slice(0, 4), 10)
    const calendarPeriod = calendarQuarter(date)

    for (const r of result.rows) {
      if (allZeroTags.has(r.tag)) continue
      const val = r.values[date]
      if (val === undefined) continue

      let sourceStr = r.sources[date] ?? ''

      // Suspect Zero policy: imputed or derived exact zeros are highly likely false identities rather than true $0
      // reported economics, especially for complex rules.
      if (val === 0 && ['imputed', 'corrected', 'reconciled', 'Q4:', 'H2:'].some((p) => sourceStr.startsWith(p))) {
        sourceStr = sourceStr.startsWith('imputed') ? sourceStr.replace('imputed', 'imputed-zero') : `imputed-zero: ${sourceStr}`
      }

      records.push({
        period_ending: date,
        fiscal_year: fiscalYear,
        fiscal_period: result.preliminary_dates.has(date) ? `${fiscalPeriod} (Preliminary)` : fiscalPeriod,
        calendar_year: calendarYear,
        calendar_period: calendarPeriod,
        tag: r.tag,
        label: r.label,
        description: r.description,
        parent: r.parent,
        sequence: r.sequence,
        factor: Object.prototype.hasOwnProperty.call(r.date_factors, date) ? r.date_factors[date]! : r.factor,
        balance: r.balance,
        unit: r.unit,
        period_type: r.period_type,
        currency,
        value: val,
        source: sourceStr,
      })
    }
  }
  return records
}

const SHARES_TAGS = new Set(['weighted_average_shares_outstanding', 'weighted_average_shares_outstanding_diluted'])

function groupByTag(records: StatementRecord[]): Map<string, StatementRecord[]> {
  const byTag = new Map<string, StatementRecord[]>()
  for (const rec of records) {
    if (!byTag.has(rec.tag)) byTag.set(rec.tag, [])
    byTag.get(rec.tag)!.push(rec)
  }
  return byTag
}

const byPeriodEnding = (a: StatementRecord, b: StatementRecord): number => (a.period_ending < b.period_ending ? -1 : a.period_ending > b.period_ending ? 1 : 0)

/** Trailing-twelve-month records from quarterly data: duration items summed over 4 quarters, instants and shares averaged. */
function computeTtm(records: StatementRecord[]): StatementRecord[] {
  const ttm: StatementRecord[] = []

  for (const [tag, tagRecs] of groupByTag(records)) {
    const sorted = [...tagRecs].sort(byPeriodEnding)
    if (sorted.length < 4) continue

    const periodType = sorted[0]!.period_type ?? 'duration'
    const useAvg = periodType === 'instant' || SHARES_TAGS.has(tag)

    for (let i = 3; i < sorted.length; i++) {
      const window = sorted.slice(i - 3, i + 1)
      const vals = window.map((w) => w.value)
      const dates = window.map((w) => w.period_ending)
      const total = vals.reduce((a, b) => a + b, 0)
      const ttmVal = useAvg ? total / 4 : total
      const method = useAvg ? 'avg' : 'sum'
      const anchor = window[window.length - 1]!

      ttm.push({
        period_ending: anchor.period_ending,
        fiscal_year: anchor.fiscal_year,
        fiscal_period: 'TTM',
        calendar_year: anchor.calendar_year,
        calendar_period: anchor.calendar_period,
        tag,
        label: anchor.label,
        description: anchor.description,
        parent: anchor.parent,
        sequence: anchor.sequence,
        factor: anchor.factor,
        balance: anchor.balance,
        unit: anchor.unit,
        period_type: anchor.period_type,
        currency: anchor.currency,
        value: ttmVal,
        source: `TTM: ${method}(${dates.join(' + ')})`,
        frequency: 'ttm',
      })
    }
  }
  return ttm
}

function pctRecord(current: StatementRecord, prior: StatementRecord, pct: number, freq: string): StatementRecord {
  return {
    period_ending: current.period_ending,
    fiscal_year: current.fiscal_year,
    fiscal_period: current.fiscal_period,
    calendar_year: current.calendar_year,
    calendar_period: current.calendar_period,
    tag: current.tag,
    label: current.label,
    description: current.description,
    parent: current.parent,
    sequence: current.sequence,
    factor: current.factor,
    balance: current.balance,
    unit: 'percent',
    period_type: current.period_type,
    currency: '',
    value: pyRound(pct, 4),
    // The source only feeds the response metadata, never a result row.
    source: `${freq}: (${current.period_ending}: ${current.value} / ${prior.period_ending}: ${prior.value} - 1) = ${pyRound(pct, 2)}%`,
    frequency: freq,
  }
}

/** Period-over-period percentage change: `yoy` against the same fiscal period of the prior fiscal year, `pop` against the preceding period. */
function computePctChange(records: StatementRecord[], mode: 'yoy' | 'pop'): StatementRecord[] {
  const out: StatementRecord[] = []

  for (const tagRecs of groupByTag(records).values()) {
    const sorted = [...tagRecs].sort(byPeriodEnding)

    if (mode === 'yoy') {
      const lookup = new Map<string, StatementRecord>()
      for (const rec of sorted) lookup.set(JSON.stringify([rec.fiscal_year, rec.fiscal_period]), rec)

      for (const rec of sorted) {
        const prior = lookup.get(JSON.stringify([rec.fiscal_year - 1, rec.fiscal_period]))
        if (prior === undefined || prior.value === 0) continue
        const pct = (rec.value - prior.value) / Math.abs(prior.value)
        out.push(pctRecord(rec, prior, pct, 'yoy'))
      }
    } else {
      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i]!
        const prior = sorted[i - 1]!
        if (prior.value === 0) continue
        const pct = ((cur.value - prior.value) / Math.abs(prior.value)) * 100
        out.push(pctRecord(cur, prior, pct, 'pop'))
      }
    }
  }
  return out
}

/** Parse an SEC company-facts JSON and produce standardized statements. */
export function resolveCompanyFacts(
  factsJson: Record<string, any>,
  opts: { fiscalYears?: number[] | null; period?: PeriodType; pitMode?: boolean; includePreliminary?: boolean; nowYear: number },
): StandardizedStatements {
  const period = opts.period ?? 'both'
  const pitMode = opts.pitMode ?? false
  const includePreliminary = opts.includePreliminary ?? false
  const fiscalYears = opts.fiscalYears ?? null
  const facts: Facts = factsJson.facts ?? {}

  const output: StandardizedStatements = {
    entity_name: factsJson.entityName ?? '',
    cik: factsJson.cik ?? '',
    company_type: detectCompanyType(facts, opts.nowYear),
    currency: 'USD',
    income_statement: [],
    balance_sheet: [],
    cash_flow: [],
    diagnostics: [],
  }
  const companyType = output.company_type

  const derived = ['ttm', 'yoy', 'yoy_quarterly', 'pop'].includes(period)

  if (derived) {
    const freq: Frequency = ['ttm', 'yoy_quarterly', 'pop'].includes(period) ? 'quarterly' : 'annual'
    const stmts = extractAll(factsJson, { frequency: freq, companyType, pitMode, includePreliminary, nowYear: opts.nowYear })
    output.currency = stmts[STATEMENTS[0]!].currency

    for (const stmtName of STATEMENTS) {
      const stmtResult = stmts[stmtName]
      let records = buildRecords(stmtResult, fiscalYears)
      for (const rec of records) rec.frequency = freq

      if (period === 'ttm') {
        records = computeTtm(records)
      } else if (period === 'yoy') {
        records = computePctChange(records, 'yoy')
      } else if (period === 'yoy_quarterly') {
        const pct = computePctChange(records, 'yoy')
        for (const rec of pct) rec.frequency = 'yoy_quarterly'
        records = pct
      } else if (period === 'pop') {
        records = computePctChange(records, 'pop')
      }

      output[stmtName].push(...records)
      output.diagnostics.push(...stmtResult.diagnostics)
    }
  } else {
    const frequencies: Frequency[] = []
    if (period === 'annual' || period === 'both') frequencies.push('annual')
    if (period === 'quarterly' || period === 'both') frequencies.push('quarterly')

    let annualStmts: Record<StatementName, StatementResult> | null = null

    for (const freq of frequencies) {
      const stmts: Record<StatementName, StatementResult> = extractAll(factsJson, { frequency: freq, companyType, pitMode, includePreliminary, annualResults: annualStmts, nowYear: opts.nowYear })
      if (freq === 'annual') annualStmts = stmts
      output.currency = stmts[STATEMENTS[0]!].currency

      for (const stmtName of STATEMENTS) {
        const stmtResult = stmts[stmtName]
        const records = buildRecords(stmtResult, fiscalYears)
        for (const rec of records) rec.frequency = freq
        output[stmtName].push(...records)
        output.diagnostics.push(...stmtResult.diagnostics)
      }
    }
  }
  return output
}

/** Fetch company facts from the SEC and return standardized financial statements. */
export async function getStandardizedFinancials(
  ctx: NativeCtx,
  opts: { symbol?: string | null; cik?: string | number | null; fiscalYears?: number[] | null; period?: PeriodType; useCache?: boolean; pitMode?: boolean; includePreliminary?: boolean },
): Promise<StandardizedStatements> {
  const useCache = opts.useCache ?? true
  let cik = opts.cik ?? null

  if (opts.symbol && !cik) {
    cik = await symbolMap(ctx, opts.symbol, useCache)
    if (!cik) throw new Error(`Could not find CIK for symbol: ${opts.symbol}`)
  }

  // Determine the list of CIKs to fetch.
  const symbolUpper = opts.symbol ? opts.symbol.toUpperCase() : ''
  let cikList: string[]
  if (symbolUpper in MULTI_CIK_TICKERS) cikList = MULTI_CIK_TICKERS[symbolUpper]!
  else if (typeof cik === 'number') cikList = [String(cik).padStart(10, '0')]
  else if (typeof cik === 'string') cikList = cik ? [cik.replace(/^0+/, '').padStart(10, '0')] : []
  else throw new Error('Either symbol or cik must be provided.')

  if (cikList.length === 0) throw new Error('Either symbol or cik must be provided.')

  const fetchOne = async (cikStr: string): Promise<Record<string, any>> => {
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikStr}.json`
    const resp = (await cachedRequest(ctx, url, { headers: HEADERS, timeoutMs: 300_000, useCache, expireS: 6 * 3600 })) as Record<string, any>
    if (!resp || typeof resp !== 'object' || Array.isArray(resp) || !('facts' in resp)) throw new Error(`Unexpected response from SEC for CIK ${cikStr}`)
    return resp
  }

  const responses: Record<string, any>[] = []
  for (const c of cikList) responses.push(await fetchOne(c))

  let factsJson: Record<string, any>
  if (responses.length === 1) {
    factsJson = responses[0]!
  } else {
    // Use the first (newest) CIK's metadata, merge all facts.
    const primary = responses[0]!
    factsJson = { entityName: primary.entityName ?? '', cik: primary.cik ?? '', facts: mergeFacts(...responses) }
  }

  return resolveCompanyFacts(factsJson, {
    fiscalYears: opts.fiscalYears ?? null,
    period: opts.period ?? 'both',
    pitMode: opts.pitMode ?? false,
    includePreliminary: opts.includePreliminary ?? false,
    nowYear: ctx.now().getFullYear(),
  })
}
