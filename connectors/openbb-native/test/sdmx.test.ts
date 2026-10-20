import { describe, expect, it } from 'vitest'
import { fromIsoCalendar, isoDate, parseSdmxCsv, parseSdmxCsvLabels, parseSdmxJson, parseSdmxSeriesKeys, parseSdmxXml, pyFloat, readCsvFrame, sdmxPeriodStart } from '../src/lib/sdmx.js'

describe('sdmx periods', () => {
  it('turns TIME_PERIODs into the ISO date their period starts', () => {
    expect(sdmxPeriodStart('2026')).toBe('2026-01-01')
    expect(sdmxPeriodStart('2026-03')).toBe('2026-03-01')
    expect(sdmxPeriodStart('2026-Q3')).toBe('2026-07-01')
    expect(sdmxPeriodStart('2026-S2')).toBe('2026-07-01')
    expect(sdmxPeriodStart('2026-S1')).toBe('2026-01-01')
    expect(sdmxPeriodStart('2026-W01')).toBe('2025-12-29')
    expect(sdmxPeriodStart('2026-10-08')).toBe('2026-10-08')
    expect(sdmxPeriodStart('2026-Q5')).toBe('2026-Q5')
    expect(sdmxPeriodStart('2026-13')).toBe('2026-13')
    expect(sdmxPeriodStart('2026-W54')).toBe('2026-W54')
    expect(sdmxPeriodStart('', undefined)).toBe('')
  })

  it('prefers the start timestamp a message carries', () => {
    expect(sdmxPeriodStart('2026-Q2', '2026-04-01T00:00:00.000+02:00')).toBe('2026-04-01')
  })

  it('knows which calendar days exist', () => {
    expect(isoDate(2024, 2, 29)).toBe('2024-02-29')
    expect(isoDate(2025, 2, 29)).toBeUndefined()
    expect(isoDate(2025, 4, 31)).toBeUndefined()
    expect(isoDate(0, 1, 1)).toBeUndefined()
    expect(fromIsoCalendar(2020, 53, 1)).toBe('2020-12-28')
    expect(fromIsoCalendar(2021, 53, 1)).toBeUndefined()
  })

  it('reads numbers the way Python float() does', () => {
    expect(pyFloat(' 1.5e3 ')).toBe(1500)
    expect(pyFloat('1_000.5')).toBe(1000.5)
    expect(pyFloat('1,5')).toBeUndefined()
    expect(pyFloat('')).toBeUndefined()
    expect(pyFloat('-inf')).toBe(-Infinity)
  })
})

const message = {
  dataSets: [
    {
      series: {
        '0:0': { attributes: [0, null], observations: { '0': [1.5, 0], '1': [null, null] } },
        '1:0': { attributes: [null, 0], observations: { '0': [2.5, null] } },
      },
    },
  ],
  structure: {
    dimensions: {
      series: [
        { id: 'FREQ', values: [{ id: 'M', name: 'Monthly' }, { id: 'D', name: 'Daily' }] },
        { id: 'AREA', values: [{ id: 'U2', name: 'Euro area' }] },
      ],
      observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-01', start: '2026-01-01T00:00:00.000+01:00' }, { id: '2026-02' }] }],
    },
    attributes: {
      series: [{ id: 'UNIT', values: [{ id: 'PC', name: 'Percent' }] }, { id: 'DECIMALS', values: [{ id: '2' }] }],
      observation: [{ id: 'OBS_STATUS', values: [{ id: 'A', name: 'Normal' }] }],
    },
  },
}

describe('sdmx-json', () => {
  it('flattens a data message into one record per observation', () => {
    const rows = parseSdmxJson(message)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ FREQ: 'M', FREQ__label: 'Monthly', AREA: 'U2', AREA__label: 'Euro area', series_key: 'M.U2', UNIT: 'PC', UNIT__label: 'Percent', period: '2026-01', date: '2026-01-01', OBS_VALUE: 1.5, OBS_STATUS: 'A', _dim_ids: ['FREQ', 'AREA'] })
    // A missing value stays null; a period without a start timestamp is read from its id.
    expect(rows[1]).toMatchObject({ date: '2026-02-01', OBS_VALUE: null })
    expect(rows[1]).not.toHaveProperty('OBS_STATUS')
    expect(rows[2]).toMatchObject({ FREQ: 'D', series_key: 'D.U2', DECIMALS: '2' })
    expect(rows[2]).not.toHaveProperty('UNIT')
  })

  it('lists the series of a serieskeysonly message with their names', () => {
    const rows = parseSdmxSeriesKeys({ dataSets: [{ series: { '0:0': {}, '1:0': {} } }], structure: message.structure })
    expect(rows).toEqual([
      { FREQ: 'M', FREQ__label: 'Monthly', AREA: 'U2', AREA__label: 'Euro area', series_key: 'M.U2', name: 'Monthly — Euro area' },
      { FREQ: 'D', FREQ__label: 'Daily', AREA: 'U2', AREA__label: 'Euro area', series_key: 'D.U2', name: 'Daily — Euro area' },
    ])
    expect(parseSdmxJson(undefined)).toEqual([])
    expect(parseSdmxJson({ dataSets: [] })).toEqual([])
  })
})

