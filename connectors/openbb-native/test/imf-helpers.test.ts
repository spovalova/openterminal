import { gzipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractUnitFromLabel, normalizeCountryLabel, parseSearchQuery, parseTimePeriod, parseUnitAndScale, pyTitle, detectIndicatorDimensions, detectTransformDimension, translateErrorMessage } from '../src/imf/helpers.js'
import { dataflowParameters, indicatorsIn } from '../src/imf/metadata.js'
import { validateModel, PORT_INFO } from '../src/imf/models.js'
import { buildUrl } from '../src/imf/query-builder.js'
import { unpackJson } from '../src/lib/packed.js'

describe('imf text helpers', () => {
  it('reads periods as the date they end', () => {
    expect(parseTimePeriod('2026-M02')).toBe('2026-02-28')
    expect(parseTimePeriod('2024-M02')).toBe('2024-02-29')
    expect(parseTimePeriod('2026-Q1')).toBe('2026-03-31')
    expect(parseTimePeriod('2026-Q5')).toBe('2026-12-31')
    expect(parseTimePeriod('2026')).toBe('2026-12-31')
    expect(parseTimePeriod('2026-M13')).toBe('2026-M13')
    expect(parseTimePeriod('2026-10-08')).toBe('2026-10-08')
    expect(parseTimePeriod('')).toBe('')
  })

  it('normalises country labels to snake case', () => {
    expect(normalizeCountryLabel('United States')).toBe('united_states')
    expect(normalizeCountryLabel('Armenia, Republic of')).toBe('armenia')
    expect(normalizeCountryLabel('Euro Area (EA)')).toBe('euro_area')
    expect(normalizeCountryLabel('Guinea-Bissau')).toBe('guinea_bissau')
  })

  it('splits a unit from its scale', () => {
    expect(extractUnitFromLabel('Gross domestic product (US dollars, Millions)')).toBe('US dollars, Millions')
    expect(extractUnitFromLabel('Imports, Percent of GDP')).toBe('Percent of GDP')
    expect(extractUnitFromLabel('Imports, plain')).toBeUndefined()
    expect(extractUnitFromLabel('Wages, per capita')).toBe('per capita')
    expect(parseUnitAndScale('Percent of GDP')).toEqual(['Percent', 'of Gdp'])
    expect(parseUnitAndScale('US dollars per metric tonne')).toEqual(['US dollars', 'Per Metric Tonne'])
    expect(parseUnitAndScale('Millions, US dollar')).toEqual(['US dollar', 'Millions'])
    expect(parseUnitAndScale('Domestic currency, Millions')).toEqual(['Domestic currency', 'Millions'])
    expect(parseUnitAndScale('Per capita')).toEqual([undefined, 'Per capita'])
    expect(parseUnitAndScale(undefined)).toEqual([undefined, undefined])
    expect(pyTitle('per metric tonne')).toBe('Per Metric Tonne')
    expect(pyTitle("o'neil 3rd")).toBe("O'Neil 3Rd")
  })

  it('parses searches as OR groups of AND terms', () => {
    expect(parseSearchQuery('gdp growth')).toEqual([['gdp', 'growth']])
    expect(parseSearchQuery('inflation | "consumer price"')).toEqual([['inflation'], ['consumer price']])
    expect(parseSearchQuery('the gold + silver')).toEqual([['gold', 'silver']])
    expect(parseSearchQuery('')).toEqual([])
  })

  it('names dimensions by parameter in error messages', () => {
    expect(translateErrorMessage("Invalid value(s) for dimension 'COUNTRY': ['XXX']; 'FREQUENCY' 'M'")).toBe("Invalid value(s) for dimension 'country': ['XXX']; 'frequency' 'month'")
  })
})

