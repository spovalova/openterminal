// commodity/psd_data, provider usda (predefined reports). Ported from openbb_government_us/usda/utils/psd_template_parser.py
// and the report part of utils/psd_data_downloader.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of
// dicts of lists. The reports come from PSD Online's report handler as a CSV and an HTML page; the HTML only names the unit.
import type { NativeCtx } from '../types.js'
import { pyFloat } from './helpers.js'
import { KNOWN_COMMODITIES, KNOWN_REGIONS, PSD_REPORTS, REGION_ALIASES } from './psd-reports-data.js'

const REPORT_HANDLER_URL = 'https://apps.fas.usda.gov/psdonline/reportHandler.ashx'
const KNOWN_REGION_SET = new Set([...KNOWN_REGIONS, 'World Ex-US', 'Others', 'Asia'])

export type ReportItem = { region: string | null; country: string | null; commodity: string | null; attribute: string | null; marketing_year: string; value: number; unit: string }
export type ParsedReport = { report: string; template: number; data: ReportItem[]; error?: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `set_region_country`: a known region is its own region with country "--"; anything else sits under the parent region. */
function setRegionCountry(entityName: string, parentRegion: string | null): [string | null, string] {
  const name = entityName.trim()
  const normalized = REGION_ALIASES[name] ?? name
  if (normalized === 'European Union') return ['European Union', 'European Union']
  if (KNOWN_REGION_SET.has(normalized)) return [normalized, '--']
  return [parentRegion, name]
}

/** A cell as a number; the "not reported" tokens and anything unparsable are missing. */
function parseValue(raw: string): number | null {
  const val = raw.trim()
  if (!val || ['nr', 'na', '-', '--'].includes(val.toLowerCase())) return null
  return pyFloat(val.replace(/,/g, '')) ?? null
}

const hasData = (values: string[]): boolean => values.some((v) => parseValue(v) !== null)

/** The unit named in the report page's sub-title (`rptSubTitle`). */
function extractUnitFromHtml(html: string | null): string | null {
  if (!html) return null
  const match = /rptSubTitle[^>]*>([^<]+)/.exec(html)
  if (!match) return null
  const subtitle = match[1]!.trim()
  if (subtitle.includes('  ')) {
    for (const part of subtitle.split('  ').reverse()) {
      const stripped = part.trim()
      if (['Million', 'Thousand', 'Metric', 'Tons', 'Hectares', 'Bales', 'Bags'].some((u) => stripped.includes(u))) return stripped
    }
  }
  return subtitle
}

/** The longest known commodity name found in the report title (singular where the plural is also known). */
function extractCommodityFromTitle(title: string): string | null {
  const lower = title.toLowerCase()
  // Stable sort, longest first.
  const byLength = KNOWN_COMMODITIES.map((c, i) => ({ c, i })).sort((a, b) => b.c.length - a.c.length || a.i - b.i)
  for (const { c } of byLength) {
    if (lower.includes(c.toLowerCase())) return c.endsWith('s') && KNOWN_COMMODITIES.includes(c.slice(0, -1)) ? c.slice(0, -1) : c
  }
  return null
}

/** The first, third and fourth block of the (Area, Yield, Production) tables: templates 1 and 20 share this body. */
function areaYieldProduction(
  values: string[],
  periods: string[],
  units: { area: string; yield: string; production: string },
  who: { region: string | null; country: string; commodity: string | null },
  out: ReportItem[],
): void {
  const add = (attribute: string, marketing_year: string, value: number, unit: string) => out.push({ ...who, attribute, marketing_year, value, unit })
  periods.slice(0, 4).forEach((period, i) => {
    for (const [attribute, offset, unit] of [['Area', 0, units.area], ['Yield', 4, units.yield], ['Production', 8, units.production]] as const) {
      const val = offset + i < values.length ? parseValue(values[offset + i]!) : null
      if (val !== null) add(attribute, period, val, unit)
    }
  })
  const latest = periods.length ? periods[periods.length - 1]! : 'Unknown'
  for (const [index, attribute, unit] of [
    [12, 'Production Change from Last Month', units.production],
    [13, 'Production Change from Last Month (%)', '%'],
    [14, 'Production Change from Last Year', units.production],
    [15, 'Production Change from Last Year (%)', '%'],
  ] as const) {
    const val = values.length > index ? parseValue(values[index]!) : null
    if (val !== null) add(attribute, latest, val, unit)
  }
}

function unitsFromHeader(header: string, defaults: { area: string; yield: string; production: string }): { area: string; yield: string; production: string } {
  const m = [...header.matchAll(/\(([^)]+)\)/g)].map((x) => x[1]!)
  return { area: m[0] ?? defaults.area, yield: m[1] ?? defaults.yield, production: m[2] ?? defaults.production }
}

