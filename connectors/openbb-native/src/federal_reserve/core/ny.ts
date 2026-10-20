// federal_reserve/ny/* (all but the publications), provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/new_york_*.py and utils/{sce,ny_hhdc,ny_empire,ny_empire_survey,ny_surveys}.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas and pydantic models, ctx.cache instead
// of the on-disk cache, node-built regular expressions for the page scraping.
import type { NativeCtx, NativeHandler, Row } from '../../types.js'
import { readCsv, readSheet, strptime, toDate, type Frame, type Value } from './frame.js'
import { DAY_MS, EmptyDataError, cmp, request, str } from './helpers.js'
import { coerceNumber, seriesHandler, seriesRows, type SeriesSpec } from './series.js'
import { firstSheetCells, isIsoDateCell, pivotWide, rectangular, sheetCells } from './workbook.js'

const BASE_URL = 'https://www.newyorkfed.org'

const fetchBytes = (ctx: NativeCtx, url: string): Promise<Uint8Array> => ctx.cache(`fed:file:${url}`, DAY_MS, () => ctx.http.bytes(url, request({ timeoutMs: 120_000 })))
const fetchText = (ctx: NativeCtx, url: string): Promise<string> => ctx.cache(`fed:file:${url}`, DAY_MS, () => ctx.http.text(url, request({ timeoutMs: 120_000 })))

// ---------------------------------------------------------------------------------------------------------------
// Series files

export const supplyChainPressure = seriesHandler({
  url: `${BASE_URL}/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx`,
  sheet: 'GSCPI Monthly Data',
  rename: { Date: 'date', GSCPI: 'gscpi' },
  dateColumn: 'Date',
  dateFormat: '%d-%b-%Y',
  coerce: true,
  numeric: ['gscpi'],
})

export const corporateBondDistress = seriesHandler({
  url: `${BASE_URL}/medialibrary/research/interactives/cmdi/downloads/Market%20CMDI.xlsx`,
  sheet: 'Index Data',
  header: 5,
  rename: { eow_friday: 'date', 'Market CMDI': 'market', 'IG CMDI': 'investment_grade', 'HY CMDI': 'high_yield' },
  dateColumn: 'eow_friday',
  coerce: true,
  select: ['market', 'investment_grade', 'high_yield'],
})

export const nowcast = seriesHandler({
  url: `${BASE_URL}/medialibrary/Research/Interactives/Data/NowCast/downloads/New-York-Fed-Staff-Nowcast_download_data`,
  sheet: 'Forecasts By Horizon',
  header: 5,
  rename: { 'Forecast date': 'date', 'Reference quarter': 'reference_quarter', 'Backcast (previous quarter)': 'backcast', 'Nowcast (current quarter)': 'nowcast', 'Forecast (next quarter)': 'forecast' },
  dateColumn: 'Forecast date',
  coerce: true,
})

export const businessLeaders = seriesHandler({
  url: `${BASE_URL}/medialibrary/media/Survey/business_leaders/bls_chart_data.csv`,
  rename: { Dates: 'date', Current: 'current', Expected: 'expected' },
  dateColumn: 'Dates',
  dateFormat: '%m/%d/%Y',
})

const MCT_COLUMNS = ['date', 'mct', 'mct_upper', 'mct_upper_2', 'mct_lower', 'headline_pce', 'core_pce', 'goods', 'services_ex_housing', 'housing', 'goods_common', 'goods_sector_specific', 'services_ex_housing_common', 'services_ex_housing_sector_specific', 'housing_common', 'housing_sector_specific']

export const coreTrendInflation: NativeHandler = async (params, ctx) => {
  const url = `${BASE_URL}/medialibrary/Research/Interactives/Data/mct/mct-chart-data.csv`
  const text = await fetchText(ctx, url)
  if (!text) throw new EmptyDataError()
  // skiprows=[0, 1, 2]; the columns are then taken by position 1..16.
  const raw = readCsv(text, { skipRows: 3 })
  const positions = MCT_COLUMNS.map((_, i) => raw.columns[i + 1])
  const frame: Frame = { columns: MCT_COLUMNS, rows: raw.rows.map((r) => Object.fromEntries(MCT_COLUMNS.map((c, i) => [c, positions[i] === undefined ? null : (r[positions[i]!] ?? null)]))) }
  const spec: SeriesSpec = { url, dateColumn: 'date', dateFormat: '%m/%d/%Y', coerce: true }
  return seriesRows(frame, spec, str(params, 'start_date'), str(params, 'end_date'))
}

