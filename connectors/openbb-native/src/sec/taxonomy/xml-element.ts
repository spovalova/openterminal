// An xml.etree.ElementTree look-alike for the XBRL ports, provider sec. Not ported from OpenBB (it replaces Python's
// stdlib `xml.etree.ElementTree` and `defusedxml.ElementTree`); modified: a small namespace-aware parser written for
// this package, with ElementTree's semantics where the ports depend on them.
//
//   const root = parseElementTree(bytes)            // ET.parse(BytesIO(bytes)).getroot(); throws XmlParseError
//   root.findall('.//{ns}tag/{ns}child')            // ElementPath: '{uri}tag', 'prefix:tag' with a map, '*', '.', '//',
//   root.findall('.//link:loc', { link: '…' })      //   and the predicates [@a], [@a='v'], [tag], [tag='v'], [n], [last()]
//   el.get('{uri}attr'), el.text, el.tail, el.children, el.iter(tag?), el.itertext()
//   tostring(el)                                    // ET.tostring(el, encoding='unicode'), tail included
//
// Tags and attribute names are Clark notation ('{uri}local') when namespaced. Comments and processing instructions are
// dropped, text keeps its whitespace, `text` is what precedes the first child and `tail` what follows the end tag.

/** `xml.etree.ElementTree.ParseError`; also raised where defusedxml refuses (entity declarations). */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XmlParseError'
  }
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace'

export class XmlElement {
  text: string | null = null
  tail: string | null = null
  children: XmlElement[] = []

  constructor(
    public tag: string,
    public attrib: Record<string, string> = {},
  ) {}

  /** `Element.get(key, default)`: undefined when the attribute is absent and no default is given. */
  get(key: string): string | undefined
  get(key: string, defaultValue: string): string
  get(key: string, defaultValue?: string): string | undefined {
    const v = this.attrib[key]
    return v === undefined ? defaultValue : v
  }

  [Symbol.iterator](): IterableIterator<XmlElement> {
    return this.children[Symbol.iterator]()
  }

  /** `Element.iter(tag)`: this element and every descendant in document order, optionally only those with `tag`. */
  iter(tag?: string): XmlElement[] {
    const out: XmlElement[] = []
    const walk = (el: XmlElement): void => {
      if (tag === undefined || tag === '*' || el.tag === tag) out.push(el)
      for (const c of el.children) walk(c)
    }
    walk(this)
    return out
  }

  /** `Element.itertext()`: all text and tails inside this element, in document order. */
  itertext(): string[] {
    const out: string[] = []
    const walk = (el: XmlElement): void => {
      if (el.text) out.push(el.text)
      for (const c of el.children) {
        walk(c)
        if (c.tail) out.push(c.tail)
      }
    }
    walk(this)
    return out
  }

  find(path: string, namespaces?: Record<string, string>): XmlElement | null {
    return this.findall(path, namespaces)[0] ?? null
  }

  findall(path: string, namespaces?: Record<string, string>): XmlElement[] {
    return evaluatePath(this, path, namespaces)
  }

