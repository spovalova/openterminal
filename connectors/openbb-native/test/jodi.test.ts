// The JODI port's table code on a small synthetic archive. The oil tables are too large to record, so the recorded
// replays cover only the gas routes; this pins what both share (parsing, filters, pivots, parameter checks).
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildCountryTable, buildFieldTable, countryCodes, ingestTable, selectObservations, token } from '../src/jodi/helpers.js'
import { OIL_BALANCE_FIELDS } from '../src/jodi/constants.js'

const CSV = [
  'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE',
  'US,2024-01,CRUDEOIL,INDPROD,KBD,12553.5806,1',
  'US,2024-02,CRUDEOIL,INDPROD,KBD,13102.0690,1',
  'US,2024-02,CRUDEOIL,INDPROD,KBBL,-,1',
  'SA,2024-01,CRUDEOIL,INDPROD,KBD,8956.0000,1',
  'SA,2024-02,CRUDEOIL,INDPROD,KBD,x,1',
  'US,2024-01,CRUDEOIL,TOTIMPSB,KBD,6000,1',
  'US,2024-03,CRUDEOIL,TOTIMPSB,KBD,6100,1',
  'XX,2024-01,CRUDEOIL,INDPROD,KBD,1.5,1',
  '',
].join('\r\n')

const table = ingestTable(zipSync({ 'world_Primary.csv': strToU8(CSV) }))

describe('ingestTable', () => {
  it('keeps the numeric observations only', () => {
    expect(table.n).toBe(6)
    expect(table.areas).toEqual(['US', 'SA', 'XX'])
  })

  it('rejects a file with other columns', () => {
    expect(() => ingestTable(zipSync({ 'a.csv': strToU8('A,B\n1,2\n') }))).toThrow('Unexpected JODI file format')
  })
})

describe('slices and pivots', () => {
  it('pivots a country table: months ascending, a column per country (code kept when unknown), alphabetical', () => {
    const obs = selectObservations(table, { flows: new Set(['INDPROD']), units: new Set(['KBD']) }, '2024-01-01', '2024-12-31')
    expect(buildCountryTable(obs)).toEqual([
      { date: '2024-01-01', saudi_arabia: 8956, united_states: 12553.5806, XX: 1.5 },
      { date: '2024-02-01', united_states: 13102.069 },
    ])
  })

  it('filters by country, unit and month, and fails when nothing is left', () => {
    const only = (countries: string[], start: string, end: string) => selectObservations(table, { countries: new Set(countries), flows: new Set(['INDPROD']), units: new Set(['KBD']) }, start, end)
    expect(only(['SA'], '2024-01-15', '2024-01-31')).toEqual([{ area: 'SA', period: '2024-01', product: 'CRUDEOIL', flow: 'INDPROD', value: 8956 }])
    expect(() => only(['SA'], '2024-02-01', '2024-02-29')).toThrow('No results were found')
  })

  it('pivots a field table in the map order, only the fields with data', () => {
    const obs = selectObservations(table, { countries: new Set(['US']), flows: new Set(Object.keys(OIL_BALANCE_FIELDS)), units: new Set(['KBD']) }, '2024-01-01', '2024-03-31')
    expect(buildFieldTable(obs, 'flow', OIL_BALANCE_FIELDS)).toEqual([
      { date: '2024-01-01', production: 12553.5806, imports: 6000 },
      { date: '2024-02-01', production: 13102.069 },
      { date: '2024-03-01', imports: 6100 },
    ])
  })
})

describe('parameters', () => {
  it('accepts names, codes and lists, and refuses unknown or several countries where one is expected', () => {
    expect([...countryCodes({ country: 'US, saudi arabia' }, true, undefined)!]).toEqual(['US', 'SA'])
    expect(countryCodes({}, true, undefined)).toBeUndefined()
    expect([...countryCodes({}, false, 'united_states')!]).toEqual(['US'])
    expect(() => countryCodes({ country: 'narnia' }, true, undefined)).toThrow("Invalid country: 'narnia'")
    expect(() => countryCodes({ country: 'us,de' }, false, 'united_states')).toThrow('Only one country')
  })

  it('normalizes tokens', () => {
    expect(token({ unit: ' KBD ' }, 'unit', ['kbd', 'kbbl'], 'kbbl')).toBe('kbd')
    expect(token({}, 'unit', ['kbd', 'kbbl'], 'kbbl')).toBe('kbbl')
    expect(() => token({ unit: 'barrels' }, 'unit', ['kbd'], 'kbd')).toThrow("Invalid unit: 'barrels'")
  })
})
