// The state machine feedparser reads a feed with: elements start and end, text arrives, and the entries fill up. Ported
// from feedparser/mixin.py and feedparser/namespaces/ (_base.py, dc.py, itunes.py, mediarss.py, cc.py, admin.py, georss.py,
// psc.py; feedparser 6.0.14, BSD-2-Clause); modified: handlers are entries in two tables instead of methods found by
// name, and the namespaces keep the stack effects of their elements but not the values nothing here reads (GeoRSS
// geometry, podcast chapters, iTunes flags).
import { strip } from '../../sec/markdown/py.js'
import { FeedParserDict } from './feeddict.js'
import { resolveRelativeUris, sanitizeHtml, translateCp1252 } from './markup.js'
import { parseDate } from './pydates.js'
import { feedUrljoin, makeSafeAbsoluteUri } from './pyurl.js'
import tables from './sanitizer.json' with { type: 'json' }

export type Attrs = Map<string, string>

const NAMESPACES: Record<string, string> = {
  '': '',
  'http://backend.userland.com/rss': '',
  'http://blogs.law.harvard.edu/tech/rss': '',
  'http://purl.org/rss/1.0/': '',
  'http://my.netscape.com/rdf/simple/0.9/': '',
  'http://example.com/newformat#': '',
  'http://example.com/necho': '',
  'http://purl.org/echo/': '',
  'uri/of/echo/namespace#': '',
  'http://purl.org/pie/': '',
  'http://purl.org/atom/ns#': '',
  'http://www.w3.org/2005/Atom': '',
  'http://purl.org/rss/1.0/modules/rss091#': '',
  'http://webns.net/mvcb/': 'admin',
  'http://purl.org/rss/1.0/modules/aggregation/': 'ag',
  'http://purl.org/rss/1.0/modules/annotate/': 'annotate',
  'http://media.tangent.org/rss/1.0/': 'audio',
  'http://backend.userland.com/blogChannelModule': 'blogChannel',
  'http://creativecommons.org/ns#license': 'cc',
  'http://web.resource.org/cc/': 'cc',
  'http://cyber.law.harvard.edu/rss/creativeCommonsRssModule.html': 'creativeCommons',
  'http://backend.userland.com/creativeCommonsRssModule': 'creativeCommons',
  'http://purl.org/rss/1.0/modules/company': 'co',
  'http://purl.org/rss/1.0/modules/content/': 'content',
  'http://my.theinfo.org/changed/1.0/rss/': 'cp',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'http://purl.org/rss/1.0/modules/email/': 'email',
  'http://purl.org/rss/1.0/modules/event/': 'ev',
  'http://rssnamespace.org/feedburner/ext/1.0': 'feedburner',
  'http://freshmeat.net/rss/fm/': 'fm',
  'http://xmlns.com/foaf/0.1/': 'foaf',
  'http://www.w3.org/2003/01/geo/wgs84_pos#': 'geo',
  'http://www.georss.org/georss': 'georss',
  'http://www.opengis.net/gml': 'gml',
  'http://postneo.com/icbm/': 'icbm',
  'http://purl.org/rss/1.0/modules/image/': 'image',
  'http://www.itunes.com/DTDs/PodCast-1.0.dtd': 'itunes',
  'http://example.com/DTDs/PodCast-1.0.dtd': 'itunes',
  'http://purl.org/rss/1.0/modules/link/': 'l',
  'http://search.yahoo.com/mrss': 'media',
  'http://search.yahoo.com/mrss/': 'media',
  'http://madskills.com/public/xml/rss/module/pingback/': 'pingback',
  'http://prismstandard.org/namespaces/1.2/basic/': 'prism',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
  'http://www.w3.org/2000/01/rdf-schema#': 'rdfs',
  'http://purl.org/rss/1.0/modules/reference/': 'ref',
  'http://purl.org/rss/1.0/modules/richequiv/': 'reqv',
  'http://purl.org/rss/1.0/modules/search/': 'search',
  'http://purl.org/rss/1.0/modules/slash/': 'slash',
  'http://schemas.xmlsoap.org/soap/envelope/': 'soap',
  'http://purl.org/rss/1.0/modules/servicestatus/': 'ss',
  'http://hacks.benhammersley.com/rss/streaming/': 'str',
  'http://purl.org/rss/1.0/modules/subscription/': 'sub',
  'http://purl.org/rss/1.0/modules/syndication/': 'sy',
  'http://schemas.pocketsoap.com/rss/myDescModule/': 'szf',
  'http://purl.org/rss/1.0/modules/taxonomy/': 'taxo',
  'http://purl.org/rss/1.0/modules/threading/': 'thr',
  'http://purl.org/rss/1.0/modules/textinput/': 'ti',
  'http://madskills.com/public/xml/rss/module/trackback/': 'trackback',
  'http://wellformedweb.org/commentAPI/': 'wfw',
  'http://purl.org/rss/1.0/modules/wiki/': 'wiki',
  'http://www.w3.org/1999/xhtml': 'xhtml',
  'http://www.w3.org/1999/xlink': 'xlink',
  'http://www.w3.org/XML/1998/namespace': 'xml',
  'http://podlove.org/simple-chapters': 'psc',
}

/** The known namespaces by lower-cased URI (`_matchnamespaces`). */
export const MATCH_NAMESPACES: Map<string, string> = new Map(Object.entries(NAMESPACES).map(([k, v]) => [k.toLowerCase(), v]))

const CAN_BE_RELATIVE_URI = new Set(['comments', 'docs', 'href', 'icon', 'id', 'link', 'logo', 'url', 'wfw_comment', 'wfw_commentrss'])
const CAN_CONTAIN_RELATIVE_URIS = new Set(['content', 'copyright', 'description', 'info', 'rights', 'subtitle', 'summary', 'tagline', 'title'])
const CAN_CONTAIN_DANGEROUS_MARKUP = new Set(['content', 'copyright', 'description', 'info', 'rights', 'subtitle', 'summary', 'tagline', 'title'])
const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html'])
const ACCEPTABLE_ELEMENTS = new Set(tables.elements)
const ENTITYDEFS = new Set(tables.entitydefs)
const NAME2CODEPOINT = new Map(Object.entries(tables.name2codepoint))

/**
 * `base64.decodebytes(text.encode())` as `binascii.a2b_base64` reads it: characters outside the alphabet are skipped,
 * a padding sign ends the data once a quad is half done, and a length that leaves a quad incomplete is an error
 * (undefined here).
 */