describe('imf urls', () => {
  it('puts the key in dimension order, widens a period filter by one and encodes the brackets', () => {
    const url = buildUrl('CPI', '2025-01-01', '2025-06-30', undefined, { COUNTRY: 'USA+DEU', INDEX_TYPE: 'CPI', COICOP_1999: '_T', TYPE_OF_TRANSFORMATION: 'IX', FREQUENCY: 'M', lastNObservations: 3 })
    expect(url).toBe('https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/CPI/+/USA+DEU.CPI._T.IX.M?lastNObservations=3&c%5BTIME_PERIOD%5D=ge:2025-01-01+le:2025-07-01&dimensionAtObservation=TIME_PERIOD&detail=full&includeHistory=false')
  })

  it('leaves unset dimensions open and reads annual periods by year', () => {
    const url = buildUrl('BOP', '2019-03-01', '2023-12-31', undefined, { COUNTRY: ['DEU', 'FRA'], FREQUENCY: 'A' })
    expect(url).toBe('https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/BOP/+/DEU+FRA.*.*.*.A?c%5BTIME_PERIOD%5D=ge:2019-01-01+le:2024-01-01&dimensionAtObservation=TIME_PERIOD&detail=full&includeHistory=false')
    expect(buildUrl('BOP', undefined, undefined, 2, {})).toBe('https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/BOP/+/*.*.*.*.*?dimensionAtObservation=TIME_PERIOD&detail=full&includeHistory=false&lastNObservations=2')
    expect(() => buildUrl('NOPE', undefined, undefined, undefined, {})).toThrow("Dataflow 'NOPE' not found.")
  })
})

describe('imf metadata', () => {
  it('answers from the data file', () => {
    expect(dataflowParameters('CPI').INDEX_TYPE).toEqual([
      { label: 'Harmonised index of consumer prices (HICP)', value: 'HICP' },
      { label: 'Consumer price index (CPI)', value: 'CPI' },
    ])
    const il = indicatorsIn('IL')
    expect(il).toHaveLength(17)
    expect(il[0]).toMatchObject({ dataflow_id: 'IL', series_id: expect.stringMatching(/^IL::/) })
  })

  it('finds the dimension of each indicator code and reports the ones it cannot place', () => {
    expect(detectIndicatorDimensions('CPI', ['CP01'])).toEqual({ COICOP_1999: ['CP01'] })
    expect(detectIndicatorDimensions('CPI', ['HICP', 'CP01'])).toEqual({ INDEX_TYPE: ['HICP'], COICOP_1999: ['CP01'] })
    expect(() => detectIndicatorDimensions('IL', ['RAFA_USD'])).toThrow("Invalid indicator code(s) for dataflow 'IL'")
    expect(detectTransformDimension('CPI').transformLookup).toMatchObject({ index: 'IX' })
  })
})

describe('imf models', () => {
  it('renames, converts, drops what the model does not declare and leaves out what is missing', () => {
    const row = validateModel(PORT_INFO, { portid: 'port1', continent: 'Europe', countrynoaccents: 'Spain', ISO3: 'ESP', portname: 'A', fullname: 'A, Spain', lat: '41.5', lon: 2, vessel_count_total: 5, vessel_count_tanker: 1, vessel_count_container: 1, vessel_count_general_cargo: 1, vessel_count_dry_bulk: 1, vessel_count_RoRo: 1, share_country_maritime_import: 0.5, share_country_maritime_export: 0.25, junk: 1, industry_top1: null })
    expect(row).toMatchObject({ port_code: 'port1', country: 'Spain', country_code: 'ESP', latitude: 41.5, vessel_count_roro: 1 })
    expect(row).not.toHaveProperty('junk')
    expect(row).not.toHaveProperty('industry_top1')
    expect(() => validateModel(PORT_INFO, { portid: 'port1' })).toThrow('field required')
    expect(() => validateModel(PORT_INFO, { portid: 'p', continent: 'x', countrynoaccents: 'x', ISO3: 'x', portname: 'x', fullname: 'x', lat: 1, lon: 1, vessel_count_total: 1.5 })).toThrow('valid integer')
  })
})

describe('packed data', () => {
  it('unpacks gzipped base64 JSON', () => {
    const value = { a: [1, 2, 3], b: 'ü' }
    const packed = { format: 1, gzip_base64: Buffer.from(gzipSync(strToU8(JSON.stringify(value)))).toString('base64') }
    expect(unpackJson(packed)).toEqual(value)
  })
})