/** Template 1 (area, yield and production by country, with the month-to-month change) and 20 (the same for oilseeds). */
function parseAreaYieldProduction(lines: string[], template: 1 | 20): ParsedReport {
  const reportTitle = lines[0]!.trim()
  let commodity: string | null = null
  if (template === 1) {
    commodity = extractCommodityFromTitle(reportTitle) ?? 'Unknown'
    if (reportTitle.includes('Oilseed') || reportTitle.includes('Total')) commodity = 'Total Oilseeds'
  }
  const header = lines.length > 3 ? lines[3]! : ''
  const units = unitsFromHeader(header, template === 1 ? { area: 'Unknown', yield: 'Unknown', production: 'Unknown' } : { area: 'Million hectares', yield: 'Metric tons per hectare', production: 'Million metric tons' })
  const projLine = lines.length > 4 ? lines[4]!.split(',') : []
  const periodLine = lines.length > 5 ? lines[5]!.split(',') : []
  const periods: string[] = []
  let currentProj = ''
  periodLine.slice(1, 5).forEach((p, i) => {
    const _p = p.trim()
    // Template 1 tests the trimmed cell, template 20 the raw one.
    if (template === 1 ? _p : p) {
      const projVal = i + 1 < projLine.length ? projLine[i + 1]!.trim() : ''
      if (projVal.includes('Proj')) currentProj = projVal.replace(' Proj.', '')
      if (currentProj && MONTHS.includes(template === 1 ? _p : p)) periods.push(`${currentProj} ${_p}`)
      else periods.push(_p)
    }
  })
  if (periods.length === 0) return { report: reportTitle, template, data: [], error: 'Could not extract periods from CSV' }

  const data: ReportItem[] = []
  if (template === 1) {
    let currentRegion: string | null = null
    let prevLineEmpty = false
    for (const line of lines.slice(6)) {
      if (line && !line.trim()) {
        if (prevLineEmpty) currentRegion = null
        continue
      }
      if (!line) {
        prevLineEmpty = true
        continue
      }
      prevLineEmpty = false
      const parts = line.split(',')
      const country = parts[0]!.trim()
      if (!country) continue
      const values = parts.slice(1)
      if (!hasData(values)) {
        currentRegion = country
        continue
      }
      const [region, countryVal] = setRegionCountry(country, currentRegion)
      areaYieldProduction(values, periods, units, { region, country: countryVal, commodity }, data)
    }
    return { report: reportTitle, template, data }
  }

  let currentRegion: string | null = null
  let currentCommodity = 'Total Oilseeds'
  const aggregates = ['World Total', 'Total Foreign', 'Major OilSeeds', 'Foreign Oilseeds']
  const specialCommodities = ['Oilseed Copra', 'Oilseed Palm Kernel']
  for (const line of lines.slice(6)) {
    if (!line.trim()) {
      currentRegion = null
      continue
    }
    const parts = line.split(',')
    const first = parts[0]!.trim()
    if (!first) continue
    const values = parts.slice(1)
    const dataRow = hasData(values)
    if (specialCommodities.includes(first) && !dataRow) {
      currentCommodity = first
      continue
    }
    const regionMatch = /^([A-Za-z ]+)\s+(\d+\.?\d*)$/.exec(first)
    if (!dataRow) {
      currentRegion = first
      continue
    }
    const isAggregate = aggregates.some((agg) => first.toLowerCase().includes(agg.toLowerCase()))
    const isSpecial = specialCommodities.includes(first)
    let commodity = currentCommodity
    let who: [string | null, string]
    if (regionMatch) {
      const entity = regionMatch[1]!.trim()
      currentRegion = entity
      who = setRegionCountry(entity, null)
    } else if (isAggregate) who = setRegionCountry(first, null)
    else if (isSpecial) {
      commodity = first
      who = ['World', '--']
    } else who = setRegionCountry(first, currentRegion)
    areaYieldProduction(values, periods, units, { region: who[0], country: who[1], commodity }, data)
  }
  return { report: reportTitle, template, data }
}