  /** `Element.findtext(path, default)`: the text of the first match ('' when it has none), else the default. */
  findtext(path: string, defaultValue: string | null = null, namespaces?: Record<string, string>): string | null {
    const el = this.find(path, namespaces)
    return el === null ? defaultValue : (el.text ?? '')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ElementPath
// ---------------------------------------------------------------------------------------------------------------

type Step = { descend: boolean; name: string; predicates: string[] }

function resolvePrefix(name: string, namespaces: Record<string, string> | undefined): string {
  if (name === '*' || name === '.' || name === '..' || name.startsWith('{')) return name
  const colon = name.indexOf(':')
  if (colon < 0) return name
  const uri = namespaces?.[name.slice(0, colon)]
  if (uri === undefined) throw new SyntaxError(`prefix '${name.slice(0, colon)}' not found in prefix map`)
  return `{${uri}}${name.slice(colon + 1)}`
}

function parsePath(path: string, namespaces: Record<string, string> | undefined): Step[] {
  if (path.startsWith('/')) throw new SyntaxError('cannot use absolute path on element')
  const steps: Step[] = []
  let i = 0
  let descend = false
  while (i < path.length) {
    // a step: name (maybe '{uri}name' or 'prefix:name'), then predicates in brackets
    let j = i
    let depth = 0
    while (j < path.length) {
      const c = path[j]!
      if (c === '[') depth++
      else if (c === ']') depth--
      else if (c === '{' && depth === 0) {
        const close = path.indexOf('}', j)
        if (close < 0) throw new SyntaxError('invalid path')
        j = close
      } else if (c === '/' && depth === 0) break
      j++
    }
    const token = path.slice(i, j)
    const bracket = token.indexOf('[')
    const rawName = bracket < 0 ? token : token.slice(0, bracket)
    const predicates: string[] = []
    if (bracket >= 0) {
      const re = /\[([^\]]*)\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(token.slice(bracket)))) predicates.push(m[1]!)
    }
    steps.push({ descend, name: resolvePrefix(rawName, namespaces), predicates })
    descend = false
    if (j < path.length) {
      // path[j] === '/'
      if (path[j + 1] === '/') {
        descend = true
        j++
      }
      j++
    }
    i = j
  }
  return steps
}

function descendantsOrSelf(el: XmlElement): XmlElement[] {
  return el.iter()
}

function matches(el: XmlElement, predicate: string, index: number, siblings: XmlElement[]): boolean {
  let m: RegExpExecArray | null
  if ((m = /^@([^=\s]+)$/.exec(predicate))) return el.attrib[m[1]!] !== undefined
  if ((m = /^@([^=\s]+)\s*=\s*(?:'([^']*)'|"([^"]*)")$/.exec(predicate))) return el.attrib[m[1]!] === (m[2] ?? m[3])
  if (/^\d+$/.test(predicate)) return index === Number(predicate) - 1
  if (predicate === 'last()') return index === siblings.length - 1
  if ((m = /^([^=\s@]+)$/.exec(predicate))) return el.children.some((c) => c.tag === m![1])
  if ((m = /^([^=\s@]+)\s*=\s*(?:'([^']*)'|"([^"]*)")$/.exec(predicate))) return el.children.some((c) => c.tag === m![1] && (c.text ?? '') === (m![2] ?? m![3]))
  throw new SyntaxError(`invalid predicate: ${predicate}`)
}

function evaluatePath(root: XmlElement, path: string, namespaces: Record<string, string> | undefined): XmlElement[] {
  let current: XmlElement[] = [root]
  for (const step of parsePath(path, namespaces)) {
    const next: XmlElement[] = []
    for (const el of current) {
      const scope = step.descend ? descendantsOrSelf(el) : [el]
      for (const base of scope) {
        let candidates: XmlElement[]
        if (step.name === '.') candidates = [base]
        else if (step.name === '*') candidates = base.children
        else candidates = base.children.filter((c) => c.tag === step.name)
        for (const p of step.predicates) {
          const all = candidates
          candidates = all.filter((c, idx) => matches(c, p, idx, all))
        }
        next.push(...candidates)
      }
    }
    current = next
  }
  return current
}

// ---------------------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------------------

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (_m, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10))
    const v = PREDEFINED[body]
    if (v === undefined) throw new XmlParseError(`undefined entity &${body};`)
    return v
  })
}

/** Bytes → text as an XML parser would: a BOM, else the declaration's encoding, else UTF-8 (strict). */
function decodeBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3))
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  const head = Buffer.from(bytes.subarray(0, 200)).toString('latin1')
  const declared = /^<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]?.toLowerCase()
  let label = declared ?? 'utf-8'
  if (label === 'utf8') label = 'utf-8'
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes)
  } catch {
    throw new XmlParseError(`not well-formed (invalid token) or unsupported encoding ${label}`)
  }
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

type Scope = Record<string, string>

function elementName(qname: string, scope: Scope): string {
  const colon = qname.indexOf(':')
  if (colon < 0) {
    const ns = scope['']
    return ns ? `{${ns}}${qname}` : qname
  }
  const uri = scope[qname.slice(0, colon)]
  if (uri === undefined) throw new XmlParseError(`unbound prefix: ${qname}`)
  return `{${uri}}${qname.slice(colon + 1)}`
}

