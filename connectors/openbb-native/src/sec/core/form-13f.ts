// equity/ownership/form_13f, provider sec. Ported from openbb_sec/models/form_13FHR.py and openbb_sec/utils/parse_13f.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames (the groupby is a Map), xmltodict
// is fast-xml-parser, and a 13F without an <informationTable> tag falls back to a prefix-tolerant regex instead of
// BeautifulSoup's xml parser.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { fetchCompanyFilings } from '../company-filings.js'
import { HEADERS, secResponse } from '../helpers.js'
import { isDict, xmlToDict, type XmlDict, type XmlValue } from './xmltodict.js'

/** `date_to_quarter_end`: the last day of the calendar quarter containing the date. */
export function dateToQuarterEnd(date: string): string {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))]
  const endMonth = Math.floor((m - 1) / 3) * 3 + 3
  const day = new Date(Date.UTC(y, endMonth, 0)).getUTCDate()
  return `${y}-${String(endMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** numpy's round-half-to-even at `decimals` places, as `Series.round` does. */
export function npRound(x: number, decimals: number): number {
  const f = 10 ** decimals
  const y = x * f
  let r = Math.round(y)
  if (Math.abs(y - Math.trunc(y)) === 0.5 && r % 2 !== 0) r -= 1
  return r / f
}

/** `to_datetime(period, yearfirst=False).date()` for the formats a 13F carries (MM-DD-YYYY, or ISO). */
function periodToDate(period: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(period)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(period.trim())
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`
  throw new Error(`Unknown datetime string format, unable to parse: ${period}`)
}

type Filing = { reportDate: string; url: string }

/** `get_13f_candidates`: the 13F-HR filings of a symbol or CIK since mid-2013, newest first. */
async function get13fCandidates(ctx: NativeCtx, symbol: string, isCik: boolean): Promise<Filing[]> {
  const filings = await fetchCompanyFilings(ctx, { ...(isCik ? { cik: symbol } : { symbol }), use_cache: false, form_type: '13F-HR' })
  if (filings.length === 0) throw new Error(`No 13F-HR filings found for ${symbol}.`)
  // Filings before June 30, 2013 are non-structured and are not supported by downstream parsers.
  return filings.filter((f) => typeof f.report_date === 'string' && f.report_date >= '2013-06-30').map((f) => ({ reportDate: f.report_date as string, url: f.complete_submission_url as string }))
}

type InfoTableRow = XmlDict

/** The `infoTable` entries of a 13F: the whole `informationTable` element, wherever the prefix puts it. */
function informationTable(filing: string, text: string): InfoTableRow[] {
  const match = /<informationTable[\s>][\s\S]*<\/informationTable>/.exec(text)
  let xml = match?.[0]
  if (!xml) {
    // Other namespace prefixes than ns1/n1: drop every prefix (BeautifulSoup's xml parser finds the tag by its local name).
    const loose = /<(?:[\w.-]+:)?informationTable[\s>][\s\S]*<\/(?:[\w.-]+:)?informationTable>/.exec(filing)
    xml = loose?.[0].replace(/<(\/?)[\w.-]+:/g, '<$1')
  }
  if (!xml) throw new Error("Failed to parse the 13F-HR information table. Check the `filing_str` to make sure it is valid and contains the tag 'informationTable'. Documents filed before Q2 2013 are not supported.")
  const parsed = (xmlToDict(xml).informationTable as XmlDict | null)?.infoTable as XmlValue | undefined
  if (parsed === undefined || parsed === null) throw new Error("Failed to parse the 13F-HR information table. Check the `filing_str` to make sure it is valid and contains the tag 'informationTable'. Documents filed before Q2 2013 are not supported.")
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(isDict)
}

const text = (v: XmlValue | undefined): string | null => (typeof v === 'string' ? v : null)

