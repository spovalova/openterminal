import { describe, expect, it } from 'vitest'
import { parseElementTree, tostring, XmlParseError } from '../src/sec/taxonomy/xml-element.js'
import { getLabelUrlForImport, TaxonomyStyle, XBRLParser } from '../src/sec/taxonomy/xbrl-parser.js'

const LINK = 'http://www.xbrl.org/2003/linkbase'
const XLINK = 'http://www.w3.org/1999/xlink'

describe('xml-element (ElementTree semantics)', () => {
  it('resolves namespaces, keeps text and tails, drops comments', () => {
    const root = parseElementTree('<?xml version="1.0"?><a xmlns="urn:d" xmlns:x="urn:x" x:k="v" p="1\t2">t1<!-- c -->t2<x:b>in</x:b>tail<c/></a>')
    expect(root.tag).toBe('{urn:d}a')
    expect(root.attrib).toEqual({ '{urn:x}k': 'v', p: '1 2' })
    expect(root.text).toBe('t1t2')
    expect(root.children.map((c) => c.tag)).toEqual(['{urn:x}b', '{urn:d}c'])
    expect(root.children[0]!.tail).toBe('tail')
    expect(root.find('.//{urn:x}b')?.text).toBe('in')
    expect(root.findall('{urn:d}c')).toHaveLength(1)
    expect(root.itertext().join('')).toBe('t1t2intail')
  })

  it('decodes entities and CDATA, and refuses undefined entities, mismatches and entity declarations', () => {
    expect(parseElementTree('<a>&lt;&#65;&#x42;<![CDATA[<&>]]></a>').text).toBe('<AB<&>')
    expect(() => parseElementTree('<a>&nbsp;</a>')).toThrow(XmlParseError)
    expect(() => parseElementTree('<a><b></a>')).toThrow(XmlParseError)
    expect(() => parseElementTree('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlParseError)
    expect(() => parseElementTree('<a/><b/>')).toThrow(XmlParseError)
  })

  it('supports prefix maps, predicates and tostring round trips', () => {
    const root = parseElementTree(`<l:linkbase xmlns:l="${LINK}"><l:loc id="1"/><l:loc id="2"/></l:linkbase>`)
    expect(root.findall('.//l:loc', { l: LINK })).toHaveLength(2)
    expect(root.findall(`{${LINK}}loc[@id='2']`)).toHaveLength(1)
    expect(root.findall(`{${LINK}}loc[2]`)[0]!.attrib.id).toBe('2')
    const again = parseElementTree(tostring(root))
    expect(again.findall(`.//{${LINK}}loc`)).toHaveLength(2)
  })
})

describe('XBRLParser', () => {
  it('reads labels (English only), presentation trees and calculation arcs', () => {
    const labels = `<link:linkbase xmlns:link="${LINK}" xmlns:xlink="${XLINK}">
      <link:labelLink>
        <link:loc xlink:href="x.xsd#us-gaap_Assets" xlink:label="loc_a"/>
        <link:label xlink:label="lab_a" xlink:role="http://www.xbrl.org/2003/role/label" xml:lang="en-US">Assets</link:label>
        <link:label xlink:label="lab_a" xlink:role="http://www.xbrl.org/2003/role/documentation" xml:lang="en-US">Sum of assets.</link:label>
        <link:label xlink:label="lab_a" xlink:role="http://www.xbrl.org/2003/role/terseLabel" xml:lang="cy">Asedau</link:label>
        <link:labelArc xlink:from="loc_a" xlink:to="lab_a"/>
      </link:labelLink></link:linkbase>`
    const parser = new XBRLParser()
    const parsed = parser.parseLabelLinkbase(Buffer.from(labels), TaxonomyStyle.FASB_STANDARD)
    expect(parsed).toEqual({ 'us-gaap_Assets': { label: 'Assets', documentation: 'Sum of assets.' } })
    expect(parser.labels['us-gaap_Assets']).toBe('Assets')
    expect(parser.documentation['us-gaap_Assets']).toBe('Sum of assets.')

    const pre = `<link:linkbase xmlns:link="${LINK}" xmlns:xlink="${XLINK}"><link:presentationLink>
      <link:loc xlink:href="x.xsd#P" xlink:label="p"/><link:loc xlink:href="x.xsd#A" xlink:label="a"/><link:loc xlink:href="x.xsd#B" xlink:label="b"/>
      <link:presentationArc xlink:from="p" xlink:to="b" order="2"/><link:presentationArc xlink:from="p" xlink:to="a" order="1" preferredLabel="urn:r/terse"/>
      </link:presentationLink></link:linkbase>`
    const tree = parser.parsePresentation(Buffer.from(pre), TaxonomyStyle.FASB_STANDARD)
    expect(tree.map((n) => [n.element_id, n.level, n.children.map((c) => [c.element_id, c.order, c.preferred_label])])).toEqual([['P', 0, [['A', 1, 'urn:r/terse'], ['B', 2, null]]]])

    const calc = `<link:linkbase xmlns:link="${LINK}" xmlns:xlink="${XLINK}"><link:calculationLink>
      <link:loc xlink:href="x.xsd#T" xlink:label="t"/><link:loc xlink:href="x.xsd#C" xlink:label="c"/>
      <link:calculationArc xlink:from="t" xlink:to="c" order="3" weight="-1"/></link:calculationLink></link:linkbase>`
    expect(parser.parseCalculation(Buffer.from(calc), TaxonomyStyle.FASB_STANDARD)).toEqual({ C: { order: 3, weight: -1, parent_tag: 'T' } })
  })

  it('reads instance contexts, units and facts', async () => {
    const xml = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2024" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
      <xbrli:context id="c1"><xbrli:entity><xbrli:identifier scheme="s"> 0000320193 </xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementAxis">us-gaap:Foo</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2024-09-28</xbrli:instant></xbrli:period></xbrli:context>
      <xbrli:unit id="u1"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
      <us-gaap:Assets contextRef="c1" unitRef="u1" decimals="-6" id="f1">123</us-gaap:Assets></xbrli:xbrl>`
    const [contexts, units, facts] = await new XBRLParser().parseInstance(Buffer.from(xml))
    expect(contexts.c1).toEqual({ entity: '0000320193', period_type: 'instant', start: null, end: '2024-09-28', dimensions: { 'us-gaap:StatementAxis': 'us-gaap:Foo' } })
    expect(units).toEqual({ u1: 'iso4217:USD' })
    expect(facts['us-gaap_Assets']).toEqual([
      { tag: 'us-gaap_Assets', label: 'us-gaap_Assets', documentation: undefined, context_ref: 'c1', fact_id: 'f1', entity: '0000320193', period_type: 'instant', start: null, end: '2024-09-28', unit: 'iso4217:USD', decimals: '-6', value: '123', dimensions: { 'us-gaap:StatementAxis': { member: 'us-gaap:Foo', label: 'us-gaap:Foo' } } },
    ])
  })

  it('finds the label linkbase of an imported taxonomy schema', () => {
    expect(getLabelUrlForImport('https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd')).toBe('https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-lab-2025.xml')
    expect(getLabelUrlForImport('https://xbrl.sec.gov/dei/2025/dei-2025.xsd')).toBe('https://xbrl.sec.gov/dei/2025/dei-2025_lab.xsd')
    expect(getLabelUrlForImport('https://example.com/x.xsd')).toBeNull()
  })
})
