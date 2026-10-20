// economy/interest_rates, economy/unemployment, economy/share_price_index, economy/house_price_index and
// economy/composite_leading_indicator, provider oecd. Ported from openbb_oecd/models/{country_interest_rates,
// unemployment,share_price_index,house_price_index,composite_leading_indicator}.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models.
import { flag, text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { areaLabel, byDateThenCountry, countryCodes, countryParam, dateWindow, fetchRows, observation, yearMonth } from './common.js'
import { oecdDate } from './query-builder.js'

const CLI_COUNTRIES = ['asia5', 'australia', 'austria', 'belgium', 'brazil', 'bulgaria', 'canada', 'chile', 'china', 'colombia', 'costa_rica', 'croatia', 'czechia', 'denmark', 'estonia', 'eu27', 'euro_area_19_countries', 'euro_area_20_countries', 'europe4', 'finland', 'france', 'g20', 'g7', 'germany', 'greece', 'hungary', 'india', 'indonesia', 'ireland', 'israel', 'italy', 'japan', 'korea', 'latvia', 'lithuania', 'luxembourg', 'mexico', 'nafta', 'netherlands', 'new_zealand', 'norway', 'oecd', 'oecd_europe', 'oecd_non_euro_area', 'poland', 'portugal', 'romania', 'russia', 'slovak_republic', 'slovenia', 'south_africa', 'spain', 'sweden', 'switzerland', 'turkiye', 'united_kingdom', 'united_states']

/** Rows of (date, country, value) from the response rows, as the routes of this file build them. */
function simpleRows(rows: Awaited<ReturnType<typeof fetchRows>>, convert: (value: number) => number): Row[] {
  const output: Row[] = []
  for (const row of rows) {
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined) continue
    const value = observation(row)
    if (value === undefined) continue
    output.push({ date: d, country: areaLabel(row), value: convert(value) })
  }
  return output.sort(byDateThenCountry)
}

// --- economy/interest_rates

const DURATION: Record<string, string> = { immediate: 'IRSTCI', short: 'IR3TIB', long: 'IRLT' }

export async function countryInterestRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const duration = text(params, 'duration') ?? 'short'
  const frequency = text(params, 'frequency') ?? 'monthly'
  if (!['monthly', 'quarter', 'annual'].includes(frequency)) throw new Error(`Input should be 'monthly', 'quarter' or 'annual', got '${frequency}' (frequency)`)
  const { start, end } = dateWindow(params, ctx, { all: '2020-01-01', one: '1954-01-01' })
  const rows = await fetchRows(ctx, 'DF_KEI', {
    start: yearMonth(start),
    end: yearMonth(end),
    dimensions: { REF_AREA: countryCodes('DF_KEI', country), FREQ: frequency[0]!.toUpperCase(), MEASURE: DURATION[duration] ?? 'IR3TIB', UNIT_MEASURE: 'PA', ACTIVITY: '_Z', ADJUSTMENT: '_Z', TRANSFORMATION: '_Z' },
  })
  return simpleRows(rows, (v) => v / 100)
}

// --- economy/unemployment

const SEX: Record<string, string> = { total: '_T', male: 'M', female: 'F' }
const AGE: Record<string, string> = { total: 'Y_GE15', '15-24': 'Y15T24', '25+': 'Y_GE25' }
const FREQ_CODE: Record<string, string> = { annual: 'A', quarter: 'Q', monthly: 'M' }

export async function unemployment(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const frequency = text(params, 'frequency') ?? 'monthly'
  if (!['monthly', 'quarter', 'annual'].includes(frequency)) throw new Error(`Input should be 'monthly', 'quarter' or 'annual', got '${frequency}' (frequency)`)
  const { start, end } = dateWindow(params, ctx, { all: '2010-01-01', one: '1950-01-01' })
  const rows = await fetchRows(ctx, 'DF_IALFS_UNE_M', {
    start: yearMonth(start),
    end: yearMonth(end),
    dimensions: {
      REF_AREA: countryCodes('DF_IALFS_UNE_M', country),
      ADJUSTMENT: flag(params, 'seasonal_adjustment', false) ? 'Y' : 'N',
      SEX: SEX[text(params, 'sex') ?? 'total'] ?? '_T',
      AGE: AGE[text(params, 'age') ?? 'total'] ?? 'Y_GE15',
      FREQ: FREQ_CODE[frequency] ?? frequency[0]!.toUpperCase(),
    },
  })
  // The window is applied to the rows as well as to the request.
  const output: Row[] = []
  for (const row of rows) {
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined || d < start || d > end) continue
    const value = observation(row)
    if (value === undefined) continue
    output.push({ date: d, country: areaLabel(row, 'all'), value: value / 100 })
  }
  return output.sort(byDateThenCountry)
}

