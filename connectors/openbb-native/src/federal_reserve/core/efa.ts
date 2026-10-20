// federal_reserve/international_portfolio_investment and federal_reserve/money_market_funds, provider federal_reserve.
// Ported from openbb_federal_reserve/models/{international_portfolio_investment,money_market_funds}.py and
// utils/{ipi,mmf}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pandas frames and pydantic
// models, ctx.cache instead of the on-disk cache.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { cmp, DAY_MS, dropNil, EmptyDataError, parseMonthDate, readCsvFrame, request, str, toNumeric } from './helpers.js'
import { pivotWide } from './workbook.js'

const BASE_URL = 'https://www.federalreserve.gov/releases/efa'

const IPI_TABLES: Record<string, [string, string]> = {
  table1: ['international-portfolio-investment-table1-historical.csv', "Foreign residents' holdings of total U.S. long-term securities"],
  table1a: ['international-portfolio-investment-table1a-historical.csv', "Foreign residents' holdings of U.S. long-term Treasury securities"],
  table1b: ['international-portfolio-investment-table1b-historical.csv', "Foreign residents' holdings of U.S. long-term agency bonds"],
  table1c: ['international-portfolio-investment-table1c-historical.csv', "Foreign residents' holdings of U.S. long-term corporate and other bonds"],
  table1d: ['international-portfolio-investment-table1d-historical.csv', "Foreign residents' holdings of U.S. corporate stocks"],
  table1e: ['international-portfolio-investment-table1e-historical.csv', "Foreign residents' holdings of U.S. short-term Treasury securities (memo)"],
  table2: ['international-portfolio-investment-table2-historical.csv', "U.S. residents' holdings of total foreign long-term securities"],
  table2a: ['international-portfolio-investment-table2a-historical.csv', "U.S. residents' holdings of foreign long-term bonds"],
  table2b: ['international-portfolio-investment-table2b-historical.csv', "U.S. residents' holdings of foreign corporate stocks"],
}

const MMF_TABLES: Record<string, string> = {
  total: 'total-money-market-funds-investment-holdings-historical.csv',
  prime: 'prime-money-market-funds-investment-holdings-historical.csv',
  government: 'government-money-market-funds-investment-holdings-historical.csv',
  exempt: 'exempt-money-market-funds-investment-holdings-historical.csv',
  holdings: 'money-market-funds-investment-holdings-historical.csv',
  detail: 'money-market-funds-investment-holdings-detail-historical.csv',
  commercial_paper: 'money-market-fund-commercial-paper-holdings-historical.csv',
  repo: 'repo-money-market-funds-holdings-historical.csv',
}

type Long = { date: string; country: string | undefined; label: string; value: number | undefined }

function download(ctx: NativeCtx, key: string, file: string): Promise<string> {
  return ctx.cache(`fed:efa:${key}`, DAY_MS, () => ctx.http.text(`${BASE_URL}/${file}`, request({ timeoutMs: 60_000 })))
}

function inWindow(rows: Long[], params: NativeParams): Long[] {
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  return rows.filter((r) => (start === undefined || r.date >= start) && (end === undefined || r.date <= end))
}

export async function internationalPortfolioInvestment(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = str(params, 'table') ?? 'table1'
  const spec = IPI_TABLES[table]
  if (!spec) throw new Error(`Invalid table: ${table}`)
  const { columns, rows } = readCsvFrame(await download(ctx, `ipi:${table}`, spec[0]))
  const names = columns.map((c) => c.trim())
  const dateAt = names.indexOf('Date')

  // parse_ipi: melt the countries, drop the rows whose date does not parse.
  let long: Long[] = []
  for (const r of rows) {
    const date = parseMonthDate(r[dateAt] ?? '')
    if (date === undefined) continue
    names.forEach((country, i) => {
      if (i !== dateAt) long.push({ date, country, label: spec[1], value: toNumeric(r[i]) })
    })
  }
  const wanted = str(params, 'country')?.trim().toLowerCase()
  if (wanted) long = long.filter((r) => r.country!.toLowerCase().includes(wanted))
  long = inWindow(long, params)
  if (long.length === 0) throw new EmptyDataError('The request was returned empty.')
  long.sort((a, b) => cmp(a.date, b.date) || cmp(a.country!, b.country!))
  return pivotWide(long, ['date', 'country'], 'label').map(dropNil)
}

export async function moneyMarketFunds(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = str(params, 'table') ?? 'total'
  const file = MMF_TABLES[table]
  if (!file) throw new Error(`Invalid table: ${table}`)
  const { columns, rows } = readCsvFrame(await download(ctx, `mmf:${table}`, file))
  const names = columns.map((c) => c.trim())
  const dateAt = names.indexOf('Date')
  const countryAt = names.indexOf('Country')

  // parse_mmf: melt the category columns, drop the rows whose date does not parse.
  let long: Long[] = []
  for (const r of rows) {
    const date = parseMonthDate(r[dateAt] ?? '')
    if (date === undefined) continue
    names.forEach((name, i) => {
      if (i === dateAt || i === countryAt) return
      long.push({ date, country: countryAt >= 0 ? r[countryAt] : undefined, label: name.replace(/\s*\(millions\)\s*$/, '').trim(), value: toNumeric(r[i]) })
    })
  }
  const wanted = str(params, 'country')?.trim().toLowerCase()
  if (wanted) long = long.filter((r) => r.country && r.country.toLowerCase().includes(wanted))
  long = inWindow(long, params)
  if (long.length === 0) throw new EmptyDataError('The request was returned empty.')
  long.sort((a, b) => cmp(a.date, b.date) || cmp(String(a.country), String(b.country)))
  return pivotWide(long, table === 'detail' ? ['date', 'country'] : ['date'], 'label').map(dropNil)
}
