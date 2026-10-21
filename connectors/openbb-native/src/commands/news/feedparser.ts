// feedparser.parse() for a feed's bytes: its encoding sniffing, the strict XML pass, and the loose pass it falls back to
// when the XML is not well-formed. Ported from feedparser/api.py, feedparser/encodings.py, feedparser/parsers/strict.py,
// feedparser/parsers/loose.py and feedparser/sanitizer.py (replace_doctype) (feedparser 6.0.14, BSD-2-Clause);
// modified: the document is a string once decoded, the XML reader is xmlsax.ts instead of expat, chardet's guess and
// HTTP headers (the router passes bytes only) are left out.
import { FeedParserDict } from './feeddict.js'
import { FeedState, MATCH_NAMESPACES, saxEscape } from './feedstate.js'
import { BaseHTMLProcessor } from './markup.js'
import { parseXml, XmlSyntaxError, type SaxAttribute, type SaxHandler } from './xmlsax.js'

export type ParsedFeed = { feed: FeedParserDict; entries: FeedParserDict[]; bozo: boolean }

// ---- encodings ----

const XML_DECLARATION = /^<\?xml[^>]*?>/
const XML_PI_ENCODING = /^<\?.*encoding=['"](.*?)['"].*\?>/

// Python's codec aliases (encodings.aliases) for the codecs the WHATWG decoder reads differently: it takes the labels
// `ascii` and `latin1` for windows-1252, where Python keeps ASCII strict and Latin-1 byte for byte.
const ASCII_NAMES = new Set(['ascii', '646', 'ansi_x3.4_1968', 'ansi_x3_4_1968', 'ansi_x3.4_1986', 'cp367', 'csascii', 'ibm367', 'iso646_us', 'iso_646.irv_1991', 'iso_ir_6', 'us', 'us_ascii'])
const LATIN1_NAMES = new Set(['latin_1', '8859', 'cp819', 'csisolatin1', 'ibm819', 'iso8859', 'iso8859_1', 'iso_8859_1', 'iso_8859_1_1987', 'iso_ir_100', 'l1', 'latin', 'latin1'])
const CP1252_NAMES = new Set(['cp1252', 'windows_1252', '1252'])

/** `data.decode(encoding)`: the text, or undefined where Python raises UnicodeDecodeError or LookupError. */
function tryDecode(bytes: Uint8Array, encoding: string): string | undefined {
  // encodings.normalize_encoding: runs of anything but letters, digits and dots become one underscore.
  const name = encoding.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '')
  if (ASCII_NAMES.has(name)) return bytes.some((b) => b >= 0x80) ? undefined : Array.from(bytes, (b) => String.fromCharCode(b)).join('')
  if (LATIN1_NAMES.has(name)) return Array.from(bytes, (b) => String.fromCharCode(b)).join('')
  // Python's windows-1252 refuses the five bytes it leaves undefined; the WHATWG decoder maps them to controls.
  if (CP1252_NAMES.has(name) && bytes.some((b) => b === 0x81 || b === 0x8d || b === 0x8f || b === 0x90 || b === 0x9d)) return undefined
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** `convert_to_utf8` with no HTTP headers: the text, and whether an encoding was found (the strict parser needs one). */
export function convertToUtf8(input: Uint8Array): { text: string; known: boolean; overridden: boolean } {
  let data = input
  let bomEncoding = ''
  const starts = (...bytes: number[]): boolean => bytes.every((b, k) => data[k] === b)
  if (starts(0x00, 0x00, 0xfe, 0xff)) [bomEncoding, data] = ['utf-32be', data.subarray(4)]
  else if (starts(0xff, 0xfe, 0x00, 0x00)) [bomEncoding, data] = ['utf-32le', data.subarray(4)]
  else if (starts(0xfe, 0xff) && !(data[2] === 0 && data[3] === 0)) [bomEncoding, data] = ['utf-16be', data.subarray(2)]
  else if (starts(0xff, 0xfe) && !(data[2] === 0 && data[3] === 0)) [bomEncoding, data] = ['utf-16le', data.subarray(2)]
  else if (starts(0xef, 0xbb, 0xbf)) [bomEncoding, data] = ['utf-8', data.subarray(3)]
  else if (starts(0x4c, 0x6f, 0xa7, 0x94)) bomEncoding = 'cp037'
  else if (starts(0x00, 0x3c, 0x00, 0x3f)) bomEncoding = 'utf-16be'
  else if (starts(0x3c, 0x00, 0x3f, 0x00)) bomEncoding = 'utf-16le'
  else if (starts(0x00, 0x00, 0x00, 0x3c)) bomEncoding = 'utf-32be'
  else if (starts(0x3c, 0x00, 0x00, 0x00)) bomEncoding = 'utf-32le'

  // The XML declaration's encoding, read from the document as UTF-8 (or its BOM encoding, when it has one).
  let xmlEncoding = ''
  const sniffed = bomEncoding ? tryDecode(data, bomEncoding) : new TextDecoder('utf-8').decode(data.subarray(0, 4096))
  const match = sniffed === undefined ? null : XML_PI_ENCODING.exec(sniffed)
  if (match) {
    xmlEncoding = match[1]!.toLowerCase()
    if (bomEncoding && ['u16', 'utf-16', 'utf16', 'utf_16', 'u32', 'utf-32', 'utf32', 'utf_32', 'iso-10646-ucs-2', 'iso-10646-ucs-4', 'csucs4', 'csunicode', 'ucs-2', 'ucs-4'].includes(xmlEncoding)) xmlEncoding = bomEncoding
  }

  // Without HTTP headers the encoding is the XML declaration's, else UTF-8.
  let rfc3023 = xmlEncoding || 'utf-8'
  if (rfc3023.toLowerCase() === 'gb2312') rfc3023 = 'gb18030'
  if (xmlEncoding.toLowerCase() === 'gb2312') xmlEncoding = 'gb18030'

  const tried = new Set<string>()
  for (const proposed of [rfc3023, xmlEncoding, bomEncoding, 'utf-8', 'windows-1252', 'iso-8859-2']) {
    if (!proposed || tried.has(proposed)) continue
    tried.add(proposed)
    const decoded = tryDecode(data, proposed)
    if (decoded === undefined) continue
    // Update the encoding in the opening XML declaration.
    const declaration = "<?xml version='1.0' encoding='utf-8'?>"
    return { text: XML_DECLARATION.test(decoded) ? decoded.replace(XML_DECLARATION, declaration) : `${declaration}\n${decoded}`, known: true, overridden: proposed !== rfc3023 }
  }
  return { text: new TextDecoder('utf-8').decode(data), known: false, overridden: false }
}

// ---- document type ----

const ENTITY_PATTERN = /^\s*<!ENTITY([^>]*?)>/gm
const DOCTYPE_PATTERN = /^\s*<!DOCTYPE([^>]*?)>/gm
const SAFE_ENTITY_PATTERN = /\s+(\w+)\s+"(&#\w+;|[^&"]*)"/y

