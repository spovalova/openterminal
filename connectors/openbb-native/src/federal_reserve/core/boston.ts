// federal_reserve/boston/economic_indicators, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/boston_economic_indicators.py and utils/boston.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain records instead of pandas and pydantic, ctx.cache instead of the on-disk cache.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { cmp, DAY_MS, EmptyDataError, request, str } from './helpers.js'
import { pivotWide } from './workbook.js'

const NEEI_URL = 'https://www.bostonfed.org/data/data-tools/new-england-economic-indicators'

const INDICATORS: Record<string, string> = {
  payroll_employment: 'Payroll Employment',
  employment_by_supersector: 'Employment by Supersector',
  labor_force_participation_rate: 'Labor Force Participation Rate',
  job_openings_rate_jolts: 'Job Openings Rate (JOLTS)',
  number_unemployed: 'Number Unemployed',
  initial_claims: 'Initial Claims',
  unemployment_rates: 'Unemployment Rates',
  u_6_rate: 'U-6 Rate',
  average_hourly_earnings: 'Average Hourly Earnings',
  personal_income: 'Personal Income',
  wages_and_salaries: 'Wages and Salaries',
  employment_cost_index: 'Employment Cost Index',
  consumer_price_index: 'Consumer Price Index',
  home_price_index: 'Home Price Index',
  housing_permits: 'Housing Permits',
  construction_contracts_dodge: 'Construction Contracts (Dodge)',
  zillow_observed_rent_index: 'Zillow Observed Rent Index',
  total_exports: 'Total Exports',
  total_exports_by_industries: 'Total Exports by Industries',
  total_exports_by_destination: 'Total Exports by Destination',
  economic_activity_index: 'Economic Activity Index',
}

const GEOGRAPHIES: Record<string, string> = { us: 'United States', new_england: 'New England', ct: 'Connecticut', me: 'Maine', ma: 'Massachusetts', nh: 'New Hampshire', ri: 'Rhode Island', vt: 'Vermont' }
const GEOGRAPHY_BY_CODE: Record<string, string> = { '111': 'us', '111100': 'new_england', '111110': 'new_england', '09': 'ct', '23': 'me', '25': 'ma', '33': 'nh', '44': 'ri', '50': 'vt', '14460': 'ma', '25540': 'ct', '38860': 'me', '31700': 'nh', '39300': 'ri', '15540': 'vt' }
const GEOGRAPHY_BY_NAME: Record<string, string> = { us: 'us', ne: 'new_england', ct: 'ct', me: 'me', ma: 'ma', nh: 'nh', ri: 'ri', vt: 'vt' }
const TRANSFORMS: Record<string, string> = { 'YRYR%': 'year_over_year_percent', index: 'index' }
const TRANSFORM_SUFFIX: Record<string, string> = { year_over_year_percent: '(Y/Y %)', index: '(Index)' }

type Series = { geography?: string; description?: string | null; name?: string | null; func?: string; dataPoints?: { date: string; nSeriesData?: number | null }[] }
type Record_ = { date: string; name: string | null; description: string | null; label: string; value: number | null | undefined }

function parseIslands(html: string): Map<string, Series[]> {
  const islands = new Map<string, Series[]>()
  for (const m of html.matchAll(/<div class="hidden series-data">\s*([^<]+?)\s*<\/div>/gs)) {
    const preceding = html.slice(Math.max(0, m.index! - 500), m.index!)
    const anchors = [...preceding.matchAll(/<a[^>]*>([^<]+)<\/a>/g)]
    const label = anchors.length ? anchors[anchors.length - 1]![1]!.trim() : ''
    if (!label) continue
    try {
      const decoded = JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as unknown
      if (Array.isArray(decoded)) islands.set(label, decoded as Series[])
    } catch {
      continue
    }
  }
  return islands
}