/** Template 2: the world crop production summary, regions and countries across the columns. */
function parseTemplate2(lines: string[]): ParsedReport {
  const reportTitle = lines[0]!.trim()
  const regionLine = lines.length > 3 ? lines[3]!.split(',') : []
  const countryLine = lines.length > 4 ? lines[4]!.split(',') : []
  const columns: [string | null, string][] = []
  let currentRegion: string | null = null
  regionLine.forEach((regionValue, i) => {
    const region = regionValue.trim()
    const country = (i < countryLine.length ? countryLine[i]!.trim() : '').replace(/- /g, '').replace(/ -/g, '')
    if (region) currentRegion = region
    if (i === 0) return
    if (currentRegion && !country) columns.push(setRegionCountry(currentRegion, null))
    else if (country && currentRegion) columns.push([REGION_ALIASES[currentRegion] ?? currentRegion, country])
    else if (country) columns.push([null, country])
  })
  const unitLine = lines.length > 5 ? lines[5]! : ''
  const unit = unitLine.trim().replace(/^-+|-+$/g, '').trim() || 'Million metric tons'

  const data: ReportItem[] = []
  let currentCommodity: string | null = null
  let currentProjYear: string | null = null
  const monthNames = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']
  const looksLikeYear = (s: string): boolean => {
    const t = s.toLowerCase().trim()
    return t.includes('/') || t.includes('proj') || t.includes('prel') || monthNames.map((m) => m.toLowerCase()).includes(t)
  }
  const projYear = (s: string): string => s.replace('proj.', '').replace('Proj.', '').trim()
  for (const line of lines.slice(6)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    const first = parts[0]!.trim()
    const values = parts.slice(1)
    const dataRow = hasData(values)
    if (first && !dataRow) {
      if (looksLikeYear(first)) {
        if (first.toLowerCase().includes('proj')) currentProjYear = projYear(first)
        continue
      }
      currentCommodity = first.trim()
      currentProjYear = null
      continue
    }
    if (!first && !dataRow) continue
    if (!first) continue
    if (first.toLowerCase().includes('proj')) {
      currentProjYear = projYear(first)
      continue
    }
    let marketingYear: string
    if (monthNames.includes(first.trim())) marketingYear = currentProjYear ? `${currentProjYear} ${first.trim()}` : first.trim()
    else {
      marketingYear = first.trim()
      currentProjYear = null
    }
    columns.forEach(([region, country], i) => {
      if (i >= values.length) return
      const val = parseValue(values[i]!)
      if (val !== null) data.push({ region, country, commodity: currentCommodity, attribute: 'Production', marketing_year: marketingYear, value: val, unit })
    })
  }
  return { report: reportTitle, template: 2, data }
}

/** Template 3 (and 17): a block per country, years down the rows and attributes across the columns. */
function parseTemplate3(lines: string[], html: string | null, template: number): ParsedReport {
  const reportTitle = lines[0]!.trim()
  const commodity = extractCommodityFromTitle(reportTitle) ?? 'Unknown'
  const headerLine = lines.length > 2 ? lines[2]! : ''
  const columns = headerLine.split(',').slice(1).map((c) => c.trim()).filter(Boolean)
  const unit = extractUnitFromHtml(html) || 'Unknown'
  const data: ReportItem[] = []
  let currentCountry: string | null = null
  for (const line of lines.slice(3)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    const first = parts[0]!.trim()
    const values = parts.slice(1)
    if (first && !hasData(values)) {
      currentCountry = first
      continue
    }
    if (!first) continue
    const [region, country] = currentCountry ? setRegionCountry(currentCountry, null) : [null, 'Unknown']
    columns.forEach((col, i) => {
      if (i >= values.length) return
      const val = parseValue(values[i]!)
      if (val !== null) data.push({ region, country, commodity, attribute: col, marketing_year: first, value: val, unit })
    })
  }
  return { report: reportTitle, template, data }
}