/** `replace_doctype`: the document type replaced by one that holds only the entity declarations that are safe. */
export function replaceDoctype(input: string): { text: string; entities: Record<string, string> } {
  // Divide the document into two groups by finding the location of the first element that doesn't begin with '<?' or '<!'.
  const found = /<\w/.exec(input)
  const start = found && found.index ? found.index : -1
  let head = input.slice(0, start + 1)
  const body = input.slice(start + 1)

  // Save and then remove all of the ENTITY declarations.
  const entityResults = [...head.matchAll(ENTITY_PATTERN)].map((m) => m[1]!)
  head = head.replace(ENTITY_PATTERN, '')

  // Re-insert the safe ENTITY declarations if a DOCTYPE was found.
  const doctypes = [...head.matchAll(DOCTYPE_PATTERN)]
  let replacement = ''
  if (doctypes.length === 1 && entityResults.length > 0) {
    const safe = entityResults.filter((e) => {
      SAFE_ENTITY_PATTERN.lastIndex = 0
      return SAFE_ENTITY_PATTERN.test(e)
    })
    if (safe.length > 0) replacement = `<!DOCTYPE feed [\n<!ENTITY${safe.join('>\n<!ENTITY ')}>\n]>`
  }
  const entities: Record<string, string> = {}
  for (const m of replacement.matchAll(/\s+(\w+)\s+"(&#\w+;|[^&"]*)"/g)) entities[m[1]!] = m[2]!
  return { text: head.replace(DOCTYPE_PATTERN, () => replacement) + body, entities }
}

// ---- the strict pass ----

const XLINK = 'http://www.w3.org/1999/xlink'

class StrictDriver implements SaxHandler {
  private decls: Record<string, string> = {}

  constructor(private readonly state: FeedState) {}

  startPrefixMapping(prefix: string | null, uri: string): void {
    if (!uri) return
    this.state.trackNamespace(prefix || null, uri)
    if (prefix && uri === XLINK) this.decls[`xmlns:${prefix}`] = uri
  }

