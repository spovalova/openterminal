// A namespace-aware, well-formedness-checking XML reader that reports what Python's expat does to feedparser: prefix
// mappings, elements as (namespace, local name), attributes, character data. Anything expat rejects throws, which is
// how feedparser decides to fall back to its loose parser. Written for this port from XML 1.0 and Namespaces in XML
// 1.0 and checked against expat: it enforces the rules feeds break (tag nesting, entities, names, attributes,
// characters, one root, one document type) and not the ones they never meet (the document type's grammar,
// standalone documents, encodings).

export class XmlSyntaxError extends Error {}

export type SaxAttribute = { namespace: string | null; local: string; value: string; /** The name as the document writes it, prefix included (expat's qualified name of an attribute). */ qname: string }

export type SaxHandler = {
  startPrefixMapping(prefix: string | null, uri: string): void
  startElementNS(namespace: string | null, local: string, attrs: SaxAttribute[]): void
  characters(text: string): void
  endElementNS(namespace: string | null, local: string): void
}

// The ranges are the specification's, combining marks included.
/* eslint-disable no-misleading-character-class */
const NAME_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}'
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`
const NAME = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy')
const NAME_ONLY = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u')
/* eslint-enable no-misleading-character-class */
const SPACE = /[ \t\n\r]+/y
/** The first character XML 1.0 does not allow (`Char` in the specification), if any. */
const hasInvalidChar = (text: string): boolean => {
  for (const c of text) {
    const code = c.codePointAt(0)!
    if (!(code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) return true
  }
  return false
}
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

function fail(message: string): never {
  throw new XmlSyntaxError(message)
}

function isXmlChar(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
}

/** Parse an XML document, calling the handler as expat's namespace mode would. */
export function parseXml(input: string, handler: SaxHandler, declaredEntities: Record<string, string> = {}): void {
  // Line ends are normalised before anything else: \r\n and \r become \n.
  const data = input.replace(/\r\n?/g, '\n')
  const n = data.length
  let i = 0
  let seenRoot = false
  let seenDoctype = false
  let rootClosed = false
  const stack: { qname: string; namespace: string | null; local: string }[] = []
  // Namespace scopes: the bindings in force at each depth.
  const scopes: Map<string, string>[] = [new Map([['xml', XML_NAMESPACE]])]
  const entities = new Map<string, string>(Object.entries(declaredEntities))

  const matchAt = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = i
    return re.exec(data)
  }
  const skipSpace = (): void => {
    const m = matchAt(SPACE)
    if (m) i += m[0].length
  }
  const readName = (): string => {
    const m = matchAt(NAME)
    if (!m) fail(`not well-formed (invalid token) at ${i}`)
    i += m[0].length
    return m[0]
  }
  const checkChars = (text: string): void => {
    if (hasInvalidChar(text)) fail('not well-formed (invalid token)')
  }

  /** A reference starting at `&` (data[i]): the text it stands for. */
  const readReference = (): string => {
    const end = data.indexOf(';', i)
    if (end < 0) fail('unterminated entity reference')
    const body = data.slice(i + 1, end)
    i = end + 1
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? (/^[0-9a-fA-F]+$/.test(body.slice(2)) ? parseInt(body.slice(2), 16) : NaN) : /^[0-9]+$/.test(body.slice(1)) ? parseInt(body.slice(1), 10) : NaN
      if (Number.isNaN(code) || !isXmlChar(code)) fail('reference to invalid character number')
      return String.fromCodePoint(code)
    }
    if (!NAME_ONLY.test(body)) fail('not well-formed (invalid token)')
    if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body]!
    if (entities.has(body)) return entities.get(body)!
    return fail('undefined entity')
  }

  const readText = (until: (c: string) => boolean, attribute = false): string => {
    // Text up to a character `until` stops at; references are replaced.
    let out = ''
    for (;;) {
      let j = i
      while (j < n && !until(data[j]!) && data[j] !== '&') j++
      const chunk = data.slice(i, j)
      checkChars(chunk)
      // The sequence ]]> is only the end of a CDATA section; in character data it is not well-formed.
      if (!attribute && chunk.includes(']]>')) fail('not well-formed (invalid token)')
      // Attribute-value normalisation: literal tabs and line ends are spaces (character references are not).
      out += attribute ? chunk.replace(/[\t\n]/g, ' ') : chunk
      i = j
      if (i >= n || until(data[i]!)) return out
      out += readReference()
    }
  }

  const splitQName = (qname: string): [string | null, string] => {
    const parts = qname.split(':')
    if (parts.length === 1) return [null, qname]
    if (parts.length !== 2 || !parts[0] || !parts[1]) fail('not well-formed (invalid token)')
    return [parts[0], parts[1]]
  }

  const lookup = (prefix: string | null): string | null => {
    const key = prefix ?? ''
    for (let s = scopes.length - 1; s >= 0; s--) {
      const found = scopes[s]!.get(key)
      if (found !== undefined) return found || null
    }
    return null
  }

  // ---- the prolog ----
  if (data.startsWith('<?xml') && /^<\?xml[ \t\n]/.test(data)) {
    const end = data.indexOf('?>')
    if (end < 0) fail('unclosed token')
    i = end + 2
  }

  const readDoctype = (): void => {
    // <!DOCTYPE name externalID? [ internal subset ]? >
    i += '<!DOCTYPE'.length
    let depth = 0
    while (i < n) {
      const c = data[i]!
      if (c === '"' || c === "'") {
        const close = data.indexOf(c, i + 1)
        if (close < 0) fail('unclosed token')
        i = close + 1
      } else if (c === '[') {
        depth++
        i++
        // The internal subset: declarations, comments and processing instructions.
        while (i < n && depth > 0) {
          skipSpace()
          if (data.startsWith('<!ENTITY', i)) {
            i += '<!ENTITY'.length
            skipSpace()
            if (data[i] === '%') fail('parameter entities are not supported')
            const name = readName()
            skipSpace()
            const quote = data[i]
            if (quote === '"' || quote === "'") {
              const close = data.indexOf(quote, i + 1)
              if (close < 0) fail('unclosed token')
              const value = data.slice(i + 1, close)
              if (!entities.has(name)) entities.set(name, value.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (_m, ref: string) => String.fromCodePoint(ref[0] === 'x' ? parseInt(ref.slice(1), 16) : parseInt(ref, 10))))
              i = close + 1
            }
            const end = data.indexOf('>', i)
            if (end < 0) fail('unclosed token')
            i = end + 1
          } else if (data.startsWith('<!--', i)) {
            const end = data.indexOf('-->', i + 4)
            if (end < 0) fail('unclosed token')
            i = end + 3
          } else if (data.startsWith('<?', i)) {
            const end = data.indexOf('?>', i + 2)
            if (end < 0) fail('unclosed token')
            i = end + 2
          } else if (data.startsWith('<!', i)) {
            // Any other declaration: skip to its closing '>' outside quotes.
            i += 2
            while (i < n && data[i] !== '>') {
              if (data[i] === '"' || data[i] === "'") {
                const close = data.indexOf(data[i]!, i + 1)
                if (close < 0) fail('unclosed token')
                i = close
              }
              i++
            }
            i++
          } else if (data[i] === ']') {
            depth--
            i++
          } else fail('not well-formed (invalid token)')
        }
      } else if (c === '>') {
        i++
        return
      } else i++
    }
    fail('unclosed token')
  }

  const readComment = (): void => {
    const end = data.indexOf('-->', i + 4)
    if (end < 0) fail('unclosed token')
    const body = data.slice(i + 4, end)
    if (body.includes('--') || body.endsWith('-')) fail('not well-formed (invalid token)')
    checkChars(body)
    i = end + 3
  }

  const readPi = (): void => {
    const end = data.indexOf('?>', i + 2)
    if (end < 0) fail('unclosed token')
    // The target is a name, followed by space or the end of the instruction.
    const target = /^[^\s?]+/.exec(data.slice(i + 2, end))?.[0] ?? ''
    const after = data.slice(i + 2 + target.length, i + 4 + target.length)
    if (!NAME_ONLY.test(target) || target.includes(':') || !(/^[ \t\n\r]/.test(after) || after === '?>')) fail('not well-formed (invalid token)')
    if (target.toLowerCase() === 'xml') fail('XML or text declaration not at start of entity')
    checkChars(data.slice(i + 2, end))
    i = end + 2
  }

  // ---- the document ----
  while (i < n) {
    if (stack.length === 0) {
      // Outside the root element: only space, comments, processing instructions and the document type.
      skipSpace()
      if (i >= n) break
      if (data.startsWith('<!--', i)) {
        readComment()
        continue
      }
      if (data.startsWith('<?', i)) {
        readPi()
        continue
      }
      if (data.startsWith('<!DOCTYPE', i) && !seenRoot) {
        // There may be only one document type declaration.
        if (seenDoctype) fail('syntax error')
        seenDoctype = true
        readDoctype()
        continue
      }
      if (data[i] !== '<' || !/[^/!?]/.test(data[i + 1] ?? '')) fail(rootClosed ? 'junk after document element' : 'syntax error')
    } else if (data[i] !== '<') {
      const text = readText((c) => c === '<')
      if (text) handler.characters(text)
      continue
    }

    if (data.startsWith('</', i)) {
      i += 2
      const qname = readName()
      skipSpace()
      if (data[i] !== '>') fail('not well-formed (invalid token)')
      i++
      const top = stack.pop()
      if (!top || top.qname !== qname) fail('mismatched tag')
      handler.endElementNS(top.namespace, top.local)
      scopes.pop()
      if (stack.length === 0) rootClosed = true
    } else if (data.startsWith('<!--', i)) readComment()
    else if (data.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) fail('syntax error')
      const end = data.indexOf(']]>', i + 9)
      if (end < 0) fail('unclosed CDATA section')
      const text = data.slice(i + 9, end)
      checkChars(text)
      if (text) handler.characters(text)
      i = end + 3
    } else if (data.startsWith('<?', i)) readPi()
    else if (data[i] === '<') {
      // A start tag.
      i++
      const qname = readName()
      const rawAttrs: { name: string; value: string }[] = []
      let selfClosing = false
      for (;;) {
        const before = i
        skipSpace()
        if (data[i] === '>') {
          i++
          break
        }
        if (data[i] === '/' && data[i + 1] === '>') {
          selfClosing = true
          i += 2
          break
        }
        if (i === before) fail('not well-formed (invalid token)')
        const name = readName()
        skipSpace()
        if (data[i] !== '=') fail('not well-formed (invalid token)')
        i++
        skipSpace()
        const quote = data[i]
        if (quote !== '"' && quote !== "'") fail('not well-formed (invalid token)')
        i++
        const value = readText((c) => c === quote || c === '<', true)
        if (data[i] !== quote) fail(i >= n ? 'unclosed token' : 'not well-formed (invalid token)')
        i++
        if (rawAttrs.some((a) => a.name === name)) fail('duplicate attribute')
        rawAttrs.push({ name, value })
      }
      if (rootClosed) fail('junk after document element')
      seenRoot = true

      // Declarations first, then the names they bind.
      const scope = new Map<string, string>()
      scopes.push(scope)
      const mappings: [string | null, string][] = []
      const plain: { name: string; value: string }[] = []
      for (const a of rawAttrs) {
        // expat joins a namespace to a name with a space, so a namespace that has one in it is refused.
        if ((a.name === 'xmlns' || a.name.startsWith('xmlns:')) && a.value.includes(' ')) fail('syntax error')
        if (a.name === 'xmlns') {
          scope.set('', a.value)
          mappings.push([null, a.value])
        } else if (a.name.startsWith('xmlns:')) {
          const prefix = a.name.slice(6)
          if (!prefix || prefix === 'xmlns' || (prefix === 'xml' && a.value !== XML_NAMESPACE) || !a.value) fail('reserved or empty namespace declaration')
          scope.set(prefix, a.value)
          mappings.push([prefix, a.value])
        } else plain.push(a)
      }
      for (const [prefix, uri] of mappings) handler.startPrefixMapping(prefix, uri)

      const [prefix, local] = splitQName(qname)
      let namespace: string | null
      if (prefix === null) namespace = lookup(null)
      else {
        namespace = lookup(prefix)
        if (namespace === null) fail('unbound prefix')
      }
      const seen = new Set<string>()
      const attrs: SaxAttribute[] = plain.map((a) => {
        const [aPrefix, aLocal] = splitQName(a.name)
        let aNamespace: string | null = null
        if (aPrefix !== null) {
          aNamespace = lookup(aPrefix)
          if (aNamespace === null) fail('unbound prefix')
        }
        const key = `${aNamespace ?? ''}\u0000${aLocal}`
        if (seen.has(key)) fail('duplicate attribute')
        seen.add(key)
        return { namespace: aNamespace, local: aLocal, value: a.value, qname: a.name }
      })
      handler.startElementNS(namespace, local, attrs)
      if (selfClosing) {
        handler.endElementNS(namespace, local)
        scopes.pop()
        if (stack.length === 0) rootClosed = true
      } else stack.push({ qname, namespace, local })
    } else fail('syntax error')
  }
  if (stack.length > 0) fail('no element found')
  if (!seenRoot) fail('no element found')
}