/** Templates 5, 7 and 8: attribute blocks, periods across the columns; they differ in the rows (commodities or countries). */
function parseAttributeBlocks(lines: string[], html: string | null, template: 5 | 7 | 8): ParsedReport {
  const reportTitle = lines[0]!.trim()
  let commodity: string | null = null
  if (template === 7) {
    const dairy = ['Butter', 'Cheese', 'Milk', 'Skim Milk Powder', 'Whole Milk Powder', 'Whey', 'Nonfat Dry Milk', 'Fluid Milk']
    commodity = dairy.find((dc) => reportTitle.toLowerCase().includes(dc.toLowerCase())) ?? null
    if (!commodity) commodity = extractCommodityFromTitle(reportTitle) ?? 'Unknown'
  } else if (template === 8) commodity = extractCommodityFromTitle(reportTitle) ?? 'Unknown'
  const periodIndex = template === 8 ? 3 : 2
  const periodLine = lines.length > periodIndex ? lines[periodIndex]! : ''
  const periods = periodLine.split(',').slice(1).map((p) => p.trim()).filter(Boolean)
  const unit = extractUnitFromHtml(html) || 'Unknown'
  const data: ReportItem[] = []
  let currentAttribute: string | null = null
  for (const line of lines.slice(periodIndex + 1)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    const first = parts[0]!.trim()
    const values = parts.slice(1)
    if (template === 8 && ['nr', ''].includes(first.toLowerCase()) && values.every((v) => ['nr', ''].includes(v.trim().toLowerCase()))) continue
    if (first && !hasData(values)) {
      currentAttribute = first
      continue
    }
    if (!first) continue
    const [region, country] = template === 5 ? (['World', '--'] as [string, string]) : setRegionCountry(first, null)
    periods.forEach((period, i) => {
      if (i >= values.length) return
      const val = parseValue(values[i]!)
      if (val !== null) data.push({ region, country, commodity: template === 5 ? first : commodity, attribute: currentAttribute, marketing_year: period, value: val, unit })
    })
  }
  return { report: reportTitle, template, data }
}

/** Template 9: production by country for four periods, with the change from last month. */
function parseTemplate9(lines: string[], html: string | null): ParsedReport {
  const reportTitle = lines[0]!.trim()
  const unit = extractUnitFromHtml(html) || 'Million metric tons'
  const cleanPeriod = (raw: string): string => {
    const p = raw.trim()
    if (!p) return p
    let m = /^(\d{4}\/\d{2})\d*$/.exec(p)
    if (m) return m[1]!
    m = /^(Prel\.\s*\d{4}\/\d{2})\d*$/.exec(p)
    if (m) return m[1]!
    m = /^(\d{4}\/\d{2})(Proj\.?)\d*$/.exec(p)
    if (m) return `${m[1]} ${m[2]}`
    m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d*$/.exec(p)
    if (m) return m[1]!
    return p
  }
  const periodLine = lines.length > 5 ? lines[5]!.split(',') : []
  const subPeriodLine = lines.length > 6 ? lines[6]!.split(',') : []
  const periods: string[] = []
  periodLine.slice(1, 5).forEach((p, i) => {
    const _p = cleanPeriod(p)
    if (_p) {
      const sub = i + 1 < subPeriodLine.length ? cleanPeriod(subPeriodLine[i + 1]!) : ''
      periods.push(sub && ['Nov', 'Dec', 'Jan', 'Feb', 'Mar'].includes(sub) ? `${_p} ${sub}` : _p)
    }
  })
  if (periods.length === 0) return { report: reportTitle, template: 9, data: [], error: 'Could not extract periods from CSV' }
  const data: ReportItem[] = []
  let currentCommodity: string | null = null
  for (const line of lines.slice(9)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    const first = parts[0]!.trim()
    const values = parts.slice(1)
    if (first && !hasData(values)) {
      currentCommodity = first
      continue
    }
    if (!first) continue
    const [region, country] = setRegionCountry(first, null)
    periods.slice(0, 4).forEach((period, i) => {
      if (i >= values.length) return
      const val = parseValue(values[i]!)
      if (val !== null) data.push({ region, country, commodity: currentCommodity, attribute: 'Production', marketing_year: period, value: val, unit })
    })
    const latest = periods[periods.length - 1]!
    const change = values.length > 4 ? parseValue(values[4]!) : null
    if (change !== null) data.push({ region, country, commodity: currentCommodity, attribute: 'Change from Last Month', marketing_year: latest, value: change, unit })
    const changePct = values.length > 5 ? parseValue(values[5]!) : null
    if (changePct !== null) data.push({ region, country, commodity: currentCommodity, attribute: 'Change from Last Month (%)', marketing_year: latest, value: changePct, unit: '%' })
  }
  return { report: reportTitle, template: 9, data }
}