// ---------------------------------------------------------------------------------------------------------------
// Empire State Manufacturing Survey

const OVERVIEW_URL = `${BASE_URL}/survey/empire/empiresurvey_overview`
const ARCHIVES_URL = `${BASE_URL}/survey/empire/empiresurvey_archives`
const EMPIRE_DATASETS: Record<string, string> = {
  seasonally_adjusted_diffusion: 'esms_seasonallyadjusted_diffusion',
  not_seasonally_adjusted_diffusion: 'esms_notseasonallyadjusted_diffusion',
  seasonally_adjusted_all_series: 'esms_seasonallyadjusted_allseries',
  not_seasonally_adjusted_all_series: 'esms_notseasonallyadjusted_allseries',
}
const INDICATORS: Record<string, string> = { GA: 'general_business_conditions', NO: 'new_orders', SH: 'shipments', UO: 'unfilled_orders', DT: 'delivery_time', IV: 'inventories', PP: 'prices_paid', PR: 'prices_received', NE: 'number_of_employees', AW: 'average_workweek', AS: 'supply_availability', CE: 'capital_expenditures', TS: 'technology_spending' }
const MEASURES: Record<string, string> = { DI: 'diffusion_index', D: 'share_decrease', I: 'share_increase', N: 'share_same' }
const HORIZONS: Record<string, string> = { C: 'current', F: 'future' }

function decodeEmpire(code: string): string | undefined {
  if (!['SA', 'NA'].includes(code.slice(-2))) return undefined
  const body = code.slice(0, -2)
  const indicator = INDICATORS[body.slice(0, 2)]
  const horizon = HORIZONS[body.slice(2, 3)]
  const measure = MEASURES[body.slice(3)]
  return indicator && horizon && measure ? `${indicator}_${horizon}_${measure}` : undefined
}

export const empireStateManufacturing: NativeHandler = async (params, ctx) => {
  const dataset = str(params, 'dataset') ?? 'seasonally_adjusted_diffusion'
  const stem = EMPIRE_DATASETS[dataset]
  if (!stem) throw new Error(`Invalid dataset: ${dataset}`)
  const text = await ctx.cache(`fed:ny:empire:${dataset}`, DAY_MS, async () => {
    const overview = await ctx.http.text(OVERVIEW_URL, request({ timeoutMs: 60_000 }))
    const m = new RegExp(`(/medialibrary/media/survey/empire/data/${stem}\\.csv[^"']*)`, 'i').exec(overview)
    if (!m) return ''
    return ctx.http.text(`${BASE_URL}${m[1]!.replace(/&amp;/g, '&')}`, request({ timeoutMs: 60_000 }))
  })
  if (!text) throw new EmptyDataError()
  const frame = readCsv(text)
  const dateColumn = frame.columns[0]!
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const decoded = new Map<string, string>()
  for (const c of frame.columns) {
    if (c === dateColumn) continue
    const series = decodeEmpire(c)
    if (series) decoded.set(c, series)
  }
  const records: Row[] = []
  for (const r of frame.rows) {
    const date = toDate(r[dateColumn])
    if (date === undefined || (start && date < start) || (end && date > end)) continue
    for (const [column, series] of decoded) records.push({ date, series, value: coerceNumber(r[column]) })
  }
  return pivotWide(records, ['date'])
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const ABBR_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function classifyEmpire(filename: string): string | undefined {
  const low = filename.toLowerCase()
  const numeric = /(\d{4})[_-]?(\d{1,2})/.exec(low)
  if (numeric) {
    const year = Number(numeric[1])
    const month = Number(numeric[2])
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) return `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}`
  }
  const word = /([a-z]+)\D*(\d{4})/.exec(low)
  if (word) {
    const name = word[1]!
    const year = Number(word[2])
    const month = MONTH_NAMES.indexOf(name) + 1 || ABBR_MONTHS.indexOf(name.slice(0, 3)) + 1
    if (month && year >= 2000 && year <= 2100) return `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}`
  }
  return undefined
}

