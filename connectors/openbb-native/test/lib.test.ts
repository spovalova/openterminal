import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseCsv, parseCsvRecords } from '../src/lib/csv.js'
import { asArray, parseXml } from '../src/lib/xml.js'
import { excelSerialToIso, readXlsx } from '../src/lib/xlsx.js'

describe('csv', () => {
  it('reads quotes, doubled quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n1,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '']])
    expect(parseCsvRecords('Company Name, Stock Symbol\n"TESLA","TSLA"')).toEqual([{ 'Company Name': 'TESLA', 'Stock Symbol': 'TSLA' }])
  })
})

describe('xml', () => {
  it('keeps strings, attributes and drops namespace prefixes', () => {
    const doc = parseXml('<m:a xmlns:m="x"><m:b id="1">0.5</m:b></m:a>')
    expect(doc).toEqual({ a: { b: { '#text': '0.5', '@_id': '1' } } })
    expect(asArray(undefined)).toEqual([])
    expect(asArray(1)).toEqual([1])
  })
})

describe('xlsx', () => {
  it('reads shared strings, numbers, booleans and date-formatted cells', () => {
    const files = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>date</t></si><si><t>value</t></si><si><r><t>rich </t></r><r><t>text</t></r></si></sst>'),
      'xl/styles.xml': strToU8('<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>46296</v></c><c r="B2"><v>4.25</v></c><c r="D2" t="b"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>'),
    }
    const [sheet] = readXlsx(zipSync(files))
    expect(sheet?.name).toBe('Data')
    expect(sheet?.rows).toEqual([
      ['date', 'value'],
      ['2026-10-01', 4.25, null, true],
      ['rich text', 'inline'],
    ])
    expect(excelSerialToIso(46296.5)).toBe('2026-10-01T12:00:00')
  })
})