/** Template 11: commodities across the column groups, periods within each. */
function parseTemplate11(lines: string[], html: string | null): ParsedReport {
  const reportTitle = lines[0]!.trim()
  const commodities = (lines.length > 3 ? lines[3]!.split(',') : []).map((c) => c.trim()).filter(Boolean)
  const periods = (lines.length > 4 ? lines[4]!.split(',') : []).slice(2, 5).map((p) => p.trim()).filter(Boolean)
  const unit = extractUnitFromHtml(html) || 'Million Metric Tons'
  const data: ReportItem[] = []
  let currentAttribute: string | null = null
  for (const line of lines.slice(5)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    const first = parts[0]!.trim()
    const values = parts.slice(1)
    if (first && !hasData(values)) {
      currentAttribute = first
      continue
    }
    if (!first) continue
    const [region, country] = setRegionCountry(first, null)
    let valIdx = 1
    for (const commodity of commodities) {
      for (const period of periods) {
        if (valIdx < values.length) {
          const val = parseValue(values[valIdx]!)
          if (val !== null) data.push({ region, country, commodity, attribute: currentAttribute, marketing_year: period, value: val, unit })
          valIdx += 1
        }
      }
    }
  }
  return { report: reportTitle, template: 11, data }
}

/** Template 13: a country's grain supply and demand, marketing years down the rows. */
function parseTemplate13(lines: string[], html: string | null): ParsedReport {
  const reportTitle = lines[0]!.trim()
  const named = reportTitle.includes(':') ? reportTitle.split(':')[0]!.trim() : (['China', 'EU', 'India', 'Brazil', 'Russia'].find((c) => reportTitle.includes(c)) ?? null)
  const country = named || 'Unknown'
  const [region, countryVal] = setRegionCountry(country, null)
  const header = lines.length > 3 ? lines[3]! : ''
  const columns = header.split(',').slice(1).map((c) => c.trim()).filter(Boolean)
  const unit = extractUnitFromHtml(html) || 'Millions of Metric Tons/Hectares'
  const data: ReportItem[] = []
  let currentCommodity: string | null = null
  for (const line of lines.slice(4)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    const first = parts[0]!.trim()
    const values = parts.slice(1)
    if (first && !hasData(values)) {
      currentCommodity = first
      continue
    }
    if (!first) continue
    columns.forEach((col, i) => {
      if (i >= values.length) return
      const val = parseValue(values[i]!)
      if (val !== null) data.push({ region, country: countryVal, commodity: currentCommodity, attribute: col, marketing_year: first, value: val, unit })
    })
  }
  return { report: reportTitle, template: 13, data }
}

/** `parse_report`: the parser for a template id. */
export function parseReport(templateId: number, lines: string[], html: string | null): ParsedReport {
  switch (templateId) {
    case 1:
      return parseAreaYieldProduction(lines, 1)
    case 2:
      return parseTemplate2(lines)
    case 3:
    case 17:
      return parseTemplate3(lines, html, 3)
    case 5:
      return parseAttributeBlocks(lines, html, 5)
    case 7:
      return parseAttributeBlocks(lines, html, 7)
    case 8:
      return parseAttributeBlocks(lines, html, 8)
    case 9:
      return parseTemplate9(lines, html)
    case 11:
      return parseTemplate11(lines, html)
    case 13:
      return parseTemplate13(lines, html)
    case 20:
      return parseAreaYieldProduction(lines, 20)
    default:
      return { report: '', template: templateId, data: [], error: `No parser for template ${templateId}` }
  }
}

/** `get_psd_report_data`: the report's HTML page (for its unit) and CSV, parsed by its template. */
export async function getPsdReportData(ctx: NativeCtx, reportId: number): Promise<ParsedReport> {
  const report = PSD_REPORTS[String(reportId)]
  if (!report) throw new Error(`Invalid report ID -> ${reportId} was not found.`)
  const filename = report.title.replace(/ /g, '_').replace(/:/g, '').replace(/,/g, '').replace(/\//g, '_')
  const url = (format: 'csv' | 'html'): string => `${REPORT_HANDLER_URL}?reportId=${reportId}&templateId=${report.templateId}&format=${format}&fileName=${filename}`
  let html: string
  let csv: string
  try {
    html = await (await ctx.http.response(url('html'))).text()
    csv = await (await ctx.http.response(url('csv'))).text()
  } catch (err) {
    throw new Error(`Error fetching report ${reportId} -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (csv.toLowerCase().includes('error')) throw new Error(`Server error fetching report ${reportId} -> ${csv}`)
  const lines = csv.replace(/\r/g, '').trim().split('\n')
  return parseReport(report.templateId, lines, html)
}