/** `parse_13f_hr`: one filing's holdings, aggregated by security, with weights. */
async function parse13fHr(ctx: NativeCtx, url: string): Promise<Row[]> {
  return ctx.cache(`sec:GET ${url} ::13f-parsed`, 7 * 24 * 3600 * 1000, async () => {
    const res = await secResponse(ctx, url, { headers: HEADERS })
    if (res.status !== 200) throw new Error(`Request failed with status code ${res.status}`)
    const filing = await res.text()
    const flat = filing.replaceAll('ns1:', '').replaceAll('n1:', '')
    const rows = informationTable(filing, flat)

    const periods = [...flat.matchAll(/<periodOfReport>([^<]+)<\/periodOfReport>/g)]
    const periodText = periods[0]?.[1] ?? /<(?:[\w.-]+:)?periodOfReport>([^<]+)</.exec(flat)?.[1]
    if (!periodText) throw new Error('Failed to get the period of report from the form header. Check the response from `parse_header`.')
    const periodEnding = periodToDate(periodText)

    type Holding = { nameOfIssuer: string | null; cusip: string | null; titleOfClass: string | null; security_type: string | null; putCall: string; investmentDiscretion: string | null; value: number; principal_amount: number; sole: number; shared: number; none: number }
    const holdings: Holding[] = rows.map((r) => {
      const shrs = r.shrsOrPrnAmt
      const voting = r.votingAuthority
      if (!isDict(shrs)) throw new Error("KeyError: 'shrsOrPrnAmt'")
      if (!isDict(voting)) throw new Error("KeyError: 'votingAuthority'")
      const toInt = (v: XmlValue | undefined): number => {
        if (v === null || v === undefined || v === '') return 0
        if (typeof v !== 'string' || !/^\s*[+-]?\d+\s*$/.test(v)) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(v)}`)
        return parseInt(v, 10)
      }
      const rawValue = text(r.value)
      if (rawValue === null || !/^\s*[+-]?\d+\s*$/.test(rawValue)) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(rawValue)}`)
      const putCall = text(r.putCall)
      return {
        nameOfIssuer: text(r.nameOfIssuer),
        cusip: text(r.cusip),
        titleOfClass: text(r.titleOfClass),
        security_type: text(shrs.sshPrnamtType),
        putCall: putCall ?? '--',
        investmentDiscretion: text(r.investmentDiscretion),
        value: parseInt(rawValue, 10),
        principal_amount: toInt(shrs.sshPrnamt),
        sole: toInt(voting.Sole),
        shared: toInt(voting.Shared),
        none: toInt(voting.None),
      }
    })

    // Aggregate by period, issuer, CUSIP, class, security type, option type and discretion: groupby drops rows with a missing key.
    const groups = new Map<string, Holding>()
    for (const h of holdings) {
      const keyParts = [h.nameOfIssuer, h.cusip, h.titleOfClass, h.security_type, h.putCall, h.investmentDiscretion]
      if (keyParts.some((k) => k === null)) continue
      const key = JSON.stringify(keyParts)
      const g = groups.get(key)
      if (g) {
        g.value += h.value
        g.principal_amount += h.principal_amount
        g.sole += h.sole
        g.shared += h.shared
        g.none += h.none
      } else groups.set(key, { ...h })
    }
    const sortKey = (h: Holding): string[] => [h.nameOfIssuer!, h.cusip!, h.titleOfClass!, h.security_type!, h.putCall, h.investmentDiscretion!]
    const grouped = [...groups.values()].sort((a, b) => {
      const [ka, kb] = [sortKey(a), sortKey(b)]
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1
      return 0
    })
    const votingColumns = (['sole', 'shared', 'none'] as const).filter((c) => !grouped.every((g) => g[c] === 0))
    const totalValue = grouped.reduce((s, g) => s + g.value, 0)
    const records = grouped.map((g) => {
      const row: Row = {
        period_ending: periodEnding,
        nameOfIssuer: g.nameOfIssuer,
        cusip: g.cusip,
        titleOfClass: g.titleOfClass,
        security_type: g.security_type,
        putCall: g.putCall === '--' ? null : g.putCall,
        investmentDiscretion: g.investmentDiscretion,
        value: g.value,
        principal_amount: g.principal_amount,
        weight: totalValue ? npRound(g.value / totalValue, 6) : 0.0,
      }
      for (const c of votingColumns) row[`voting_authority_${c}`] = g[c]
      return row
    })
    return records.map((r, i) => ({ r, i })).sort((a, b) => (b.r.weight as number) - (a.r.weight as number) || a.i - b.i).map(({ r }) => r)
  })
}

export async function form13f(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? '').toUpperCase()
  const limit = params.limit === undefined || params.limit === null ? 1 : Number(params.limit)
  const date = typeof params.date === 'string' && params.date ? params.date : undefined
  const filings = await get13fCandidates(ctx, symbol, /^\d+$/.test(symbol))
  let urls: string[] = []
  if (limit && date === undefined) urls = filings.slice(0, limit).map((f) => f.url)
  if (date !== undefined) {
    const quarterEnd = dateToQuarterEnd(date)
    const found = filings.filter((f) => f.reportDate === quarterEnd)
    if (found.length === 0) throw new Error(`KeyError: '${quarterEnd}'`)
    // `filings.loc[date]` is a Series when an amendment shares the report date; OpenBB then fails on it.
    if (found.length > 1) throw new Error(`More than one 13F-HR filing (an amendment) has the report date ${quarterEnd}; OpenBB cannot select one.`)
    urls = [found[0]!.url]
  }
  const results = (await Promise.all(urls.map((url) => parse13fHr(ctx, url)))).flat()
  if (!results.length) throw new Error('No data was returned with the given parameters.')

  const rows = results.map((d) => ({
    period_ending: d.period_ending,
    issuer: d.nameOfIssuer,
    cusip: d.cusip,
    asset_class: d.titleOfClass,
    security_type: d.security_type,
    option_type: typeof d.putCall === 'string' && d.putCall ? d.putCall.toLowerCase() : null,
    investment_discretion: d.investmentDiscretion,
    voting_authority_sole: d.voting_authority_sole,
    voting_authority_shared: d.voting_authority_shared,
    voting_authority_none: d.voting_authority_none,
    principal_amount: d.principal_amount,
    value: d.value,
    weight: d.weight ?? 0.0,
  }))
  // `sorted(…, key=(period_ending, weight), reverse=True)`: stable, so equal keys stay in order.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.period_ending! < b.r.period_ending! ? 1 : a.r.period_ending! > b.r.period_ending! ? -1 : (b.r.weight as number) - (a.r.weight as number) || a.i - b.i))
    .map(({ r }) => r)
}