function pyBase64Decode(text: string): Uint8Array | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const out: number[] = []
  let quad = 0
  let left = 0
  let pads = 0
  for (const ch of new TextEncoder().encode(text)) {
    if (ch === 0x3d) {
      pads += 1
      if (quad >= 2 && quad + pads >= 4) return Uint8Array.from(out)
      continue
    }
    const value = ch < 0x80 ? alphabet.indexOf(String.fromCharCode(ch)) : -1
    if (value < 0) continue
    pads = 0
    if (quad === 0) [quad, left] = [1, value]
    else if (quad === 1) {
      out.push(((left << 2) | (value >> 4)) & 0xff)
      ;[quad, left] = [2, value & 0x0f]
    } else if (quad === 2) {
      out.push(((left << 4) | (value >> 2)) & 0xff)
      ;[quad, left] = [3, value & 0x03]
    } else {
      out.push(((left << 6) | value) & 0xff)
      ;[quad, left] = [0, 0]
    }
  }
  return quad === 0 ? Uint8Array.from(out) : undefined
}

/** Python's AttributeError, which `unknown_starttag` and `unknown_endtag` read as "no handler for this element". */
class PyAttributeError extends Error {}

/** A value Python goes on to call a method of: None has none, and that is an AttributeError. */
function noneIsError<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new PyAttributeError('NoneType has no such attribute')
  return value
}

type Piece = string
type Frame =[element: string, expectingText: number | boolean, pieces: Piece[]]

/** `xml.sax.saxutils.escape`. */
export const saxEscape = (text: string, quote = false): string => {
  const out = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return quote ? out.replaceAll('"', '&quot;') : out
}

/** Is every character Latin-1, and is at least one of them above ASCII? (The text could be UTF-8 bytes read as ISO-8859-1.) */
function isLatin1WithHighBytes(text: string): boolean {
  let high = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0xff) return false
    if (code >= 0x80) high = true
  }
  return high
}

/** Python's `chr(n).encode('utf-8')` decoded again, i.e. the character, or undefined where Python raises. */
function chrOf(n: number): string | undefined {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : undefined
}

export class FeedState {
  feeddata = new FeedParserDict()
  entries: FeedParserDict[] = []
  version = ''
  namespacesInUse: Record<string, string> = {}

  infeed = 0
  inentry = 0
  incontent = 0
  intextinput = 0
  inimage = 0
  inauthor = 0
  incontributor = 0
  inpublisher = 0
  insource = 0
  ingeometry: number | string = 0
  psc = false

  sourcedata = new FeedParserDict()
  contentparams = new FeedParserDict()
  summaryKey: string | null = null
  namespacemap = new Map<string | null, string>()
  elementstack: Frame[] = []
  basestack: string[] = []
  langstack: (string | null)[] = []
  svgOK = 0
  titleDepth = -1
  depth = 0
  hasContent = 0
  guidislink = false
  baseuri: string
  lang: string | null
  encoding = 'utf-8'
  resolveRelativeUris = true
  sanitizeHtml = true
  /** Whether the loose parser feeds this: it escapes and unescapes differently. */
  loose: boolean
  entities: Record<string, string>
  private readonly propertyDepth = new Map<FeedParserDict, Record<string, number>>()
  private readonly start: Record<string, (attrs: Attrs) => void> = {}
  private readonly end: Record<string, () => void> = {}

  constructor(
    baseuri: string,
    baselang: string | null,
    private readonly now: Date,
    loose = false,
    entities: Record<string, string> = {},
  ) {
    this.baseuri = baseuri || ''
    this.lang = baselang
    this.loose = loose
    this.entities = entities
    if (this.lang) this.feeddata.set('language', this.lang.replaceAll('_', '-'))
    this.register()
  }

  // ---- the events ----

  /** `unknown_starttag`. `tag` is the lower-cased name, prefixed with the standard prefix of its namespace. */
  unknownStarttag(tag: string, attrList: [string, string][]): void {
    this.depth += 1
    // Normalise the attributes: names lower-cased, `rel` and `type` values lower-cased; the loose parser also unescapes `&amp;`.
    attrList = attrList.map(([name, value]): [string, string] => {
      const key = name.toLowerCase()
      let v = (key === 'rel' || key === 'type') && value.toLowerCase() ? value.toLowerCase() : value
      if (this.loose) v = v.replaceAll('&amp;', '&')
      return [key, v]
    })
    const attrsD: Attrs = new Map(attrList)
    // Track xml:base and xml:lang.
    let baseuri = attrsD.get('xml:base') ?? attrsD.get('base') ?? this.baseuri
    if (!baseuri) baseuri = this.baseuri
    // Ensure that baseuri is always an absolute URI that uses a whitelisted scheme (not `javascript:`).
    if (this.baseuri) this.baseuri = makeSafeAbsoluteUri(this.baseuri, baseuri) || this.baseuri
    else this.baseuri = feedUrljoin(this.baseuri, baseuri)
    let lang: string | null = attrsD.get('xml:lang') ?? attrsD.get('lang') ?? null
    if (lang === '') lang = null
    else if (lang === null) lang = this.lang
    if (lang && ['feed', 'rss', 'rdf:RDF'].includes(tag)) this.feeddata.set('language', lang.replaceAll('_', '-'))
    this.lang = lang
    this.basestack.push(this.baseuri)
    this.langstack.push(lang)

    for (const [name, uri] of attrList) {
      if (name.startsWith('xmlns:')) this.trackNamespace(name.slice(6), uri)
      else if (name === 'xmlns') this.trackNamespace(null, uri)
    }

    // Track inline content.
    if (this.incontent && !(this.contentparams.get('type') ?? 'xml').endsWith('xml')) {
      if (tag === 'xhtml:div' || tag === 'div') return // typepad does this 10/2007
      // Element declared itself as escaped markup, but it isn't really.
      this.contentparams.set('type', 'application/xhtml+xml')
    }
    if (this.incontent && this.contentparams.get('type') === 'application/xhtml+xml') {
      let name = tag
      if (name.includes(':')) {
        const at = name.indexOf(':')
        const prefix = name.slice(0, at)
        name = name.slice(at + 1)
        const namespace = this.namespacesInUse[prefix] ?? ''
        if (name === 'math' && namespace === 'http://www.w3.org/1998/Math/MathML') attrList.push(['xmlns', namespace])
        if (name === 'svg' && namespace === 'http://www.w3.org/2000/svg') attrList.push(['xmlns', namespace])
      }
      if (name === 'svg') this.svgOK += 1
      this.handleData(`<${name}${this.strattrs(attrList)}>`, false)
      return
    }

    // Match namespaces.
    let prefix: string
    let suffix: string
    if (tag.includes(':')) [prefix, suffix] = [tag.slice(0, tag.indexOf(':')), tag.slice(tag.indexOf(':') + 1)]
    else [prefix, suffix] = ['', tag]
    prefix = this.namespacemap.get(prefix) ?? prefix
    if (prefix) prefix += '_'

    // Special hack for better tracking of empty textinput/image elements in ill-formed feeds.
    if (!prefix && !['title', 'link', 'description', 'name'].includes(tag)) this.intextinput = 0
    if (!prefix && !['title', 'link', 'description', 'url', 'href', 'width', 'height'].includes(tag)) this.inimage = 0

    // Call the special handler, or the default one.
    const method = this.start[prefix + suffix]
    if (method) {
      try {
        method(attrsD)
        return
      } catch (error) {
        // Python takes an AttributeError from inside a handler for "no handler", and adds the element as unknown.
        if (!(error instanceof PyAttributeError)) throw error
      }
    }
    // There is no handler: add the element and its attributes explicitly.
    const unknownTag = prefix + suffix
    if (attrsD.size === 0) this.push(unknownTag, 1)
    else this.getContext().set(unknownTag, attrsD)
  }