describe('sdmx-csv', () => {
  it('reads csvdata, dropping the empty columns and stripping the flow from the key', () => {
    const rows = parseSdmxCsv('KEY,FREQ,UNIT,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,,2026-10-01,1.1298\nEXR.D.USD.EUR.SP00.A,D,,2026-10-02,\n', 'EXR')
    expect(rows).toEqual([
      { FREQ: 'D', series_key: 'D.USD.EUR.SP00.A', period: '2026-10-01', date: '2026-10-01', OBS_VALUE: 1.1298 },
      { FREQ: 'D', series_key: 'D.USD.EUR.SP00.A', period: '2026-10-02', date: '2026-10-02', OBS_VALUE: null },
    ])
  })

  it('reads a frame like pandas: missing cells are null and all-number columns are numbers', () => {
    expect(readCsvFrame('a,b,c\n1,x,\n2.5,NA,3\n')).toEqual({
      columns: ['a', 'b', 'c'],
      rows: [{ a: 1, b: 'x', c: null }, { a: 2.5, b: null, c: 3 }],
    })
  })

  it('splits labels=both columns and cells into a code and a label', () => {
    const csv = [
      'DATAFLOW,REF_AREA: Reference area,MEASURE: Measure,TIME_PERIOD: Time period,OBS_VALUE: Observation value,UNIT_MULT: Unit multiplier,BASE_PER: Base period',
      'OECD.SDD:DF_X(1.0),USA: United States,CPI: Consumer price index,2026-01,101.5,0: Units,',
      'OECD.SDD:DF_X(1.0),DEU: Germany,CPI: Consumer price index,2026-01,,0: Units,2015',
    ].join('\n')
    const rows = parseSdmxCsvLabels(csv)
    expect(rows[0]).toMatchObject({ REF_AREA: 'USA', REF_AREA_label: 'United States', MEASURE: 'CPI', MEASURE_label: 'Consumer price index', 'TIME_PERIOD': '2026-01', OBS_VALUE: 101.5, UNIT_MULT: '0', UNIT_MULT_label: 'Units', BASE_PER: null })
    expect(rows[1]).toMatchObject({ REF_AREA: 'DEU', OBS_VALUE: null, BASE_PER: 2015 })
    // Columns without ": " are not split.
    expect(rows[0]!.DATAFLOW).toBe('OECD.SDD:DF_X(1.0)')
    expect(rows[0]).not.toHaveProperty('DATAFLOW_label')
  })
})

describe('sdmx structure-specific xml', () => {
  it('reads series, their observations and series-level groups', () => {
    const xml = `<?xml version="1.0"?>
<message:StructureSpecificData xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v3_0/message" xmlns:ss="http://www.sdmx.org/resources/sdmxml/schemas/v3_0/data/structurespecific" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <message:DataSet xsi:type="ns1:DataSetType">
    <Group xsi:type="ns1:Group" INDICATOR="PCPI_IX"><Comp id="UNIT"><Value>IX</Value></Comp></Group>
    <Series COUNTRY="USA" INDICATOR="PCPI_IX" FREQUENCY="M">
      <Obs TIME_PERIOD="2026-01" OBS_VALUE="101.5"/>
      <Obs TIME_PERIOD="2026-02" OBS_VALUE="102"/>
    </Series>
    <Series COUNTRY="DEU" INDICATOR="PCPI_IX" FREQUENCY="M"><Obs TIME_PERIOD="2026-01" OBS_VALUE="99"/></Series>
  </message:DataSet>
</message:StructureSpecificData>`
    const data = parseSdmxXml(xml)!
    expect(data.series).toHaveLength(2)
    expect(data.series[0]!.attributes).toEqual({ COUNTRY: 'USA', INDICATOR: 'PCPI_IX', FREQUENCY: 'M' })
    expect(data.series[0]!.observations).toEqual([{ TIME_PERIOD: '2026-01', OBS_VALUE: '101.5' }, { TIME_PERIOD: '2026-02', OBS_VALUE: '102' }])
    expect(data.series[1]!.observations).toHaveLength(1)
    expect(data.groups).toEqual({ PCPI_IX: { UNIT: 'IX' } })
    expect(parseSdmxXml('<root/>')).toBeUndefined()
  })
})