function resolveGeography(series: Series): string | undefined {
  const code = series.geography
  if (code !== undefined && code in GEOGRAPHY_BY_CODE) return GEOGRAPHY_BY_CODE[code]
  const description = (series.description ?? '').toLowerCase()
  if (description) {
    if (description.includes('united states') || description.includes('total u.s.')) return 'us'
    for (const [key, name] of Object.entries(GEOGRAPHIES)) {
      if (key === 'us') continue
      if (description.includes(name.toLowerCase())) return key
    }
  }
  const name = (series.name ?? '').trim().toLowerCase()
  return name in GEOGRAPHY_BY_NAME ? GEOGRAPHY_BY_NAME[name] : undefined
}

function cleanDescription(description: string | null | undefined): string {
  const base = (description ?? '').trim().replace(/^Units\s+/, '').trim()
  return base.replace(/^(?:All Empl\w*|Exp\w* Value):\s*/, '').trim()
}

function columnLabel(description: string | null | undefined, name: string | null | undefined, transform: string): string {
  let base = cleanDescription(description)
  if (!base) return (name ?? '').trim()
  const suffix = TRANSFORM_SUFFIX[transform]
  if (suffix) {
    base = base.replace(/\s*\([^()]*\)\s*\$?\s*$/, '').trim()
    return `${base} ${suffix}`
  }
  return base
}

function geographyLabel(geography: string | undefined, description: string | null | undefined, name: string | null | undefined, transform: string): string {
  if (geography === undefined || !(geography in GEOGRAPHIES)) return columnLabel(description, name, transform)
  const base = GEOGRAPHIES[geography]!
  const suffix = TRANSFORM_SUFFIX[transform]
  if (suffix) return `${base} ${suffix}`
  const m = /(\([^()]*\))\s*\$?\s*$/.exec(cleanDescription(description))
  return m ? `${base} ${m[1]}` : base
}

function isGeographyMode(list: Series[]): boolean {
  const seen = new Set<string>()
  for (const s of list) {
    const g = resolveGeography(s)
    if (g === undefined) continue
    if (seen.has(g)) return false
    seen.add(g)
  }
  return true
}

/** `os.path.commonprefix` of two strings. */
function commonPrefix(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

async function fetchIndicator(ctx: NativeCtx, indicator: string): Promise<Record_[]> {
  if (!(indicator in INDICATORS)) throw new Error(`No Boston Fed indicator '${indicator}'. Choose from ${Object.keys(INDICATORS).sort().join(', ')}.`)
  const html = await ctx.cache('fed:boston:neei', DAY_MS, () => ctx.http.text(NEEI_URL, request({ timeoutMs: 60_000 })))
  const list = parseIslands(html).get(INDICATORS[indicator]!)
  if (!list || list.length === 0) return []
  const geographyMode = isGeographyMode(list)
  const records: Record_[] = []
  for (const series of list) {
    const geography = resolveGeography(series)
    const description = cleanDescription(series.description ?? null) || null
    const name = series.name || null
    const transform = TRANSFORMS[series.func ?? ''] ?? 'level'
    const label = geographyMode ? geographyLabel(geography, series.description, name, transform) : columnLabel(series.description, name, transform)
    for (const point of series.dataPoints ?? []) records.push({ date: point.date, name, description, label, value: point.nSeriesData })
  }
  // _strip_shared_label_prefix
  const labels = [...new Set(records.map((r) => r.label))].sort(cmp)
  if (labels.length >= 2) {
    const common = commonPrefix(labels[0]!, labels[labels.length - 1]!)
    const cut = common.lastIndexOf(': ')
    if (cut !== -1) {
      const prefix = common.slice(0, cut + 2)
      for (const r of records) if (r.label.length > prefix.length && r.label.startsWith(prefix)) r.label = r.label.slice(prefix.length)
    }
  }
  return records
}

export async function economicIndicators(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const records = await fetchIndicator(ctx, str(params, 'indicator') ?? 'payroll_employment')
  if (records.length === 0) throw new EmptyDataError('The request was returned empty.')
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const ordered = records
    .filter((r) => (!start || r.date >= start) && (!end || r.date <= end))
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.label || '', b.label || '') || cmp(a.name || '', b.name || ''))
    .map((r): Row => ({ date: r.date, column: r.label || r.description || r.name || '', value: r.value ?? null }))
  return pivotWide(ordered, ['date'], 'column', 'value')
}