  /** `unknown_endtag`. */
  unknownEndtag(tag: string): void {
    let prefix: string
    let suffix: string
    if (tag.includes(':')) [prefix, suffix] = [tag.slice(0, tag.indexOf(':')), tag.slice(tag.indexOf(':') + 1)]
    else [prefix, suffix] = ['', tag]
    prefix = this.namespacemap.get(prefix) ?? prefix
    if (prefix) prefix += '_'
    if (suffix === 'svg' && this.svgOK) this.svgOK -= 1

    const method = this.svgOK ? undefined : this.end[prefix + suffix]
    if (method) {
      try {
        method()
      } catch (error) {
        // An AttributeError from inside the handler falls back to the default, as it does in Python.
        if (!(error instanceof PyAttributeError)) throw error
        this.pop(prefix + suffix)
      }
    } else this.pop(prefix + suffix)

    // Track inline content.
    if (this.incontent && !(this.contentparams.get('type') ?? 'xml').endsWith('xml')) {
      // Element declared itself as escaped markup, but it isn't really.
      if (tag === 'xhtml:div' || tag === 'div') return // typepad does this 10/2007
      this.contentparams.set('type', 'application/xhtml+xml')
    }
    if (this.incontent && this.contentparams.get('type') === 'application/xhtml+xml') {
      const name = tag.split(':').at(-1)!
      this.handleData(`</${name}>`, false)
    }

    // Track xml:base and xml:lang going out of scope.
    if (this.basestack.length > 0) {
      this.basestack.pop()
      if (this.basestack.length > 0 && this.basestack.at(-1)) this.baseuri = this.basestack.at(-1)!
    }
    if (this.langstack.length > 0) {
      this.langstack.pop()
      if (this.langstack.length > 0) this.lang = this.langstack.at(-1) ?? null
    }
    this.depth -= 1
  }

  /** `handle_charref` (loose parsing): `ref` is `160` or `xA0`. */
  handleCharref(ref: string): void {
    if (this.elementstack.length === 0) return
    ref = ref.toLowerCase()
    let text: string
    if (['34', '38', '39', '60', '62', 'x22', 'x26', 'x27', 'x3c', 'x3e'].includes(ref)) text = `&#${ref};`
    else {
      const c = ref[0] === 'x' ? parseInt(ref.slice(1), 16) : parseInt(ref, 10)
      const ch = chrOf(c)
      if (ch === undefined) throw new Error(`chr() arg not in range: ${ref}`)
      text = ch
    }
    this.elementstack.at(-1)![2].push(text)
  }

  /** `handle_entityref` (loose parsing). */
  handleEntityref(ref: string): void {
    if (this.elementstack.length === 0) return
    let text: string
    if (['lt', 'gt', 'quot', 'amp', 'apos'].includes(ref)) text = `&${ref};`
    else if (Object.hasOwn(this.entities, ref)) {
      text = this.entities[ref]!
      if (text.startsWith('&#') && text.endsWith(';')) {
        this.handleEntityref(text)
        return
      }
    } else if (NAME2CODEPOINT.has(ref)) text = String.fromCodePoint(NAME2CODEPOINT.get(ref)!)
    else text = `&${ref};`
    this.elementstack.at(-1)![2].push(text)
  }

  /** `handle_data`: text arrives; XHTML content is escaped unless the caller says it already is. */
  handleData(text: string, escape = true): void {
    if (this.elementstack.length === 0) return
    if (escape && this.contentparams.get('type') === 'application/xhtml+xml') text = saxEscape(text)
    this.elementstack.at(-1)![2].push(text)
  }

  // ---- helpers ----

  static mapContentType(contentType: string): string {
    const lower = contentType.toLowerCase()
    if (lower === 'text' || lower === 'plain') return 'text/plain'
    if (lower === 'html') return 'text/html'
    if (lower === 'xhtml') return 'application/xhtml+xml'
    return lower
  }

  trackNamespace(prefix: string | null, uri: string): void {
    let lower = uri.toLowerCase()
    if (!this.version) {
      if (prefix === null && lower === 'http://my.netscape.com/rdf/simple/0.9/') this.version = 'rss090'
      else if (lower === 'http://purl.org/rss/1.0/') this.version = 'rss10'
      else if (lower === 'http://www.w3.org/2005/atom') this.version = 'atom10'
    }
    if (lower.includes('backend.userland.com/rss')) {
      // Match any backend.userland.com namespace.
      uri = 'http://backend.userland.com/rss'
      lower = uri
    }
    const known = MATCH_NAMESPACES.get(lower)
    if (known !== undefined) {
      this.namespacemap.set(prefix, known)
      this.namespacesInUse[known] = uri
    } else this.namespacesInUse[prefix ?? ''] = uri
  }

  resolveUri(uri: string): string {
    return feedUrljoin(this.baseuri || '', uri)
  }

  /** The attributes of a start tag written back out; the loose parser's quoting differs. */
  strattrs(attrs: readonly (readonly [string, string])[]): string {
    return attrs.map(([k, v]) => ` ${k}="${this.loose ? v.replaceAll('"', '&quot;') : saxEscape(v, true)}"`).join('')
  }

  /** The loose parser's `decode_entities`: entities within embedded markup. */
  private decodeEntities(data: string): string {
    if (!this.loose) return data
    data = data.replaceAll('&#60;', '&lt;').replaceAll('&#x3c;', '&lt;').replaceAll('&#x3C;', '&lt;')
    data = data.replaceAll('&#62;', '&gt;').replaceAll('&#x3e;', '&gt;').replaceAll('&#x3E;', '&gt;')
    data = data.replaceAll('&#38;', '&amp;').replaceAll('&#x26;', '&amp;')
    data = data.replaceAll('&#34;', '&quot;').replaceAll('&#x22;', '&quot;')
    data = data.replaceAll('&#39;', '&apos;').replaceAll('&#x27;', '&apos;')
    if (!(this.contentparams.get('type') ?? 'xml').endsWith('xml')) {
      data = data.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
      data = data.replaceAll('&#x2f;', '/').replaceAll('&#x2F;', '/')
    }
    return data
  }

  push(element: string, expectingText: number | boolean): void {
    this.elementstack.push([element, expectingText, []])
  }