/** `ET.fromstring` / `defusedxml.ElementTree.parse(...).getroot()`: the document element. */
export function parseElementTree(input: string | Uint8Array): XmlElement {
  const src = typeof input === 'string' ? input : decodeBytes(input)
  const n = src.length
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0
  let root: XmlElement | null = null
  const stack: { el: XmlElement; qname: string; scope: Scope }[] = []
  const rootScope: Scope = Object.create(null) as Scope
  rootScope.xml = XML_NS

  const addText = (raw: string): void => {
    const top = stack[stack.length - 1]
    const text = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw
    if (!top) {
      if (text.trim() !== '') throw new XmlParseError(root ? 'junk after document element' : 'syntax error: text before the document element')
      return
    }
    const last = top.el.children[top.el.children.length - 1]
    if (last) last.tail = (last.tail ?? '') + text
    else top.el.text = (top.el.text ?? '') + text
  }

  while (i < n) {
    if (src.charCodeAt(i) !== 0x3c /* < */) {
      let lt = src.indexOf('<', i)
      if (lt < 0) lt = n
      addText(decodeEntities(src.slice(i, lt)))
      i = lt
      continue
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) throw new XmlParseError('unclosed comment')
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9)
      if (end < 0) throw new XmlParseError('unclosed CDATA section')
      addText(src.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2)
      if (end < 0) throw new XmlParseError('unclosed processing instruction')
      i = end + 2
      continue
    }
    if (src.startsWith('<!', i)) {
      // <!DOCTYPE …> possibly with an internal subset in brackets; defusedxml refuses entity declarations.
      let depth = 0
      let j = i + 2
      for (; j < n; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
        else if (c === '"' || c === "'") {
          const close = src.indexOf(c, j + 1)
          if (close < 0) throw new XmlParseError('unclosed token')
          j = close
        }
      }
      if (j >= n) throw new XmlParseError('unclosed token')
      if (/<!ENTITY/.test(src.slice(i, j))) throw new XmlParseError('Entities are forbidden (entity declaration)')
      i = j + 1
      continue
    }
    if (src.charCodeAt(i + 1) === 0x2f /* / */) {
      const end = src.indexOf('>', i + 2)
      if (end < 0) throw new XmlParseError('unclosed token')
      const qname = src.slice(i + 2, end).trim()
      const top = stack.pop()
      if (!top || top.qname !== qname) throw new XmlParseError(`mismatched tag: </${qname}>`)
      i = end + 1
      continue
    }
    // start tag
    let j = i + 1
    while (j < n && !isSpace(src.charCodeAt(j)) && src[j] !== '/' && src[j] !== '>') j++
    const qname = src.slice(i + 1, j)
    if (!qname) throw new XmlParseError('not well-formed (invalid token)')
    const rawAttrs: [string, string][] = []
    let selfClosing = false
    for (;;) {
      while (j < n && isSpace(src.charCodeAt(j))) j++
      if (j >= n) throw new XmlParseError('unclosed token')
      const c = src[j]
      if (c === '>') {
        j++
        break
      }
      if (c === '/') {
        if (src[j + 1] !== '>') throw new XmlParseError('not well-formed (invalid token)')
        selfClosing = true
        j += 2
        break
      }
      let k = j
      while (k < n && !isSpace(src.charCodeAt(k)) && src[k] !== '=' && src[k] !== '>' && src[k] !== '/') k++
      const name = src.slice(j, k)
      while (k < n && isSpace(src.charCodeAt(k))) k++
      if (src[k] !== '=') throw new XmlParseError('not well-formed (invalid token): attribute without value')
      k++
      while (k < n && isSpace(src.charCodeAt(k))) k++
      const quote = src[k]
      if (quote !== '"' && quote !== "'") throw new XmlParseError('not well-formed (invalid token): unquoted attribute')
      const close = src.indexOf(quote, k + 1)
      if (close < 0) throw new XmlParseError('unclosed token')
      const raw = src.slice(k + 1, close)
      if (raw.includes('<')) throw new XmlParseError('not well-formed (invalid token): < in attribute value')
      // Attribute-value normalisation: line ends, then tabs and newlines become spaces; references are decoded last.
      const value = decodeEntities(raw.replace(/\r\n?/g, '\n').replace(/[\n\t]/g, ' '))
      if (rawAttrs.some(([a]) => a === name)) throw new XmlParseError(`duplicate attribute: ${name}`)
      rawAttrs.push([name, value])
      j = close + 1
    }
    const parentScope = stack.length ? stack[stack.length - 1]!.scope : rootScope
    let scope = parentScope
    if (rawAttrs.some(([a]) => a === 'xmlns' || a.startsWith('xmlns:'))) {
      scope = Object.create(parentScope) as Scope
      for (const [a, v] of rawAttrs) {
        if (a === 'xmlns') scope[''] = v
        else if (a.startsWith('xmlns:')) scope[a.slice(6)] = v
      }
    }
    const attrib: Record<string, string> = {}
    for (const [a, v] of rawAttrs) {
      if (a === 'xmlns' || a.startsWith('xmlns:')) continue
      const colon = a.indexOf(':')
      if (colon < 0) attrib[a] = v
      else {
        const uri = scope[a.slice(0, colon)]
        if (uri === undefined) throw new XmlParseError(`unbound prefix: ${a}`)
        attrib[`{${uri}}${a.slice(colon + 1)}`] = v
      }
    }
    const el = new XmlElement(elementName(qname, scope), attrib)
    const parent = stack[stack.length - 1]
    if (parent) parent.el.children.push(el)
    else if (root) throw new XmlParseError('junk after document element')
    else root = el
    if (!selfClosing) stack.push({ el, qname, scope })
    i = j
  }
  if (stack.length) throw new XmlParseError('no element found: unclosed token')
  if (!root) throw new XmlParseError('no element found')
  return root
}

