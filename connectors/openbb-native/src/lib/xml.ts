// XML for the providers that read SDMX, RSS and government feeds: one parser configuration, strings left as
// strings (as lxml and xmltodict give them), attributes under `@_name`, namespace prefixes removed.
import { XMLParser, type X2jOptions } from 'fast-xml-parser'

export function parseXml(text: string, options: Partial<X2jOptions> = {}): Record<string, unknown> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true, ...options })
  return parser.parse(text) as Record<string, unknown>
}

/** A value that may be one item or a list (XML with one child) as a list. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]
}