  pop(element: string, stripWhitespace = true): string | undefined {
    if (this.elementstack.length === 0) return undefined
    if (this.elementstack.at(-1)![0] !== element) return undefined

    const [, expectingText, pieces] = this.elementstack.pop()!

    if (this.version === 'atom10' && (this.contentparams.get('type') ?? 'text') === 'application/xhtml+xml') {
      // Remove the enclosing child element, but only if it is a <div> and only if all the remaining content is nested
      // underneath it. The divs would be retained in `<div>foo</div><div>bar</div>`.
      while (pieces.length > 1 && !strip(pieces.at(-1)!)) pieces.pop()
      while (pieces.length > 1 && !strip(pieces[0]!)) pieces.shift()
      if (pieces.length > 0 && (pieces[0] === '<div>' || pieces[0]!.startsWith('<div ')) && pieces.at(-1) === '</div>') {
        let depth = 0
        let nested = true
        for (const piece of pieces.slice(0, -1)) {
          if (piece.startsWith('</')) {
            depth -= 1
            if (depth === 0) {
              nested = false
              break
            }
          } else if (piece.startsWith('<') && !piece.endsWith('/>')) depth += 1
        }
        if (nested) pieces.splice(0, pieces.length, ...pieces.slice(1, -1))
      }
    }

    let output = pieces.join('')
    if (stripWhitespace) output = strip(output)
    if (!expectingText) return output

    // Decode base64 content.
    if (this.contentparams.get('base64')) {
      const decoded = pyBase64Decode(output)
      if (decoded) {
        try {
          output = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
        } catch {
          // Not UTF-8: leave it as it is.
        }
      }
    }

    // Resolve relative URIs.
    if (CAN_BE_RELATIVE_URI.has(element) && output) {
      // Do not resolve guid elements with isPermalink="false".
      if (element !== 'id' || this.guidislink) output = this.resolveUri(output)
    }

    // Decode entities within embedded markup.
    if (!this.contentparams.get('base64')) output = this.decodeEntities(output)

    // Some feed formats require consumers to guess whether the content is HTML or plain text.
    if (!this.version.startsWith('atom') && this.contentparams.get('type') === 'text/plain' && this.looksLikeHtml(output)) this.contentparams.set('type', 'text/html')

    // Remove temporary cruft from contentparams.
    this.contentparams.delete('mode')
    this.contentparams.delete('base64')

    const isHtmlish = HTML_TYPES.has(FeedState.mapContentType(this.contentparams.get('type') ?? 'text/html'))
    // Resolve relative URIs within embedded markup.
    if (isHtmlish && this.resolveRelativeUris && CAN_CONTAIN_RELATIVE_URIS.has(element)) output = resolveRelativeUris(output, this.baseuri, this.encoding, this.contentparams.get('type') ?? 'text/html')

    // Sanitize embedded markup.
    if (isHtmlish && this.sanitizeHtml && CAN_CONTAIN_DANGEROUS_MARKUP.has(element)) output = sanitizeHtml(output, this.encoding, this.contentparams.get('type') ?? 'text/html')

    // Address the common error where people take data that is already UTF-8, presume that it is ISO-8859-1, and re-encode it.
    if (this.encoding === 'utf-8' && isLatin1WithHighBytes(output)) {
      try {
        output = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(output, (c) => c.charCodeAt(0)))
      } catch {
        // Not UTF-8 after all.
      }
    }

    // Map the Windows-1252 extensions to the proper code points.
    output = translateCp1252(output)

    // Categories, tags and keywords are handled in _end_category, _end_tags and _end_itunes_keywords.
    if (['category', 'tags', 'itunes_keywords'].includes(element)) return output

    if (element === 'title' && this.titleDepth > -1 && this.titleDepth <= this.depth) return output