  startElementNS(namespace: string | null, local: string, attrs: SaxAttribute[]): void {
    let ns = namespace ?? ''
    let lowerNamespace = ns.toLowerCase()
    if (lowerNamespace.includes('backend.userland.com/rss')) {
      // Match any backend.userland.com namespace.
      ns = 'http://backend.userland.com/rss'
      lowerNamespace = ns
    }
    // expat reports no qualified name, so a namespace's prefix is its standard one; an unknown namespace has none here.
    const prefix = MATCH_NAMESPACES.get(lowerNamespace) ?? null
    let localname = local.toLowerCase()

    const attrsD = new Map<string, string>(Object.entries(this.decls))
    this.decls = {}
    if (localname === 'math' && ns === 'http://www.w3.org/1998/Math/MathML') attrsD.set('xmlns', ns)
    if (localname === 'svg' && ns === 'http://www.w3.org/2000/svg') attrsD.set('xmlns', ns)

    if (prefix) localname = `${prefix.toLowerCase()}:${localname}`
    else if (ns) {
      for (const [name, value] of Object.entries(this.state.namespacesInUse)) {
        if (name && value === ns) {
          localname = `${name}:${localname}`
          break
        }
      }
    }

    for (const a of attrs) {
      const attrPrefix = MATCH_NAMESPACES.get((a.namespace ?? '').toLowerCase()) ?? ''
      attrsD.set((attrPrefix ? `${attrPrefix}:${a.local}` : a.local).toLowerCase(), a.value)
    }
    // `getQNames()`: the names as the document writes them, so a namespaced attribute is also there under its own prefix.
    for (const a of attrs) attrsD.set(a.qname.toLowerCase(), a.value)
    this.state.unknownStarttag(localname.toLowerCase(), [...attrsD])
  }

  characters(text: string): void {
    this.state.handleData(text)
  }

  endElementNS(namespace: string | null, local: string): void {
    const ns = namespace ?? ''
    const prefix = MATCH_NAMESPACES.get(ns.toLowerCase()) ?? ''
    let localname = local
    if (prefix) localname = `${prefix}:${localname}`
    else if (ns) {
      for (const [name, value] of Object.entries(this.state.namespacesInUse)) {
        if (name && value === ns) {
          localname = `${name}:${localname}`
          break
        }
      }
    }
    this.state.unknownEndtag(localname.toLowerCase())
  }
}

// ---- the loose pass ----

class LooseDriver extends BaseHTMLProcessor {
  constructor(private readonly state: FeedState) {
    super('utf-8')
  }

  protected override unknownStarttag(tag: string, attrs: [string, string][]): void {
    this.state.unknownStarttag(tag, attrs)
  }

  protected override unknownEndtag(tag: string): void {
    this.state.unknownEndtag(tag)
  }

  protected override handleData(text: string): void {
    this.state.handleData(text)
  }

  protected override handleCharref(ref: string): void {
    this.state.handleCharref(ref)
  }

  protected override handleEntityref(ref: string): void {
    this.state.handleEntityref(ref)
  }

  protected override handleComment(): void {}
  protected override handlePi(): void {}
  protected override handleDecl(): void {}

  // Override the declaration handler to handle CDATA blocks.
  protected override parseDeclaration(i: number): number {
    if (this.rawdata.slice(i, i + 9) === '<![CDATA[') {
      let k = this.rawdata.indexOf(']]>', i)
      if (k === -1) {
        // The CDATA block began but didn't finish.
        k = this.rawdata.length
        return k
      }
      this.state.handleData(saxEscape(this.rawdata.slice(i + 9, k)), false)
      return k + 3
    }
    const k = this.rawdata.indexOf('>', i)
    // An incomplete block gives -1.
    return k >= 0 ? k + 1 : k
  }
}

/** `feedparser.parse(data)` for a feed's bytes: its feed-level data, its entries, and whether the XML was malformed. */
export function parseFeed(data: Uint8Array, now: Date): ParsedFeed {
  if (data.length === 0) return { feed: new FeedParserDict(), entries: [], bozo: false }
  const { text: decoded, known, overridden } = convertToUtf8(data)
  const { text, entities } = replaceDoctype(decoded)
  // A document that was not read in the encoding it declared is flagged, though its XML may be fine.
  let bozo = overridden
  if (known) {
    const state = new FeedState('', null, now)
    try {
      parseXml(text, new StrictDriver(state), entities)
      return { feed: state.feeddata, entries: state.entries, bozo }
    } catch (error) {
      if (!(error instanceof XmlSyntaxError)) throw error
      bozo = true
    }
  }
  const state = new FeedState('', null, now, true, entities)
  new LooseDriver(state).feed(text)
  return { feed: state.feeddata, entries: state.entries, bozo: bozo || !known }
}

