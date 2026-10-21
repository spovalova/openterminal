// feedparser's markup processors: the HTML processor that rebuilds markup piece by piece, the sanitizer that drops what
// feeds must not carry, and the resolver that makes relative links absolute. Ported from feedparser/html.py,
// feedparser/sanitizer.py and feedparser/urls.py (feedparser 6.0.14, BSD-2-Clause); modified: the whitelists are
// sanitizer.json (built by generate-sanitizer.py), and the SVG and MathML name maps are built once instead of on
// the first SVG tag.
import { split, strip } from '../../sec/markdown/py.js'
import { AssertionError, SGMLParseError, SGMLParser } from './sgml.js'
import { feedUrljoin, makeSafeAbsoluteUri } from './pyurl.js'
import tables from './sanitizer.json' with { type: 'json' }

const set = (items: readonly string[]): Set<string> => new Set(items)
const NO_END_TAG = set(tables.noEndTag)
const NAME2CODEPOINT = new Map(Object.entries(tables.name2codepoint))

/** The Windows-1252 characters that sit at 128-159 in Latin-1 (`_cp1252`). */
export const CP1252: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
}

/** `str.translate(_cp1252)`: the characters at 128-159 become the Windows-1252 ones. */
export function translateCp1252(text: string): string {
  return text.replace(/[\u0080-\u009f]/g, (c) => CP1252[c.charCodeAt(0)] ?? c)
}