    // Store the output in the appropriate place(s).
    if (this.inentry && !this.insource) {
      const entry = this.entries.at(-1)!
      if (element === 'content') {
        entry.setdefault('content', [])
        const contentparams = this.contentparams.deepCopy()
        contentparams.set('value', output)
        entry.get('content').push(contentparams)
      } else if (element === 'link') {
        if (!this.inimage) {
          // Query variables in URLs in link elements are improperly converted from `?a=1&b=2` to `?a=1&b;=2` as if they
          // were unhandled character references. Fix this special case.
          output = output.replaceAll('&amp;', '&').replace(/&([A-Za-z0-9_]+);/g, '&$1')
          entry.set('link', output)
          if (output) (entry.get('links').at(-1) as FeedParserDict).set('href', output)
        }
      } else {
        if (element === 'description') element = 'summary'
        let depths = this.propertyDepth.get(entry)
        if (!depths) this.propertyDepth.set(entry, (depths = {}))
        const old = depths[element]
        if (old === undefined || this.depth <= old) {
          depths[element] = this.depth
          entry.set(element, output)
        }
        if (this.incontent) {
          const contentparams = this.contentparams.deepCopy()
          contentparams.set('value', output)
          entry.set(`${element}_detail`, contentparams)
        }
      }
    } else if (this.infeed || this.insource) {
      const context = this.getContext()
      if (element === 'description') element = 'subtitle'
      context.set(element, output)
      if (element === 'link') {
        // Fix the query variables; see above for the explanation.
        output = output.replace(/&([A-Za-z0-9_]+);/g, '&$1')
        context.set(element, output)
        ;(context.get('links').at(-1) as FeedParserDict).set('href', output)
      } else if (this.incontent) {
        const contentparams = this.contentparams.deepCopy()
        contentparams.set('value', output)
        context.set(`${element}_detail`, contentparams)
      }
    }
    return output
  }

  pushContent(tag: string, attrsD: Attrs, defaultContentType: string, expectingText: number | boolean): void {
    this.incontent += 1
    if (this.lang) this.lang = this.lang.replaceAll('_', '-')
    this.contentparams = new FeedParserDict({ type: FeedState.mapContentType(attrsD.get('type') ?? defaultContentType), language: this.lang, base: this.baseuri })
    this.contentparams.set('base64', this.isBase64(attrsD))
    this.push(tag, expectingText)
  }

  popContent(tag: string): string | undefined {
    const value = this.pop(tag)
    this.incontent -= 1
    this.contentparams.clear()
    return value
  }

  /**
   * A number of elements in a number of RSS variants are nominally plain text, but this is routinely ignored. This is
   * an attempt to detect the most common cases; false positives often result in silent data loss, so it errs on the
   * conservative side.
   */
  looksLikeHtml(s: string): boolean {
    // Must have a close tag or an entity reference to qualify.
    if (!/<\/(\w+)>/.test(s) && !/&#?\w+;/.test(s)) return false
    // All tags must be in a restricted subset of valid HTML tags.
    for (const m of s.matchAll(/<\/?(\w+)/g)) if (!ACCEPTABLE_ELEMENTS.has(m[1]!.toLowerCase())) return false
    // All entities must have been defined as valid HTML entities.
    for (const m of s.matchAll(/&(\w+);/g)) if (!ENTITYDEFS.has(m[1]!)) return false
    return true
  }

  private mapToStandardPrefix(name: string): string {
    const colon = name.indexOf(':')
    if (colon === -1) return name
    const prefix = name.slice(0, colon)
    return `${this.namespacemap.get(prefix) ?? prefix}:${name.slice(colon + 1)}`
  }

  getAttribute(attrsD: Attrs, name: string): string | undefined {
    return attrsD.get(this.mapToStandardPrefix(name))
  }

  private isBase64(attrsD: Attrs): number {
    if ((attrsD.get('mode') ?? '') === 'base64') return 1
    const type = this.contentparams.get('type') as string
    if (type.startsWith('text/') || type.endsWith('+xml') || type.endsWith('/xml')) return 0
    return 1
  }

  private static enforceHref(attrsD: Attrs): Attrs {
    const href = attrsD.get('url') ?? attrsD.get('uri') ?? attrsD.get('href')
    if (href) {
      attrsD.delete('url')
      attrsD.delete('uri')
      attrsD.set('href', href)
    }
    return attrsD
  }

  private save(key: string, value: unknown, overwrite = false): void {
    const context = this.getContext()
    if (overwrite) context.set(key, value)
    else context.setdefault(key, value)
  }

  getContext(): FeedParserDict {
    if (this.insource) return this.sourcedata
    if (this.inimage && this.feeddata.has('image')) return this.feeddata.get('image')
    if (this.intextinput) return this.feeddata.get('textinput')
    if (this.inentry) return this.entries.at(-1)!
    return this.feeddata
  }

  private saveAuthor(key: string, value: string | undefined, prefix = 'author'): void {
    const context = this.getContext()
    context.setdefault(`${prefix}_detail`, new FeedParserDict())
    context.get(`${prefix}_detail`).set(key, value)
    this.syncAuthorDetail()
    context.setdefault('authors', [new FeedParserDict()])
    context.get('authors').at(-1).set(key, value)
  }

  private saveContributor(key: string, value: string | undefined): void {
    const context = this.getContext()
    context.setdefault('contributors', [new FeedParserDict()])
    context.get('contributors').at(-1).set(key, value)
  }

  syncAuthorDetail(key = 'author'): void {
    const context = this.getContext()
    const list = context.get(`${key}s`) as FeedParserDict[] | undefined
    const detail = list?.at(-1) ?? new FeedParserDict()
    if (detail.size > 0) {
      const name = detail.get('name')
      const email = detail.get('email')
      if (name && email) context.set(key, `${name} (${email})`)
      else if (name) context.set(key, name)
      else if (email) context.set(key, email)
    } else {
      let author: string | undefined = context.get(key)
      let email: string | undefined
      if (!author) return
      const emailmatch = /(([a-zA-Z0-9_\-.+]+)@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.)|(([a-zA-Z0-9-]+\.)+))([a-zA-Z]{2,4}|[0-9]{1,3})(\]?))(\?subject=\S+)?/.exec(author)
      if (emailmatch) {
        email = emailmatch[0]
        // Probably a better way to do the following, but it passes all the tests.
        author = author.replaceAll(email, '')
        author = author.replaceAll('()', '').replaceAll('<>', '').replaceAll('&lt;&gt;', '')
        author = strip(author)
        if (author && author[0] === '(') author = author.slice(1)
        if (author && author.at(-1) === ')') author = author.slice(0, -1)
        author = strip(author)
      }
      if (author || email) context.setdefault(`${key}_detail`, detail)
      if (author) detail.set('name', author)
      if (email) detail.set('email', email)
    }
  }

  private addTag(term: string | undefined | null, scheme: string | undefined | null, label: string | undefined | null): void {
    const context = this.getContext()
    const tags = context.setdefault('tags', [] as FeedParserDict[])
    if (!term && !scheme && !label) return
    const value = new FeedParserDict({ term, scheme, label })
    const same = (a: FeedParserDict) => a.get('term') === term && a.get('scheme') === scheme && a.get('label') === label
    if (!tags.some(same)) tags.push(value)
  }

  // ---- the handlers ----

  private register(): void {
    const s = this.start
    const e = this.end
    const both = (names: string[], start: (attrs: Attrs) => void, end: () => void): void => {
      for (const name of names) {
        s[name] = start
        e[name] = end
      }
    }

    // -- RSS, Atom, RDF (namespaces/_base.py) --
    s.rss = (attrs) => {
      const versionmap: Record<string, string> = { '0.91': 'rss091u', '0.92': 'rss092', '0.93': 'rss093', '0.94': 'rss094' }
      // If we're here then this is an RSS feed. Without a version, or with one that does not start with RSS, correct it.
      if (!this.version || !this.version.startsWith('rss')) {
        const attrVersion = attrs.get('version') ?? ''
        const version = Object.hasOwn(versionmap, attrVersion) ? versionmap[attrVersion] : undefined
        if (version) this.version = version
        else if (attrVersion.startsWith('2.')) this.version = 'rss20'
        else this.version = 'rss'
      }
    }
    s.channel = (attrs) => {
      this.infeed = 1
      this.cdfCommon(attrs)
    }
    s.feed = (attrs) => {
      this.infeed = 1
      const versionmap: Record<string, string> = { '0.1': 'atom01', '0.2': 'atom02', '0.3': 'atom03' }
      if (!this.version) {
        const attrVersion = attrs.get('version')
        const version = attrVersion !== undefined && Object.hasOwn(versionmap, attrVersion) ? versionmap[attrVersion] : undefined
        this.version = version ?? 'atom'
      }
    }
    e.channel = e.feed = () => {
      this.infeed = 0
    }
    s.image = () => {
      const context = this.getContext()
      if (!this.inentry) context.setdefault('image', new FeedParserDict())
      this.inimage = 1
      this.titleDepth = -1
      this.push('image', 0)
    }
    e.image = () => {
      this.pop('image')
      this.inimage = 0
    }
    s.textinput = () => {
      const context = this.getContext()
      context.setdefault('textinput', new FeedParserDict())
      this.intextinput = 1
      this.titleDepth = -1
      this.push('textinput', 0)
    }
    e.textinput = () => {
      this.pop('textinput')
      this.intextinput = 0
    }
    const startAuthor = (): void => {
      this.inauthor = 1
      this.push('author', 1)
      // Append a new FeedParserDict when expecting an author.
      const context = this.getContext()
      context.setdefault('authors', [])
      context.get('authors').push(new FeedParserDict())
    }
    const endAuthor = (): void => {
      this.pop('author')
      this.inauthor = 0
      this.syncAuthorDetail()
    }
    both(['author', 'managingeditor'], startAuthor, endAuthor)
    s.contributor = () => {
      this.incontributor = 1
      const context = this.getContext()
      context.setdefault('contributors', [])
      context.get('contributors').push(new FeedParserDict())
      this.push('contributor', 0)
    }
    e.contributor = () => {
      this.pop('contributor')
      this.incontributor = 0
    }
    s.name = () => this.push('name', 0)
    const endName = (): void => {
      const value = this.pop('name')
      if (this.inpublisher) this.saveAuthor('name', value, 'publisher')
      else if (this.inauthor) this.saveAuthor('name', value)
      else if (this.incontributor) this.saveContributor('name', value)
      else if (this.intextinput) this.getContext().set('name', value)
    }
    e.name = endName
    for (const dim of ['width', 'height']) {
      s[dim] = () => this.push(dim, 0)
      e[dim] = () => {
        const value = this.pop(dim)
        const n = /^\s*[+-]?\d+\s*$/.test(value ?? '') ? Number(value) : 0
        if (this.inimage) this.getContext().set(dim, n)
      }
    }
    const startUrl = (): void => this.push('href', 1)
    const endUrl = (): void => {
      const value = this.pop('href')
      if (this.inauthor) this.saveAuthor('href', value)
      else if (this.incontributor) this.saveContributor('href', value)
    }
    both(['url', 'homepage', 'uri'], startUrl, endUrl)
    s.email = () => this.push('email', 0)
    const endEmail = (): void => {
      const value = this.pop('email')
      if (this.inpublisher) this.saveAuthor('email', value, 'publisher')
      else if (this.inauthor) this.saveAuthor('email', value)
      else if (this.incontributor) this.saveContributor('email', value)
    }
    e.email = endEmail
    const startSubtitle = (attrs: Attrs): void => this.pushContent('subtitle', attrs, 'text/plain', 1)
    const endSubtitle = (): void => void this.popContent('subtitle')
    both(['subtitle', 'tagline'], startSubtitle, endSubtitle)
    const startRights = (attrs: Attrs): void => this.pushContent('rights', attrs, 'text/plain', 1)
    const endRights = (): void => void this.popContent('rights')
    both(['rights', 'copyright'], startRights, endRights)
    const startItem = (attrs: Attrs): void => {
      this.entries.push(new FeedParserDict())
      this.push('item', 0)
      this.inentry = 1
      this.guidislink = false
      this.titleDepth = -1
      const id = this.getAttribute(attrs, 'rdf:about')
      if (id) this.getContext().set('id', id)
      this.cdfCommon(attrs)
    }
    const endItem = (): void => {
      this.pop('item')
      this.inentry = 0
      this.hasContent = 0
    }
    both(['item', 'entry'], startItem, endItem)
    s.language = () => this.push('language', 1)
    e.language = () => {
      this.lang = this.pop('language') ?? null
    }
    s.webmaster = () => this.push('publisher', 1)
    const endWebmaster = (): void => {
      this.pop('publisher')
      this.syncAuthorDetail('publisher')
    }
    e.webmaster = endWebmaster
    const startPublished = (): void => this.push('published', 1)
    const endPublished = (): void => {
      const value = this.pop('published')
      this.save('published_parsed', parseDate(value, this.now), true)
    }
    both(['published', 'issued', 'pubdate'], startPublished, endPublished)
    const startUpdated = (): void => this.push('updated', 1)
    const endUpdated = (): void => {
      const value = this.pop('updated')
      this.save('updated_parsed', parseDate(value, this.now), true)
    }
    both(['updated', 'modified', 'lastbuilddate'], startUpdated, endUpdated)
    s.created = () => this.push('created', 1)
    e.created = () => {
      const value = this.pop('created')
      this.save('created_parsed', parseDate(value, this.now), true)
    }
    s.expirationdate = () => this.push('expired', 1)
    e.expirationdate = () => {
      this.save('expired_parsed', parseDate(this.pop('expired'), this.now), true)
    }
    const startCategory = (attrs: Attrs): void => {
      this.addTag(attrs.get('term'), attrs.get('scheme') ?? attrs.get('domain'), attrs.get('label'))
      this.push('category', 1)
    }
    const endCategory = (): void => {
      const value = this.pop('category')
      if (!value) return
      const context = this.getContext()
      const tags = context.get('tags') as FeedParserDict[]
      if (value && tags.length > 0 && !tags.at(-1)!.get('term')) tags.at(-1)!.set('term', value)
      else this.addTag(value, null, null)
    }
    both(['category', 'keywords'], startCategory, endCategory)
    s.cloud = (attrs) => this.getContext().set('cloud', new FeedParserDict(attrs))
    s.link = (attrsIn) => {
      const attrs = attrsIn
      if (!attrs.has('rel')) attrs.set('rel', 'alternate')
      if (attrs.get('rel') === 'self') {
        if (!attrs.has('type')) attrs.set('type', 'application/atom+xml')
      } else if (!attrs.has('type')) attrs.set('type', 'text/html')
      const context = this.getContext()
      FeedState.enforceHref(attrs)
      if (attrs.has('href')) attrs.set('href', this.resolveUri(attrs.get('href')!))
      const expectingText = this.infeed || this.inentry || this.insource
      context.setdefault<any[]>('links', [])
      if (!(this.inentry && this.inimage)) context.get('links').push(new FeedParserDict(attrs))
      if (attrs.has('href')) {
        if (attrs.get('rel') === 'alternate' && HTML_TYPES.has(FeedState.mapContentType(attrs.get('type')!))) context.set('link', attrs.get('href'))
      } else this.push('link', expectingText)
    }
    e.link = () => void this.pop('link')
    const startGuid = (attrs: Attrs): void => {
      this.guidislink = (attrs.get('ispermalink') ?? 'true') === 'true'
      this.push('id', 1)
    }
    const endGuid = (): void => {
      const value = this.pop('id')
      this.save('guidislink', this.guidislink && !this.getContext().has('link'))
      if (this.guidislink) {
        // The guid acts as a link, but only if 'ispermalink' is not present or is 'true', and only if the item doesn't already have a link element.
        this.save('link', value)
      }
    }
    both(['guid', 'id'], startGuid, endGuid)
    s.title = (attrs) => {
      if (this.svgOK) {
        this.unknownStarttag('title', [...attrs])
        return
      }
      this.pushContent('title', attrs, 'text/plain', this.infeed || this.inentry || this.insource)
    }
    const endTitle = (): void => {
      if (this.svgOK) return
      const value = this.popContent('title')
      if (!value) return
      this.titleDepth = this.depth
    }
    e.title = endTitle
    s.description = (attrs) => {
      const context = this.getContext()
      if (context.has('summary') && !this.hasContent) {
        this.summaryKey = 'content'
        s.content!(attrs)
      } else this.pushContent('description', attrs, 'text/html', this.infeed || this.inentry || this.insource)
    }
    s.abstract = (attrs) => this.pushContent('description', attrs, 'text/plain', this.infeed || this.inentry || this.insource)
    const endDescription = (): void => {
      if (this.summaryKey === 'content') e.content!()
      else this.popContent('description')
      this.summaryKey = null
    }
    e.description = e.abstract = endDescription
    both(['info', 'feedburner_browserfriendly'], (attrs) => this.pushContent('info', attrs, 'text/plain', 1), () => void this.popContent('info'))
    s.generator = (attrsIn) => {
      let attrs = attrsIn
      if (attrs.size > 0) {
        attrs = FeedState.enforceHref(attrs)
        if (attrs.has('href')) attrs.set('href', this.resolveUri(attrs.get('href')!))
      }
      this.getContext().set('generator_detail', new FeedParserDict(attrs))
      this.push('generator', 1)
    }
    e.generator = () => {
      const value = this.pop('generator')
      const context = this.getContext()
      if (context.has('generator_detail')) context.get('generator_detail').set('name', value)
    }
    s.summary = (attrs) => {
      const context = this.getContext()
      if (context.has('summary') && !this.hasContent) {
        this.summaryKey = 'content'
        s.content!(attrs)
      } else {
        this.summaryKey = 'summary'
        this.pushContent(this.summaryKey, attrs, 'text/plain', 1)
      }
    }
    e.summary = () => {
      if (this.summaryKey === 'content') e.content!()
      else this.popContent(this.summaryKey ?? 'summary')
      this.summaryKey = null
    }
    s.enclosure = (attrs) => {
      const href = FeedState.enforceHref(attrs)
      href.set('rel', 'enclosure')
      this.getContext().setdefault<any[]>('links', []).push(new FeedParserDict(href))
    }
    s.source = (attrs) => {
      if (attrs.has('url')) {
        // This means that we're processing a source element from an RSS 2.0 feed.
        this.sourcedata.set('href', attrs.get('url'))
      }
      this.push('source', 1)
      this.insource = 1
      this.titleDepth = -1
    }
    e.source = () => {
      this.insource = 0
      const value = this.pop('source')
      if (value) this.sourcedata.set('title', value)
      this.getContext().set('source', this.sourcedata.deepCopy())
      this.sourcedata.clear()
    }
    s.content = (attrs) => {
      this.hasContent = 1
      this.pushContent('content', attrs, 'text/plain', 1)
      const src = attrs.get('src')
      if (src) this.contentparams.set('src', src)
      this.push('content', 1)
    }
    const startBody = (attrs: Attrs): void => this.pushContent('content', attrs, 'application/xhtml+xml', 1)
    const startContentEncoded = (attrs: Attrs): void => {
      this.hasContent = 1
      this.pushContent('content', attrs, 'text/html', 1)
    }
    const endContent = (): void => {
      // A stray end tag finds no content parameters: `None.lower()` is an AttributeError.
      const copyToSummary = ['text/plain', ...HTML_TYPES].includes(FeedState.mapContentType(noneIsError(this.contentparams.get('type'))))
      const value = this.popContent('content')
      if (copyToSummary) this.save('summary', value)
    }
    e.content = endContent
    both(['body', 'xhtml_body'], startBody, endContent)
    both(['content_encoded', 'fullitem'], startContentEncoded, endContent)
    s.newlocation = () => this.push('newlocation', 1)
    e.newlocation = () => {
      const url = noneIsError(this.pop('newlocation'))
      const context = this.getContext()
      // Don't set newlocation if the context isn't right.
      if (context !== this.feeddata) return
      context.set('newlocation', makeSafeAbsoluteUri(this.baseuri, strip(url)))
    }
    s.tags = () => this.push('tags', 1)
    e.tags = () => {
      for (const term of noneIsError(this.pop('tags')).split(',')) this.addTag(strip(term), null, null)
    }

    // -- Dublin Core (namespaces/dc.py) --
    both(['dc_author', 'dc_creator'], startAuthor, endAuthor)
    both(['dc_date'], startUpdated, endUpdated)
    both(['dc_description'], s.description!, endDescription)
    both(['dc_language'], s.language!, e.language!)
    both(['dc_publisher'], s.webmaster!, endWebmaster)
    both(['dc_rights'], startRights, endRights)
    both(['dc_subject'], startCategory, endCategory)
    both(['dc_title'], s.title!, endTitle)
    both(['dcterms_created'], s.created!, e.created!)
    both(['dcterms_issued'], startPublished, endPublished)
    both(['dcterms_modified'], startUpdated, endUpdated)
    s.dcterms_valid = () => this.push('validity', 1)
    e.dcterms_valid = () => {
      for (const detail of noneIsError(this.pop('validity')).split(';')) {
        const at = detail.indexOf('=')
        if (at < 0) continue
        const key = detail.slice(0, at)
        const value = detail.slice(at + 1)
        if (key === 'start') {
          this.save('validity_start', value, true)
          this.save('validity_start_parsed', parseDate(value, this.now), true)
        } else if (key === 'end') {
          this.save('validity_end', value, true)
          this.save('validity_end_parsed', parseDate(value, this.now), true)
        }
      }
    }
    s.dc_contributor = () => {
      this.incontributor = 1
      const context = this.getContext()
      context.setdefault('contributors', [])
      context.get('contributors').push(new FeedParserDict())
      this.push('name', 0)
    }
    e.dc_contributor = () => {
      endName()
      this.incontributor = 0
    }

    // -- iTunes (namespaces/itunes.py) --
    both(['itunes_author'], startAuthor, endAuthor)
    e.itunes_category = endCategory
    both(['itunes_name'], s.name!, endName)
    both(['itunes_email'], s.email!, endEmail)
    both(['itunes_subtitle'], startSubtitle, endSubtitle)
    both(['itunes_summary'], s.summary!, e.summary!)
    s.itunes_owner = () => {
      this.inpublisher = 1
      this.push('publisher', 0)
    }
    e.itunes_owner = () => {
      this.pop('publisher')
      this.inpublisher = 0
      this.syncAuthorDetail('publisher')
    }
    e.itunes_keywords = () => {
      for (const term of noneIsError(this.pop('itunes_keywords')).split(',')) if (strip(term)) this.addTag(strip(term), 'http://www.itunes.com/', null)
    }
    s.itunes_category = (attrs) => {
      this.addTag(attrs.get('text'), 'http://www.itunes.com/', null)
      this.push('category', 1)
    }
    for (const name of ['itunes_image', 'itunes_link']) {
      s[name] = (attrs) => {
        this.push('itunes_image', 0)
        const href = attrs.get('href') || attrs.get('url')
        if (href) this.getContext().set('image', new FeedParserDict({ href }))
      }
    }
    e.itunes_block = () => void this.pop('itunes_block', false)
    e.itunes_explicit = () => void this.pop('itunes_explicit', false)

    // -- Media RSS (namespaces/mediarss.py) --
    s.media_category = (attrs) => {
      if (!attrs.has('scheme')) attrs.set('scheme', 'http://search.yahoo.com/mrss/category_schema')
      startCategory(attrs)
    }
    e.media_category = endCategory
    e.media_keywords = () => {
      for (const term of noneIsError(this.pop('media_keywords')).split(',')) if (strip(term)) this.addTag(strip(term), null, null)
    }
    s.media_title = s.title
    e.media_title = () => {
      const titleDepth = this.titleDepth
      endTitle()
      this.titleDepth = titleDepth
    }
    s.media_group = () => {}
    s.media_rating = (attrs) => {
      this.getContext().setdefault('media_rating', new FeedParserDict(attrs))
      this.push('rating', 1)
    }
    e.media_rating = () => {
      const rating = this.pop('rating')
      if (rating !== undefined && strip(rating)) this.getContext().get('media_rating').set('content', rating)
    }
    s.media_credit = (attrs) => {
      this.getContext().setdefault<any[]>('media_credit', []).push(new FeedParserDict(attrs))
      this.push('credit', 1)
    }
    e.media_credit = () => {
      const credit = this.pop('credit')
      if (credit !== undefined && strip(credit)) this.getContext().get('media_credit').at(-1).set('content', credit)
    }
    both(['media_description'], s.description!, endDescription)
    s.media_restriction = (attrs) => {
      this.getContext().setdefault('media_restriction', new FeedParserDict(attrs))
      this.push('restriction', 1)
    }
    e.media_restriction = () => {
      const restriction = this.pop('restriction')
      if (restriction !== undefined && strip(restriction)) this.getContext().get('media_restriction').set('content', restriction.split(' ').map((c) => strip(c).toLowerCase()))
    }
    s.media_license = (attrs) => {
      this.getContext().setdefault('media_license', new FeedParserDict(attrs))
      this.push('license', 1)
    }
    e.media_license = () => {
      const license = this.pop('license')
      if (license !== undefined && strip(license)) this.getContext().get('media_license').set('content', license)
    }
    s.media_content = (attrs) => {
      this.getContext().setdefault<any[]>('media_content', []).push(new FeedParserDict(attrs))
    }
    s.media_thumbnail = (attrs) => {
      const context = this.getContext()
      context.setdefault('media_thumbnail', [])
      this.push('url', 1)
      context.get('media_thumbnail').push(new FeedParserDict(attrs))
    }
    e.media_thumbnail = () => {
      const url = this.pop('url')
      const context = this.getContext()
      if (url !== undefined && strip(url)) {
        const last = context.get('media_thumbnail').at(-1) as FeedParserDict
        if (!last.rawHas('url')) last.set('url', url)
      }
    }
    s.media_player = (attrs) => {
      this.push('media_player', 0)
      this.getContext().set('media_player', new FeedParserDict(attrs))
    }
    e.media_player = () => {
      const value = this.pop('media_player')
      this.getContext().get('media_player').set('content', value)
    }

    // -- Creative Commons (namespaces/cc.py) --
    s.cc_license = (attrs) => {
      const context = this.getContext()
      const value = this.getAttribute(attrs, 'rdf:resource')
      const license = new FeedParserDict()
      license.set('rel', 'license')
      if (value) license.set('href', value)
      context.setdefault<any[]>('links', []).push(license)
    }
    s.creativecommons_license = () => this.push('license', 1)
    e.creativecommons_license = () => {
      const value = this.pop('license')
      const context = this.getContext()
      const license = new FeedParserDict()
      license.set('rel', 'license')
      if (value) license.set('href', value)
      context.setdefault<any[]>('links', []).push(license)
      context.delete('license')
    }

    // -- Administrative RDF (namespaces/admin.py) --
    s.admin_generatoragent = (attrs) => {
      this.push('generator', 1)
      const value = this.getAttribute(attrs, 'rdf:resource')
      if (value) this.elementstack.at(-1)![2].push(value)
      this.pop('generator')
      this.getContext().set('generator_detail', new FeedParserDict({ href: value }))
    }
    s.admin_errorreportsto = (attrs) => {
      this.push('errorreportsto', 1)
      const value = this.getAttribute(attrs, 'rdf:resource')
      if (value) this.elementstack.at(-1)![2].push(value)
      this.pop('errorreportsto')
    }

    // -- GeoRSS and GML (namespaces/georss.py): the stack effects, not the geometry --
    const startGeom = (): void => {
      this.push('geometry', 0)
      this.getContext().set('where', new FeedParserDict())
    }
    for (const name of ['georss_point', 'georss_line', 'georss_polygon', 'georss_box']) {
      s[name] = startGeom
      e[name] = () => void this.pop('geometry')
    }
    both(['where', 'georss_where'], () => {
      this.push('where', 0)
      this.getContext().set('where', new FeedParserDict())
    }, () => void this.pop('where'))
    const parseSrsAttrs = (attrs: Attrs): void => {
      const context = this.getContext()
      if (!context.has('where')) context.set('where', new FeedParserDict())
      const n = Number(attrs.get('srsdimension') ?? '2')
      context.get('where').set('srsName', attrs.get('srsname'))
      context.get('where').set('srsDimension', Number.isInteger(n) ? n : 2)
    }
    s.gml_point = (attrs) => {
      parseSrsAttrs(attrs)
      this.ingeometry = 1
      this.push('geometry', 0)
    }
    s.gml_linestring = (attrs) => {
      parseSrsAttrs(attrs)
      this.ingeometry = 'linestring'
      this.push('geometry', 0)
    }
    s.gml_polygon = (attrs) => {
      parseSrsAttrs(attrs)
      this.push('geometry', 0)
    }
    s.gml_exterior = () => this.push('geometry', 0)
    s.gml_linearring = () => {
      this.ingeometry = 'polygon'
      this.push('geometry', 0)
    }
    s.gml_pos = () => this.push('pos', 0)
    s.gml_poslist = () => this.push('pos', 0)
    e.gml_pos = () => void this.pop('pos')
    e.gml_poslist = () => void this.pop('pos')
    for (const name of ['gml_point', 'gml_linestring', 'gml_linearring', 'gml_exterior', 'gml_polygon']) {
      e[name] = () => {
        this.ingeometry = 0
        this.pop('geometry')
      }
    }

    // -- Podlove simple chapters (namespaces/psc.py) --
    s.psc_chapters = (attrs) => {
      const context = this.getContext()
      if (!context.has('psc_chapters')) {
        this.psc = true
        attrs.set('chapters', '')
        context.set('psc_chapters', new FeedParserDict(attrs))
      }
    }
    e.psc_chapters = () => {
      this.psc = false
    }
    s.psc_chapter = () => {}
  }

  /** `_cdf_common`: the CDF attributes `lastmod` and `href`. */
  private cdfCommon(attrs: Attrs): void {
    if (attrs.has('lastmod')) {
      this.start.modified!(new Map())
      this.elementstack.at(-1)![2] = [attrs.get('lastmod')!]
      this.end.modified!()
    }
    if (attrs.has('href')) {
      this.start.link!(new Map())
      this.elementstack.at(-1)![2] = [attrs.get('href')!]
      this.end.link!()
    }
  }
}
