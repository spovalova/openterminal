// What `xmltodict.parse` gives (Python), on fast-xml-parser: attributes as "@name", an element with attributes and
// text as {"@a": …, "#text": …}, an empty element as null, repeated siblings as a list, namespace prefixes kept.
import { parseXml } from '../../lib/xml.js'

export type XmlValue = string | null | XmlValue[] | { [key: string]: XmlValue }
export type XmlDict = { [key: string]: XmlValue }

function normalise(v: unknown): XmlValue {
  if (v === '' || v === undefined) return null
  if (Array.isArray(v)) return v.map(normalise)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalise(x)]))
  return v as XmlValue
}

/** `xmltodict.parse(text)`: the document as nested dicts (the root element is the only key). */
export function xmlToDict(text: string): XmlDict {
  const parsed = parseXml(text, { attributeNamePrefix: '@', removeNSPrefix: false, textNodeName: '#text', ignoreDeclaration: true, ignorePiTags: true })
  return normalise(parsed) as XmlDict
}

export const isDict = (v: unknown): v is XmlDict => v !== null && typeof v === 'object' && !Array.isArray(v)