const BARE_AMPERSAND = /&(?!#\d+;|#x[0-9a-fA-F]+;|\w+;)/g

export class BaseHTMLProcessor extends SGMLParser {
  pieces: string[] = []

  constructor(
    readonly encoding?: string,
    protected readonly type = 'application/xhtml+xml',
  ) {
    super()
  }

  override reset(): void {
    this.pieces = []
    super.reset()
  }

  /** A `<tag/>` as `<tag />` for the elements that never have an end tag, else as `<tag></tag>` (`_shorttag_replace`). */
  private shorttagReplace(tag: string): string {
    return NO_END_TAG.has(tag) ? `<${tag} />` : `<${tag}></${tag}>`
  }

  protected override parseStarttag(i: number): number {
    const j = super.parseStarttag(i)
    if (this.type === 'application/xhtml+xml' && j > 2 && this.rawdata.slice(j - 2, j) === '/>') this.unknownEndtag(this.lasttag)
    return j
  }

  override feed(data: string): void {
    data = data.replace(/<!(?!DOCTYPE|--|\[)/gi, '&lt;!')
    data = data.replace(/<([^<>\s]+?)\s*\/>/g, (_m, tag: string) => this.shorttagReplace(tag))
    data = data.replaceAll('&#39;', "'").replaceAll('&#34;', '"')
    super.feed(data)
    super.close()
  }

  /** `normalize_attrs`: names lower-cased, duplicates collapsed to the last, `rel` and `type` values lower-cased, sorted. */
  protected normalizeAttrs(attrs: [string, string][]): [string, string][] {
    if (attrs.length === 0) return attrs
    const byName = new Map<string, string>()
    for (const [k, v] of attrs) byName.set(k.toLowerCase(), v)
    const out: [string, string][] = [...byName].map(([k, v]) => [k, (k === 'rel' || k === 'type') && v.toLowerCase() ? v.toLowerCase() : v])
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  }

  protected override unknownStarttag(tag: string, attrs: [string, string][]): void {
    let strattrs = ''
    if (attrs.length > 0) {
      strattrs = attrs
        .map(([key, value]) => {
          value = value.replaceAll('>', '&gt;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replace(BARE_AMPERSAND, '&amp;')
          return ` ${key}="${value}"`
        })
        .join('')
    }
    this.pieces.push(NO_END_TAG.has(tag) ? `<${tag}${strattrs} />` : `<${tag}${strattrs}>`)
  }

  protected override unknownEndtag(tag: string): void {
    // Reconstruct the original end tag.
    if (!NO_END_TAG.has(tag)) this.pieces.push(`</${tag}>`)
  }

  protected override handleCharref(ref: string): void {
    // Reconstruct the original character reference.
    ref = ref.toLowerCase()
    const value = ref.startsWith('x') ? parseInt(ref.slice(1), 16) : parseInt(ref, 10)
    const mapped = CP1252[value]
    this.pieces.push(mapped !== undefined ? `&#x${mapped.codePointAt(0)!.toString(16)};` : `&#${ref};`)
  }

  protected override handleEntityref(ref: string): void {
    // Reconstruct the original entity reference.
    this.pieces.push(NAME2CODEPOINT.has(ref) || ref === 'apos' ? `&${ref};` : `&amp;${ref}`)
  }

  protected override handleData(text: string): void {
    this.pieces.push(text)
  }

  protected override handleComment(text: string): void {
    this.pieces.push(`<!--${text}-->`)
  }

  protected override handlePi(text: string): void {
    this.pieces.push(`<?${text}>`)
  }

  protected override handleDecl(text: string): void {
    this.pieces.push(`<!${text}>`)
  }

  protected override convertCharref(name: string): string {
    return `&#${name};`
  }

  protected override convertEntityref(name: string): string {
    return `&${name};`
  }

  protected override parseDeclaration(i: number): number {
    try {
      return super.parseDeclaration(i)
    } catch (error) {
      if (!(error instanceof AssertionError || error instanceof SGMLParseError)) throw error
      // Escape the doctype declaration and continue parsing.
      this.handleData('&lt;')
      return i + 1
    }
  }

  /** The processed HTML as a single string. */
  output(): string {
    return this.pieces.join('')
  }
}

// ---- the sanitizer ----

const ACCEPTABLE_ELEMENTS = set(tables.elements)
const ACCEPTABLE_ATTRIBUTES = set(tables.attributes)
const UNACCEPTABLE_WITH_END_TAG = set(tables.unacceptableWithEndTag)
const CSS_PROPERTIES = set(tables.cssProperties)
const CSS_KEYWORDS = set(tables.cssKeywords)
const MATHML_ELEMENTS = set(tables.mathmlElements)
const MATHML_ATTRIBUTES = set(tables.mathmlAttributes)
const SVG_PROPERTIES = set(tables.svgProperties)
const VALID_CSS_VALUES = /^(#[0-9a-f]+|rgb\(\d+%?,\d*%?,?\d*%?\)?|\d{0,2}\.?\d{0,2}(cm|em|ex|in|mm|pc|pt|px|%|,|\))?)$/

// SVG names are lower-cased for matching; a camel-case name maps back to its spelling.
const SVG_ELEMENTS = set(tables.svgElements.map((e) => e.toLowerCase()))
const SVG_ELEMENT_MAP = new Map(tables.svgElements.filter((e) => e !== e.toLowerCase()).map((e) => [e.toLowerCase(), e] as const))
const SVG_ATTRIBUTES = set(tables.svgAttributes.map((a) => a.toLowerCase()))
const SVG_ATTRIBUTE_MAP = new Map(tables.svgAttributes.filter((a) => a !== a.toLowerCase()).map((a) => [a.toLowerCase(), a] as const))

export class HTMLSanitizer extends BaseHTMLProcessor {
  private unacceptablestack = 0
  private mathmlOK = 0
  private svgOK = 0

  override reset(): void {
    super.reset()
    this.unacceptablestack = 0
    this.mathmlOK = 0
    this.svgOK = 0
  }

  protected override unknownStarttag(tag: string, attrs: [string, string][]): void {
    let acceptableAttributes: Set<string> = ACCEPTABLE_ATTRIBUTES
    let keymap = new Map<string, string>()
    const has = (name: string, value: string): boolean => attrs.some(([k, v]) => k === name && v === value)
    if (!ACCEPTABLE_ELEMENTS.has(tag) || this.svgOK) {
      if (UNACCEPTABLE_WITH_END_TAG.has(tag)) this.unacceptablestack += 1

      // Add implicit namespaces to HTML5 inline SVG and MathML.
      if (this.type.endsWith('html') && !attrs.find(([k]) => k === 'xmlns')?.[1]) {
        if (tag === 'svg') attrs.push(['xmlns', 'http://www.w3.org/2000/svg'])
        if (tag === 'math') attrs.push(['xmlns', 'http://www.w3.org/1998/Math/MathML'])
      }

      // Not otherwise acceptable, perhaps it is MathML or SVG?
      if (tag === 'math' && has('xmlns', 'http://www.w3.org/1998/Math/MathML')) this.mathmlOK += 1
      if (tag === 'svg' && has('xmlns', 'http://www.w3.org/2000/svg')) this.svgOK += 1

      // Choose the acceptable attributes by the tag's class, else bail.
      if (this.mathmlOK && MATHML_ELEMENTS.has(tag)) acceptableAttributes = MATHML_ATTRIBUTES
      else if (this.svgOK && SVG_ELEMENTS.has(tag)) {
        acceptableAttributes = SVG_ATTRIBUTES
        tag = SVG_ELEMENT_MAP.get(tag) ?? tag
        keymap = SVG_ATTRIBUTE_MAP
      } else if (!ACCEPTABLE_ELEMENTS.has(tag)) return
    }

    // Declare the xlink namespace, if needed.
    if ((this.mathmlOK || this.svgOK) && attrs.some(([k]) => k.startsWith('xlink:')) && !has('xmlns:xlink', 'http://www.w3.org/1999/xlink')) attrs.push(['xmlns:xlink', 'http://www.w3.org/1999/xlink'])

    const clean: [string, string][] = []
    for (const [name, value] of this.normalizeAttrs(attrs)) {
      if (name === 'style' && acceptableAttributes.has('style')) {
        const cleanValue = this.sanitizeStyle(value)
        if (cleanValue) clean.push([name, cleanValue])
      } else if (acceptableAttributes.has(name)) {
        const key = keymap.get(name) ?? name
        // Make sure the URI uses an acceptable URI scheme.
        clean.push([key, key === 'href' ? makeSafeAbsoluteUri(value) : value])
      }
    }
    super.unknownStarttag(tag, clean)
  }

  protected override unknownEndtag(tag: string): void {
    if (!ACCEPTABLE_ELEMENTS.has(tag)) {
      if (UNACCEPTABLE_WITH_END_TAG.has(tag)) this.unacceptablestack -= 1
      if (this.mathmlOK && MATHML_ELEMENTS.has(tag)) {
        if (tag === 'math' && this.mathmlOK) this.mathmlOK -= 1
      } else if (this.svgOK && SVG_ELEMENTS.has(tag)) {
        tag = SVG_ELEMENT_MAP.get(tag) ?? tag
        if (tag === 'svg' && this.svgOK) this.svgOK -= 1
      } else return
    }
    super.unknownEndtag(tag)
  }

  protected override handlePi(_text: string): void {}

  protected override handleDecl(_text: string): void {}

  protected override handleData(text: string): void {
    if (!this.unacceptablestack) super.handleData(text)
  }

  private sanitizeStyle(style: string): string {
    // Disallow URLs.
    style = style.replace(/url\s*\(\s*[^\s)]+?\s*\)\s*/g, ' ')

    // The gauntlet.
    if (!/^(?:[:,;#%.\sa-zA-Z0-9!]|\w-\w|'[\s\w]+'|"[\s\w]+"|\([\d,\s]+\))*$/.test(style)) return ''
    if (strip(style.replace(/\s*[-\w]+\s*:\s*[^:;]*;?/g, ''))) return ''

    const clean: string[] = []
    for (const [, prop, value] of style.matchAll(/([-\w]+)\s*:\s*([^:;]*)/g)) {
      if (!value) continue
      if (CSS_PROPERTIES.has(prop!.toLowerCase())) clean.push(`${prop}: ${value};`)
      else if (['background', 'border', 'margin', 'padding'].includes(prop!.split('-')[0]!.toLowerCase())) {
        const keywords = split(value)
        if (keywords.every((keyword) => CSS_KEYWORDS.has(keyword) || VALID_CSS_VALUES.test(keyword))) clean.push(`${prop}: ${value};`)
      } else if (this.svgOK && SVG_PROPERTIES.has(prop!.toLowerCase())) clean.push(`${prop}: ${value};`)
    }
    return clean.join(' ')
  }

  protected override parseComment(i: number): number {
    const ret = super.parseComment(i)
    if (ret >= 0) return ret
    // If -1, this may be a malicious attempt to circumvent sanitization, or a page-destroying unclosed comment.
    const match = /--[^>]*>/g
    match.lastIndex = i + 4
    const found = match.exec(this.rawdata)
    if (found) return found.index + found[0].length
    // Unclosed comment: deliberately fail to handle_data().
    return this.rawdata.length
  }
}

/** `_sanitize_html`: markup with the dangerous parts left out. */
export function sanitizeHtml(htmlSource: string, encoding: string | undefined, type: string): string {
  const p = new HTMLSanitizer(encoding, type)
  p.feed(htmlSource.replaceAll('<![CDATA[', '&lt;![CDATA['))
  return strip(p.output()).replaceAll('\r\n', '\n')
}

// ---- relative URIs ----

const RELATIVE_URIS = new Set(tables.relativeUris.map(([tag, attr]) => `${tag}\u0000${attr}`))

class RelativeURIResolver extends BaseHTMLProcessor {
  constructor(
    private readonly baseuri: string,
    encoding: string | undefined,
    type: string,
  ) {
    super(encoding, type)
  }

  private resolveUri(uri: string): string {
    return makeSafeAbsoluteUri(this.baseuri, strip(uri))
  }

  protected override unknownStarttag(tag: string, attrs: [string, string][]): void {
    const normalized = this.normalizeAttrs(attrs).map(([key, value]): [string, string] => [key, (RELATIVE_URIS.has(`${tag}\u0000${key}`) && this.resolveUri(value)) || value])
    super.unknownStarttag(tag, normalized)
  }
}

/** `resolve_relative_uris`: the markup with its relative links made absolute against the base. */
export function resolveRelativeUris(htmlSource: string, baseUri: string, encoding: string | undefined, type: string): string {
  const p = new RelativeURIResolver(baseUri, encoding, type)
  p.feed(htmlSource)
  return p.output()
}

export { feedUrljoin }
