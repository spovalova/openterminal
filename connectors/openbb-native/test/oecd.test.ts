import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { parseSdmxCsvLabels } from '../src/lib/sdmx.js'
import { detectIndicatorDimensions, detectTransformDimension, matchesQuery, parseSearchQuery } from '../src/oecd/helpers.js'
import { allDataflows, alsoIn, countryCodelist, dataflowParameters, dataflowsInTopic, findDataflow, normalizeLabel, resolveCountryCodes, resolveDataflow } from '../src/oecd/metadata.js'
import { buildUrl, formatPeriod, oecdDate, parseTimePeriod } from '../src/oecd/query-builder.js'
import oecd from '../src/oecd/index.js'
import type { Row } from '../src/types.js'

describe('oecd periods and urls', () => {
  it('reads SDMX periods as the day they start', () => {
    expect(parseTimePeriod('2024')).toBe('2024-01-01')
    expect(parseTimePeriod('2024-Q3')).toBe('2024-07-01')
    expect(parseTimePeriod('2024-06')).toBe('2024-06-01')
    expect(parseTimePeriod('2024-06-15')).toBe('2024-06-15')
    expect(parseTimePeriod('2024-W05')).toBe('2024-W05')
    expect(oecdDate('2024-Q2')).toBe('2024-04-01')
    expect(oecdDate('2024-13')).toBeUndefined()
    expect(oecdDate('')).toBeUndefined()
    expect(oecdDate(null)).toBeUndefined()
    expect(formatPeriod('2024-06-15')).toBe('2024-06')
    expect(formatPeriod('2024-06')).toBe('2024-06')
  })

  it('builds the data URL OpenBB builds: key in dimension order, the period in one parameter with raw brackets', () => {
    expect(buildUrl('DF_PRICES_ALL', '2025-01-01', '2025-04-30', undefined, { REF_AREA: 'USA', FREQ: 'M', METHODOLOGY: 'N', MEASURE: 'CPI', EXPENDITURE: '_T', TRANSFORMATION: 'GY' })).toBe(
      'https://sdmx.oecd.org/public/rest/v2/data/dataflow/OECD.SDD.TPS/DSD_PRICES%40DF_PRICES_ALL/1.0/USA.M.N.CPI.*._T.*.GY?dimensionAtObservation=TIME_PERIOD&detail=full&c[TIME_PERIOD]=ge:2025-01,le:2025-04',
    )
    // Without dates the request is lean; a limit asks for the latest observations.
    expect(buildUrl('DF_PRICES_ALL', undefined, undefined, 5, { ref_area: 'USA', FREQ: 'M', notADimension: 'x' })).toBe(
      'https://sdmx.oecd.org/public/rest/v2/data/dataflow/OECD.SDD.TPS/DSD_PRICES%40DF_PRICES_ALL/1.0/USA.M.*.*.*.*.*.*?dimensionAtObservation=TIME_PERIOD&lastNObservations=5&detail=dataonly',
    )
    expect(() => buildUrl('NOT_A_DATAFLOW', undefined, undefined, undefined, {})).toThrow('Unknown OECD dataflow')
  })
})