// ---------------------------------------------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------------------------------------------

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#09;')

/** `ET.tostring(element, encoding='unicode')`: namespaces become ns0, ns1, … declared on the first element; the tail is included. */
export function tostring(element: XmlElement): string {
  const prefixes = new Map<string, string>()
  const known: Record<string, string> = { [XML_NS]: 'xml', 'http://www.w3.org/2001/XMLSchema': 'xs', 'http://www.w3.org/2001/XMLSchema-instance': 'xsi' }
  const prefixFor = (uri: string): string => {
    let p = prefixes.get(uri)
    if (p === undefined) {
      p = known[uri] ?? `ns${[...prefixes.values()].filter((x) => /^ns\d+$/.test(x)).length}`
      prefixes.set(uri, p)
    }
    return p
  }
  const qnameOf = (name: string): string => {
    if (!name.startsWith('{')) return name
    const close = name.indexOf('}')
    return `${prefixFor(name.slice(1, close))}:${name.slice(close + 1)}`
  }
  // First pass: register every namespace in document order, as ElementTree's qnames cache does while serialising.
  const body = (el: XmlElement): string => {
    const tag = qnameOf(el.tag)
    const attrs = Object.entries(el.attrib)
      .map(([k, v]) => ` ${qnameOf(k)}="${escapeAttr(v)}"`)
      .join('')
    let out = `<${tag}${attrs}`
    if (el.text || el.children.length) {
      out += '>' + escapeText(el.text ?? '') + el.children.map(body).join('') + `</${tag}>`
    } else out += ' />'
    return out + escapeText(el.tail ?? '')
  }
  const rendered = body(element)
  const declarations = [...prefixes.entries()]
    .filter(([uri]) => uri !== XML_NS)
    .map(([uri, p]) => ` xmlns:${p}="${escapeAttr(uri)}"`)
    .join('')
  // ElementTree writes the declarations into the first start tag.
  const firstEnd = rendered.search(/[ >/]/)
  return rendered.slice(0, firstEnd) + declarations + rendered.slice(firstEnd)
}