// --- economy/share_price_index

export async function sharePriceIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const frequency = text(params, 'frequency') ?? 'monthly'
  const { start, end } = dateWindow(params, ctx, { all: '2000-01-01', one: '1958-01-01' })
  const rows = await fetchRows(ctx, 'DF_FINMARK', {
    start: yearMonth(start),
    end: yearMonth(end),
    dimensions: { REF_AREA: countryCodes('DF_FINMARK', country), FREQ: ({ monthly: 'M', quarter: 'Q', annual: 'A' } as Record<string, string>)[frequency] ?? 'M', MEASURE: 'SHARE' },
  })
  return simpleRows(rows, (v) => v)
}

// --- economy/house_price_index

export async function housePriceIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const frequency = text(params, 'frequency') ?? 'quarter'
  const transform = text(params, 'transform') ?? 'index'
  const { start, end } = dateWindow(params, ctx, { all: '2000-01-01', one: '1969-01-01' })
  const freqCode = ({ monthly: 'M', quarter: 'Q', annual: 'A' } as Record<string, string>)[frequency] ?? 'Q'
  const unit = ({ yoy: 'PA', period: 'PC', index: 'IX' } as Record<string, string>)[transform] ?? 'PA'
  const dimensions = (freq: string): Record<string, string> => ({ REF_AREA_TYPE: 'COU', REF_AREA: countryCodes('DF_RHPI_TARGET', country), FREQ: freq, MEASURE: 'RHPI', UNIT_MEASURE: unit })
  let rows: Awaited<ReturnType<typeof fetchRows>>
  try {
    rows = await fetchRows(ctx, 'DF_RHPI_TARGET', { start: yearMonth(start), end: yearMonth(end), dimensions: dimensions(freqCode) })
  } catch (exc) {
    // There is no monthly series for every country: try quarterly.
    if (freqCode !== 'M') throw new Error(exc instanceof Error ? exc.message : String(exc), { cause: exc })
    rows = await fetchRows(ctx, 'DF_RHPI_TARGET', { start: yearMonth(start), end: yearMonth(end), dimensions: dimensions('Q') })
  }
  return simpleRows(rows, (v) => (transform !== 'index' ? v / 100 : v))
}

// --- economy/composite_leading_indicator

/** The country param as the query model validates it: `all`, or the supported names (`country_validate`). */
function cliCountries(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'g20'
  const countries = raw.split(',')
  if (countries.includes('all')) return 'all'
  const valid = countries.filter((c) => CLI_COUNTRIES.includes(c.toLowerCase()))
  if (valid.length === 0) throw new Error('No valid countries found.')
  return valid.join(',')
}

export async function compositeLeadingIndicator(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = cliCountries(text(params, 'country'))
  const adjustmentParam = text(params, 'adjustment') ?? 'amplitude'
  if (adjustmentParam !== 'amplitude' && adjustmentParam !== 'normalized') throw new Error(`Input should be 'amplitude' or 'normalized', got '${adjustmentParam}' (adjustment)`)
  const growth = flag(params, 'growth_rate', false)
  // The dates default by the raw param: an explicit `all` widens nothing but the start.
  const all = text(params, 'country') === 'all'
  const start = text(params, 'start_date') || (all ? '2020-01-01' : '1947-01-01')
  const end = text(params, 'end_date') || `${String(ctx.now().getFullYear()).padStart(4, '0')}-12-31`
  const rows = await fetchRows(ctx, 'DF_CLI', {
    start,
    end,
    dimensions: { REF_AREA: countryCodes('DF_CLI', country), FREQ: 'M', MEASURE: 'LI', ADJUSTMENT: growth ? '' : adjustmentParam === 'amplitude' ? 'AA' : 'NOR', TRANSFORMATION: growth ? 'GY' : 'IX', METHODOLOGY: 'H' },
  })
  return simpleRows(rows, (v) => (growth ? v / 100 : v))
}