describe('oecd metadata', () => {
  it('finds dataflows by short or full id', () => {
    expect(resolveDataflow('DF_KEI').id).toBe('DSD_KEI@DF_KEI')
    expect(findDataflow('DSD_KEI@DF_KEI')?.short).toBe('DF_KEI')
    expect(findDataflow('nope')).toBeUndefined()
    expect(resolveDataflow('DF_KEI').dims.slice(0, 3)).toEqual(['REF_AREA', 'FREQ', 'MEASURE'])
  })

  it('resolves country names, codes and the wildcard', () => {
    expect(normalizeLabel('China (People\'s Republic of)')).toBe('china')
    expect(normalizeLabel('Euro area (20 countries)')).toBe('euro_area')
    expect(resolveCountryCodes('DF_KEI', 'united_states,germany')).toEqual(['USA', 'DEU'])
    expect(resolveCountryCodes('DF_KEI', 'usa, DEU')).toEqual(['USA', 'DEU'])
    expect(resolveCountryCodes('DF_KEI', 'all')).toEqual([])
    expect(resolveCountryCodes('DF_KEI', '')).toEqual([])
    expect(() => resolveCountryCodes('DF_KEI', 'atlantis')).toThrow("Invalid country 'atlantis' for dataflow 'DF_KEI'")
    expect(countryCodelist('DF_KEI').length).toBeGreaterThan(100)
  })

  it('lists a dataflow\'s dimension values, with labels where the routes read them', () => {
    const params = dataflowParameters('DF_PRICES_ALL')
    expect(params.METHODOLOGY!.map((p) => p.value)).toContain('HICP')
    expect(params.TRANSFORMATION!.find((p) => p.value === 'GY')?.label).toBe('Growth rate, over 1 year')
  })

  it('finds the topic of a dataflow and the other dataflows of an indicator', () => {
    expect(dataflowsInTopic('ECO')).toContain('DSD_EO@DF_EO')
    const also = alsoIn('GDPV_ANNPCT', 'DF_EO')
    expect(Array.isArray(also)).toBe(true)
    expect(alsoIn('NO_SUCH_INDICATOR', 'DF_EO')).toEqual([])
  })

  it('places indicator codes in their dimensions and reports the ones it cannot place', () => {
    expect(detectIndicatorDimensions('DF_KEI', ['IR3TIB'])).toEqual({ MEASURE: ['IR3TIB'] })
    expect(detectIndicatorDimensions('DF_PRICES_ALL', ['CPI_CP01'])).toMatchObject({ MEASURE: ['CPI'], EXPENDITURE: ['CP01'] })
    expect(() => detectIndicatorDimensions('DF_KEI', ['NOT_A_CODE'])).toThrow("Invalid indicator code(s) for dataflow 'DF_KEI'")
    expect(detectTransformDimension('DF_PRICES_ALL').transformLookup).toMatchObject({ gy: 'GY' })
  })

  it('parses searches like OpenBB: phrases by semicolon, + as space, | inside a term as OR', () => {
    expect(parseSearchQuery('gdp growth; unemployment|jobless')).toEqual([['gdp', 'growth'], ['unemployment|jobless']])
    expect(matchesQuery('quarterly jobless rate', parseSearchQuery('unemployment|jobless'))).toBe(true)
    expect(matchesQuery('quarterly rate', parseSearchQuery('gdp; unemployment|jobless'))).toBe(false)
    expect(matchesQuery('anything', [])).toBe(true)
  })
})

/** A `labels=both` answer for a dataflow with these dimensions. */
function csv(dims: string[], rows: string[][]): string {
  const header = ['STRUCTURE', 'STRUCTURE_ID', 'ACTION', ...dims.map((d) => `${d}: ${d}`), 'TIME_PERIOD: Time period', 'OBS_VALUE: Observation value', 'OBS_STATUS: Observation status', 'UNIT_MULT: Unit multiplier', 'DECIMALS: Decimals']
  const body = rows.map((r) => ['DATAFLOW', 'X', 'I', ...r.slice(0, -2), r.at(-2)!, r.at(-1)!, 'A: Normal value', '0: Units', '2: Two'])
  return [header, ...body].map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(',')).join('\n')
}