export const empireStateReports: NativeHandler = async (params, ctx) => {
  const reports = await ctx.cache('fed:ny:empire_reports', DAY_MS, async () => {
    const found = new Map<string, string>()
    // The archives page stops at the prior year, so the overview page - with the current year's releases - goes first.
    for (const url of [OVERVIEW_URL, ARCHIVES_URL]) {
      const html = await ctx.http.text(url, request({ timeoutMs: 60_000 }))
      for (const m of html.matchAll(/(\/medialibrary\/media\/[Ss]urvey\/[Ee]mpire\/[^"']*?\.pdf[^"']*)/g)) {
        const clean = m[1]!.replace(/&amp;/g, '&')
        const filename = clean.split('?')[0]!.split('/').pop()!
        const period = classifyEmpire(filename)
        if (period && !found.has(period)) found.set(period, `${BASE_URL}${clean}`)
      }
    }
    return [...found.entries()].sort((a, b) => cmp(b[0], a[0]) || cmp(b[1], a[1])).map(([period, url]) => ({ period, url }))
  })
  if (reports.length === 0) throw new EmptyDataError()
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const out: Row[] = []
  for (const r of reports) {
    const date = `${r.period.slice(0, 4)}-${r.period.slice(4, 6)}-01`
    if ((start && date < start) || (end && date > end)) continue
    out.push({ date, period: r.period, url: r.url })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Survey of Market Expectations

const SME_URL = `${BASE_URL}/markets/market-intelligence/survey-of-market-expectations`
const SUBTYPE_LABELS: Record<string, string> = { primary_dealers: 'Primary Dealers', market_participants: 'Market Participants', combined: 'Combined' }

function monthFromFilename(low: string): number | undefined {
  for (const [i, name] of MONTH_NAMES.entries()) if (low.includes(name)) return i + 1
  const abbrs: [string, number][] = [...ABBR_MONTHS.map((a, i): [string, number] => [a, i + 1]), ['sept', 9]]
  for (const [abbr, num] of abbrs.sort((a, b) => b[0].length - a[0].length)) if (new RegExp(`(^|[^a-z])${abbr}([^a-z]|$)`).test(low)) return num
  return undefined
}

type Report = { date: string; kind: string; subtype: string; title: string; url: string }

function classifyReport(year: string, filename: string): Omit<Report, 'url'> | undefined {
  const low = filename.toLowerCase()
  const month = monthFromFilename(low)
  if (month === undefined) return undefined
  const date = `${year}-${String(month).padStart(2, '0')}-01`
  const kind = low.includes('result') ? 'results' : low.includes('survey') ? 'questionnaire' : 'results'
  const subtype = /(^|[^a-z])pd([^a-z]|$)/.test(low) ? 'primary_dealers' : /(^|[^a-z])mp([^a-z]|$)/.test(low) ? 'market_participants' : 'combined'
  const title = `${MONTH_NAMES[month - 1]![0]!.toUpperCase()}${MONTH_NAMES[month - 1]!.slice(1)} ${year} ${kind[0]!.toUpperCase()}${kind.slice(1)} (${SUBTYPE_LABELS[subtype]})`
  return { date, kind, subtype, title }
}

export const marketExpectationsReports: NativeHandler = async (params, ctx) => {
  const catalog = await ctx.cache('fed:ny:sme_reports', DAY_MS, async () => {
    const html = await ctx.http.text(SME_URL, request({ timeoutMs: 60_000 }))
    const records = new Map<string, Report>()
    for (const m of html.matchAll(/\/medialibrary\/media\/markets\/survey\/(\d{4})\/([^"']+?)\.pdf/g)) {
      const record = classifyReport(m[1]!, m[2]!)
      if (!record) continue
      records.set(JSON.stringify([record.date, record.kind, record.subtype]), { ...record, url: `${BASE_URL}/medialibrary/media/markets/survey/${m[1]}/${m[2]}.pdf` })
    }
    return [...records.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).map(([, v]) => v)
  })
  if (catalog.length === 0) throw new EmptyDataError()
  const kind = str(params, 'kind')
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  return catalog.filter((r) => (!kind || r.kind === kind) && (!start || r.date >= start) && (!end || r.date <= end)).map((r) => ({ ...r }))
}

const SME_DATE_COLUMNS = ['date', 'survey_due_date', 'horizon_date']
const SME_NUMERIC_COLUMNS = ['bucket_low', 'bucket_high', 'aggregation_value']

/** `str(v)` of a cell read by pandas: an integer-valued number is `5` in an all-integer column and `5.0` beside a gap. */
function pyStr(v: Value, floatColumn: boolean): string | null {
  if (v === null) return null
  if (typeof v === 'number') return Number.isInteger(v) && floatColumn ? `${v}.0` : String(v)
  return v
}

function parseSmeWorkbook(content: Uint8Array): Row[] {
  const frame = readSheet(firstSheetCells(content))
  const rename: Record<string, string> = { survey_release_date: 'date', spd_question_number: 'question_number' }
  const columns = frame.columns.map((c) => rename[c] ?? c)
  const floatColumn = new Map<string, boolean>()
  for (const c of frame.columns) {
    const values = frame.rows.map((r) => r[c] ?? null)
    floatColumn.set(c, values.some((v) => v === null) && values.every((v) => v === null || typeof v === 'number'))
  }
  return frame.rows.map((r) => {
    const out: Row = {}
    frame.columns.forEach((orig, i) => {
      const c = columns[i]!
      const v = r[orig] ?? null
      if (SME_DATE_COLUMNS.includes(c)) {
        const d = toDate(v)
        if (d !== undefined) out[c] = d
      } else if (SME_NUMERIC_COLUMNS.includes(c)) {
        const n = coerceNumber(v)
        if (n !== null) out[c] = n
      } else {
        const s = pyStr(v, floatColumn.get(orig) ?? false)
        if (s !== null) out[c] = s
      }
    })
    return out
  })
}

async function fetchSmeData(ctx: NativeCtx): Promise<Row[]> {
  return ctx.cache('fed:ny:sme_data', DAY_MS, async () => {
    const html = await ctx.http.text(SME_URL, request({ timeoutMs: 60_000 }))
    const urls = new Set<string>()
    for (const m of html.matchAll(/\/medialibrary\/media\/markets\/survey\/(\d{4})\/([a-z0-9-]+?-data)\.xlsx/gi)) urls.add(`${BASE_URL}/medialibrary/media/markets/survey/${m[1]}/${m[2]}.xlsx`)
    // Download every workbook first (8 at a time), then parse them one by one: parsing blocks the event loop, which
    // would stall the downloads still running and have the server drop them.
    const list = [...urls]
    const files: Uint8Array[] = []
    for (let i = 0; i < list.length; i += 8) files.push(...(await Promise.all(list.slice(i, i + 8).map((u) => ctx.http.bytes(u, request({ timeoutMs: 120_000 }))))))
    const records = files.flatMap((f) => parseSmeWorkbook(f))
    const key = (r: Row) => [String(r.date ?? ''), String(r.question_number ?? ''), String(r.aggregation ?? '')]
    return records.sort((a, b) => {
      const x = key(a)
      const y = key(b)
      return cmp(y[0]!, x[0]!) || cmp(y[1]!, x[1]!) || cmp(y[2]!, x[2]!)
    })
  })
}

export const marketExpectations: NativeHandler = async (params, ctx) => {
  const data = await fetchSmeData(ctx)
  if (data.length === 0) throw new EmptyDataError()
  const panel = str(params, 'panel_type')
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const out = data.filter((r) => (!panel || r.panel_type === panel) && (!start || (r.date !== undefined && String(r.date) >= start)) && (!end || (r.date !== undefined && String(r.date) <= end)))
  if (out.length === 0) throw new EmptyDataError()
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Survey of Consumer Expectations

const SCE_URL = `${BASE_URL}/medialibrary/interactives/sce/sce/downloads/data/frbny-sce-data.xlsx`
const SCE_HOUSING_URL = `${BASE_URL}/medialibrary/interactives/sce/sce/downloads/data/frbny_sce_housing_chartdata.xlsx?sc_lang=en`
const SCE_CREDIT_URL = `${BASE_URL}/medialibrary/interactives/sce/sce/downloads/data/frbny-sce-credit-access-data.xlsx?sc_lang=en`
const SCE_LABOR_URL = `${BASE_URL}/medialibrary/media/research/microeconomics/interactive/downloads/sce-labor-chart-data-public.xlsx?sc_lang=en`

const INFLATION_SHEETS = ['Inflation expectations', 'Inflation expectations Demo', 'Inflation uncertainty', 'Inflation uncertainty Demo', 'Home price expectations', 'Home price expectations Demo', 'Home price uncertainty', 'Home price uncertainty Demo', 'Commodity expectations', 'Earnings growth', 'Earnings growth Demo', 'Earnings uncertainty', 'Earnings uncertainty Demo', 'Job separation expectation', 'Job separation expectation Demo', 'Job finding expectations', 'Job finding expectations Demo', 'Moving expectations', 'Moving expectations Demo', 'Unemployment Expectations', 'Unemployment Expectations Demo', 'HH Income Change', 'HH Income Change Demo', 'HH Spending Change', 'HH Spending Change Demo', 'Taxes Change', 'Taxes Change Demo', 'Credit availability', 'Household financial situation', 'Delinquency expectations', 'Delinquency expectations Demo', 'Interest rate expectations', 'Interest rate expectations Demo', 'Stock Prices', 'Stock Prices Demo', 'Government debt', 'Government debt Demo', 'Inflation expectations distr', 'Prob of Infl Outcome', 'Prob of Infl Outcome Demo', 'Five-year ahead Infl Exp', 'Five-year ahead Infl Exp Demo']
const HOUSING_SHEETS = ['Home Price Expectations', 'Home Price Expectations Demo', 'Home Price Change Distr', 'Home Price Change Distr Demo', 'Rent Change Expectations', 'Rent Change Expectations Demo', 'Housing as Investment', 'Housing as Investment Demo', 'Probability of Moving', 'Probability of Moving Demo', 'Probability of Buying', 'Probability of Buying Demo', 'Rate Perceptions', 'Rate Perceptions Demo', 'Rate Expectations', 'Rate Expectations Demo', 'Rate Distribution', 'Rate Distribution Demo', 'Probability of Refinancing', 'Probability of Refinancing Demo', 'Prob of Home Investments', 'Prob of Home Investments Demo', 'Home Tenure Expectations', 'Home Tenure Expectations Demo', 'Ease of Obtaining Mortgage', 'Ease of Obtaining Mortgage Demo', 'Preference for Owning', 'Preference for Owning Demo', 'Renters Prob of Buying', 'Renters Prob of Buying Demo']

const slug = (sheet: string): string => sheet.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const topicMap = (sheets: string[]): Map<string, string> => new Map(sheets.map((s) => [slug(s), s]))
const INFLATION_TOPICS = topicMap(INFLATION_SHEETS)
const HOUSING_TOPICS = topicMap(HOUSING_SHEETS)

const text = (v: Value | undefined | boolean): string => (v === null || v === undefined ? '' : String(v).trim())

/** `parse_sce`: a survey sheet's blocks of series as long (date, series, value) records. */
function parseSce(content: Uint8Array, sheet: string, start: string | undefined, end: string | undefined, headerRow = 3): Row[] {
  const raw = rectangular(sheetCells(content, sheet))
  if (raw.length <= headerRow + 1) return []
  const width = raw[0]?.length ?? 0
  // The group row, forward filled across the columns.
  const group: (string | number | boolean | null)[] = [...(raw[headerRow >= 1 ? headerRow - 1 : headerRow] ?? [])]
  if (headerRow >= 1) for (let i = 1; i < group.length; i++) if (group[i] === null) group[i] = group[i - 1] ?? null
  const labels = raw[headerRow] ?? []
  const body = raw.slice(headerRow + 1)

  const columnSeries = new Map<number, string>()
  const columnBlock = new Map<number, number>()
  let block = 0
  let gap = true
  for (let index = 1; index < width; index++) {
    const label = text(labels[index])
    if (!label || label.toLowerCase().startsWith('unnamed')) {
      gap = true
      continue
    }
    if (gap) {
      block++
      gap = false
    }
    const prefix = text(group[index])
    columnSeries.set(index, prefix && prefix !== label ? `${prefix} - ${label}` : label)
    columnBlock.set(index, block)
  }
  if (block > 1) {
    const membership = new Map<string, Set<number>>()
    for (const [index, name] of columnSeries) membership.set(name, (membership.get(name) ?? new Set()).add(columnBlock.get(index)!))
    for (const [index, name] of [...columnSeries]) if (membership.get(name)!.size > 1) columnSeries.set(index, `Estimate ${columnBlock.get(index)} - ${name}`)
  }

  const rows: Row[] = []
  for (const r of body) {
    const date = yyyymm(r[0])
    if (date === undefined || (start && date < start) || (end && date > end)) continue
    for (const [index, series] of columnSeries) rows.push({ date, series, value: coerceNumber(cellValue(r[index])) })
  }
  return rows
}

type Cell = string | number | boolean | null | undefined
const cellValue = (v: Cell): Value => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null))

/** `to_datetime(to_numeric(cell).astype("Int64").astype("string"), format="%Y%m", errors="coerce")`. */
function yyyymm(v: Cell): string | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  return strptime(String(n), '%Y%m')
}

function sceHandler(url: string, topics: Map<string, string>, defaultTopic: string, headerRow?: number): NativeHandler {
  return async (params, ctx) => {
    const topic = str(params, 'topic') ?? defaultTopic
    const sheet = topics.get(topic)
    if (!sheet) throw new Error(`Invalid topic: ${topic}`)
    const content = await fetchBytes(ctx, url)
    if (content.length === 0) throw new EmptyDataError()
    return pivotWide(parseSce(content, sheet, str(params, 'start_date'), str(params, 'end_date'), headerRow), ['date'])
  }
}

export const consumerExpectations = sceHandler(SCE_URL, INFLATION_TOPICS, 'inflation_expectations')
export const consumerHousing = sceHandler(SCE_HOUSING_URL, HOUSING_TOPICS, 'home_price_expectations', 4)

const CREDIT_LABELS: Record<string, string> = { Observations: 'Observations', Applied_Accepted: 'Applied and Accepted', Applied_Rejected: 'Applied and Rejected', Discouraged: 'Discouraged from Applying' }

export const consumerCreditAccess: NativeHandler = async (params, ctx) => {
  const breakdown = str(params, 'breakdown') ?? 'overall'
  const content = await fetchBytes(ctx, SCE_CREDIT_URL)
  if (content.length === 0) throw new EmptyDataError()
  const frame = readSheet(sheetCells(content, breakdown), 1)
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const idColumns = ['date', 'group', 'category']
  const valueColumns = frame.columns.filter((c) => !idColumns.includes(c))
  type Long = { date: string; group: string | null; category: string | null; series: string; value: number | null }
  const long: Long[] = []
  for (const r of frame.rows) {
    const date = yyyymm(r.date)
    if (date === undefined || (start && date < start) || (end && date > end)) continue
    const g = r.group === null || r.group === undefined ? null : String(r.group).trim()
    const c = r.category === null || r.category === undefined ? null : String(r.category).trim()
    for (const column of valueColumns) long.push({ date, group: g, category: c, series: CREDIT_LABELS[column] ?? column, value: coerceNumber(r[column]) })
  }
  // sort_values(["date", "group", "category", "series"]): missing values last.
  const nullLast = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : cmp(a, b))
  long.sort((a, b) => cmp(a.date, b.date) || nullLast(a.group, b.group) || nullLast(a.category, b.category) || cmp(a.series, b.series))
  return pivotWide(long as unknown as Row[], ['date', 'group', 'category'])
}

export const consumerLaborMarket: NativeHandler = async (params, ctx) => {
  const content = await fetchBytes(ctx, SCE_LABOR_URL)
  if (content.length === 0) throw new EmptyDataError()
  const frame = readSheet(sheetCells(content, 'Data'), 5)
  const first = frame.columns[0]!
  const spec: SeriesSpec = { url: SCE_LABOR_URL, rename: { [first]: 'date', Mean: 'average_reservation_wage' }, dateColumn: first, dateFormat: '%b %Y', coerce: true, select: ['average_reservation_wage'] }
  const rows = seriesRows(frame, spec, str(params, 'start_date'), str(params, 'end_date'))
  // to_numeric(...) * 1000
  return rows.map((r) => (typeof r.average_reservation_wage === 'number' ? { ...r, average_reservation_wage: r.average_reservation_wage * 1000 } : r))
}

// ---------------------------------------------------------------------------------------------------------------
// Household Debt and Credit

const HHDC_IFRAME_URL = `${BASE_URL}/householdcredit/hhdc-iframe`
const HHDC_XLSX_URL = (quarter: string) => `${BASE_URL}/medialibrary/interactives/householdcredit/data/xls/HHD_C_Report_${quarter}.xlsx`
const HHDC_TABLES: Record<string, number> = {
  total_debt_balance: 3,
  number_of_accounts_by_loan_type: 4,
  new_and_closed_accounts_and_inquiries: 5,
  mortgage_originations_by_credit_score: 6,
  credit_score_at_origination_mortgages: 7,
  auto_loan_originations_by_credit_score: 8,
  credit_score_at_origination_auto_loans: 9,
  credit_limit_and_balance_cards_and_he_revolving: 10,
  total_balance_by_delinquency_status: 11,
  percent_of_balance_90_days_delinquent_by_loan_type: 12,
  flow_into_early_delinquency_by_loan_type: 13,
  flow_into_serious_delinquency_by_loan_type: 14,
  transition_rates_current_mortgage_accounts: 15,
  transition_rates_30_60_day_late_mortgage_accounts: 16,
  new_foreclosures_and_bankruptcies: 17,
  third_party_collections: 18,
  total_debt_balance_by_age: 20,
  debt_share_by_product_type_and_age: 21,
  auto_loan_originations_by_age: 22,
  mortgage_originations_by_age: 23,
  transition_into_serious_delinquency_by_age: 24,
  transition_into_serious_delinquency_mortgages_by_age: 25,
  transition_into_serious_delinquency_auto_loans_by_age: 26,
  transition_into_serious_delinquency_credit_cards_by_age: 27,
  transition_into_serious_delinquency_student_loans_by_age: 28,
  new_foreclosures_by_age: 29,
  new_bankruptcies_by_age: 30,
  composition_of_debt_balance_per_capita_by_state: 32,
  delinquency_status_per_capita_by_state_recent: 33,
  delinquency_status_per_capita_by_state_prior: 34,
  percent_of_balance_90_days_late_by_state: 35,
  percent_of_mortgage_debt_90_days_late_by_state: 36,
  transition_rates_into_30_days_late_by_state: 37,
  transition_rates_into_90_days_late_by_state: 38,
  percent_of_consumers_with_new_foreclosures_by_state: 39,
  percent_of_consumers_with_new_bankruptcies_by_state: 40,
}

function quarterEnd(year: number, quarter: number): string {
  const month = quarter * 3
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** `_coerce_date`: a "YY:Qn" label or a date cell as an ISO date. */
function coerceQuarter(v: Cell): string | undefined {
  if (typeof v === 'string') {
    const m = /^\s*(\d{2}):Q([1-4])\s*$/.exec(v)
    if (m) {
      const two = Number(m[1])
      return quarterEnd(two < 80 ? 2000 + two : 1900 + two, Number(m[2]))
    }
    return isIsoDateCell(v) ? v.slice(0, 10) : undefined
  }
  return undefined
}

function isLabel(v: Cell): boolean {
  if (typeof v !== 'string' || !v.trim() || isIsoDateCell(v)) return false
  const low = v.trim().toLowerCase()
  return !['source', 'return', 'note', '*'].some((p) => low.startsWith(p)) && !low.includes('newyorkfed')
}

function parseHhdcSheet(content: Uint8Array, page: number, start: string | undefined, end: string | undefined): Row[] {
  const name = `Page ${page} Data`
  let cells: Cell[][]
  try {
    cells = rectangular(sheetCells(content, name))
  } catch {
    return []
  }
  const nrows = cells.length
  const ncols = cells[0]?.length ?? 0
  const at = (r: number, c: number): Cell => cells[r]?.[c]
  const title = nrows ? String(at(0, 0) ?? 'nan').split(/\s+/).filter(Boolean).join(' ') : name
  const columnDates = Array.from({ length: nrows }, (_, r) => coerceQuarter(at(r, 0)))
  const nPeriodRows = columnDates.filter((d) => d !== undefined).length
  let headerRow: number | undefined
  let headerCount = 0
  for (let r = 0; r < Math.min(6, nrows); r++) {
    let count = 0
    for (let c = 0; c < ncols; c++) if (coerceQuarter(at(r, c)) !== undefined) count++
    if (count > headerCount) {
      headerCount = count
      headerRow = r
    }
  }
  const records: Row[] = []
  const emit = (observed: string | undefined, series: string, cell: Cell): void => {
    if (observed === undefined || cell === null || cell === undefined) return
    const value = typeof cell === 'number' ? cell : typeof cell === 'boolean' ? Number(cell) : cell.trim() !== '' && Number.isFinite(Number(cell)) ? Number(cell) : undefined
    if (value === undefined) return
    records.push({ date: observed, series, value })
  }
  if (nPeriodRows && nPeriodRows >= headerCount) {
    const firstData = columnDates.findIndex((d) => d !== undefined)
    const labels = new Map<number, string>()
    for (let c = 1; c < ncols; c++) {
      const parts: string[] = []
      for (let r = 0; r < firstData; r++) {
        const v = at(r, c)
        if (isLabel(v)) parts.push((v as string).trim())
      }
      if (parts.length) labels.set(c, parts.join(' - '))
    }
    for (let r = firstData; r < nrows; r++) {
      const observed = columnDates[r]
      if (observed === undefined) continue
      for (const [c, label] of labels) emit(observed, label, at(r, c))
    }
  } else if (headerCount && headerRow !== undefined) {
    const dateColumns = new Map<number, string>()
    for (let c = 0; c < ncols; c++) {
      const d = coerceQuarter(at(headerRow, c))
      if (d !== undefined) dateColumns.set(c, d)
    }
    for (let r = headerRow + 1; r < nrows; r++) {
      const category = at(r, 0)
      if (typeof category !== 'string' || !category.trim()) continue
      for (const [c, observed] of dateColumns) emit(observed, category.trim(), at(r, c))
    }
  } else {
    const m = /(\d{4})\s*Q\s*([1-4])/.exec(title)
    const observed = m ? quarterEnd(Number(m[1]), Number(m[2])) : undefined
    let dimensionRow: number | undefined
    for (let r = 0; r < Math.min(6, nrows); r++) {
      let n = 0
      for (let c = 1; c < ncols; c++) if (isLabel(at(r, c))) n++
      if (n >= 2) {
        dimensionRow = r
        break
      }
    }
    dimensionRow ??= 2
    const dimensions = new Map<number, string>()
    for (let c = 1; c < ncols; c++) {
      const v = at(dimensionRow, c)
      if (isLabel(v)) dimensions.set(c, (v as string).trim())
    }
    for (let r = dimensionRow + 1; r < nrows; r++) {
      const category = at(r, 0)
      if (typeof category !== 'string' || !category.trim()) continue
      for (const [c, dimension] of dimensions) emit(observed, `${category.trim()} - ${dimension}`, at(r, c))
    }
  }
  return records.filter((r) => (!start || (r.date as string) >= start) && (!end || (r.date as string) <= end))
}

export const householdDebt: NativeHandler = async (params, ctx) => {
  const table = str(params, 'table') ?? 'total_debt_balance'
  const page = HHDC_TABLES[table]
  if (page === undefined) throw new Error(`Invalid table: ${table}`)
  const quarters = await ctx.cache('fed:ny:hhdc_quarters', DAY_MS, async () => {
    const html = await ctx.http.text(HHDC_IFRAME_URL, request({ timeoutMs: 60_000 }))
    return [...new Set([...html.matchAll(/(\d{4}Q\d)/g)].map((m) => m[1]!))].sort().reverse()
  })
  if (quarters.length === 0) throw new Error('No Household Debt and Credit quarters are available.')
  const content = await fetchBytes(ctx, HHDC_XLSX_URL(quarters[0]!))
  if (content.length === 0) throw new EmptyDataError()
  return pivotWide(parseHhdcSheet(content, page, str(params, 'start_date'), str(params, 'end_date')), ['date'])
}