describe('oecd routes on canned answers', () => {
  const run = async (route: string, params: Record<string, string | boolean | number | string[]>, answer: (url: string) => string | undefined) => {
    const asked: string[] = []
    const ctx = createNativeCtx({
      fetch: async (input) => {
        const url = String(input)
        asked.push(url)
        const body = answer(url)
        return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 })
      },
      cache: new Map(),
      now: () => new Date(2026, 9, 20, 12),
    })
    const rows = (await oecd.routes[route]!(params, ctx)) as Row[]
    return { rows, asked }
  }

  it('answers the CPI route with percent changes as fractions, titles and the expenditure order', async () => {
    const dims = ['REF_AREA', 'FREQ', 'METHODOLOGY', 'MEASURE', 'UNIT_MEASURE', 'EXPENDITURE', 'ADJUSTMENT', 'TRANSFORMATION']
    const row = (exp: string, expLabel: string, period: string, value: string): string[] => ['USA: United States', 'M: Monthly', 'N: National', 'CPI: Consumer price index', 'PA: Percent per annum', `${exp}: ${expLabel}`, 'N: Not adjusted', 'GY: Growth rate, over 1 year', period, value]
    const { rows, asked } = await run('economy/cpi', { country: ['united_states'], transform: 'yoy', frequency: 'monthly', start_date: '2025-01-01', end_date: '2025-02-28', expenditure: ['total', 'health'] }, () =>
      csv(dims, [row('CP06', 'Health', '2025-01', '3'), row('_T', 'Total', '2025-02', '2.5'), row('_T', 'Total', '2025-01', '3'), row('_T', 'Total', '2025-03', '9')]),
    )
    expect(asked).toEqual(['https://sdmx.oecd.org/public/rest/v2/data/dataflow/OECD.SDD.TPS/DSD_PRICES%40DF_PRICES_ALL/1.0/USA.M.N.CPI.*._T+CP06.*.GY?dimensionAtObservation=TIME_PERIOD&detail=full&c[TIME_PERIOD]=ge:2025-01,le:2025-02'])
    // 2025-03 is outside the window; within a date the total comes before health.
    expect(rows).toEqual([
      { date: '2025-01-01', country: 'United States', country_code: 'USA', value: 0.03, unit: 'Year-over-year (YOY) percent change', unit_multiplier: 100, series_id: 'USA.M.N.CPI._T.GY', expenditure: 'Total', title: 'Monthly Consumer price index (CPI) - Total - Growth rate, over 1 year', order: 0 },
      { date: '2025-01-01', country: 'United States', country_code: 'USA', value: 0.03, unit: 'Year-over-year (YOY) percent change', unit_multiplier: 100, series_id: 'USA.M.N.CPI.CP06.GY', expenditure: 'Health', title: 'Monthly Consumer price index (CPI) - Health - Growth rate, over 1 year', order: 11 },
      { date: '2025-02-01', country: 'United States', country_code: 'USA', value: 0.025, unit: 'Year-over-year (YOY) percent change', unit_multiplier: 100, series_id: 'USA.M.N.CPI._T.GY', expenditure: 'Total', title: 'Monthly Consumer price index (CPI) - Total - Growth rate, over 1 year', order: 0 },
    ])
  })

  it('asks for each country on its own when the combined request comes back empty', async () => {
    const dims = ['REF_AREA', 'FREQ', 'MEASURE', 'UNIT_MEASURE', 'ACTIVITY', 'ADJUSTMENT', 'TRANSFORMATION']
    const one = (area: string, label: string): string => csv(dims, [[`${area}: ${label}`, 'M: Monthly', 'IR3TIB: x', 'PA: x', '_Z: x', '_Z: x', '_Z: x', '2025-01', '4']])
    const { rows, asked } = await run('economy/interest_rates', { country: ['united_states', 'germany'], duration: 'short', frequency: 'monthly', start_date: '2025-01-01', end_date: '2025-02-28' }, (url) => {
      if (url.includes('/USA+DEU.')) return ''
      return url.includes('/USA.') ? one('USA', 'United States') : url.includes('/DEU.') ? one('DEU', 'Germany') : undefined
    })
    expect(asked).toHaveLength(3)
    expect(rows).toEqual([
      { date: '2025-01-01', country: 'Germany', value: 0.04 },
      { date: '2025-01-01', country: 'United States', value: 0.04 },
    ])
  })

  it('gives up with the OECD\'s own message when nothing answers', async () => {
    await expect(run('economy/share_price_index', { country: ['united_states'], frequency: 'monthly' }, () => undefined)).rejects.toThrow('Error fetching OECD data')
  })

  it('leaves presentation tables and pivots to the OpenBB API', async () => {
    await expect(run('economy/indicators', { symbol: ['DF_KEI::IR3TIB'], country: ['united_states'], pivot: true }, () => undefined)).rejects.toThrow('not ported')
    const df = allDataflows().find((d) => (d.tables ?? []).length > 0)!
    await expect(run('economy/indicators', { symbol: [`${df.short}::${df.tables![0]}`] }, () => undefined)).rejects.toThrow('not ported')
  })

  it('parses a labels=both answer with the codes and labels split', () => {
    const rows = parseSdmxCsvLabels(csv(['REF_AREA'], [['USA: United States', '2025-01', '1.5']]))
    expect(rows[0]).toMatchObject({ REF_AREA: 'USA', REF_AREA_label: 'United States', TIME_PERIOD: '2025-01', OBS_VALUE: 1.5 })
  })
})
