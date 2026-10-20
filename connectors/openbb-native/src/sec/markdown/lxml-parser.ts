// lxml mode of the Beautiful Soup emulation: what `BeautifulSoup(markup, "lxml")` builds from an HTML string with
// lxml 6.1 / libxml2 2.14. libxml2 2.14 tokenizes HTML the HTML5 way (character references, comments, bogus comments,
// raw text, script data states) and then builds the tree with its own, older, rules: implied html / head / body, the
// `htmlStartClose` table (an opening tag closes the open tag it is listed against), end-tag priorities, void elements,
// `<x/>` closing x at once, no implied <p>. The tables below were measured against the installed lxml.
import { HTML5_ENTITIES } from './entities.js'
import { BeautifulSoup, hasOwn, makeString } from './soup.js'

// ---------------------------------------------------------------------------------------------------------------
// Tables (measured)
// ---------------------------------------------------------------------------------------------------------------

/** `htmlStartClose`: open element → the tags whose start closes it. */
const START_CLOSE: Record<string, Set<string>> = {
  a: new Set(['a', 'fieldset', 'table', 'td', 'th']),
  address: new Set(['dd', 'dl', 'dt', 'form', 'li', 'ul']),
  b: new Set(['center', 'p', 'td', 'th']),
  big: new Set(['p']),
  caption: new Set(['col', 'colgroup', 'tbody', 'tfoot', 'thead', 'tr']),
  colgroup: new Set(['colgroup', 'tbody', 'tfoot', 'thead', 'tr']),
  dd: new Set(['dt']),
  dir: new Set(['dd', 'dl', 'dt', 'form', 'ul']),
  dl: new Set(['form', 'li']),
  dt: new Set(['dd', 'dl']),
  font: new Set(['center', 'td', 'th']),
  form: new Set(['form']),
  h1: new Set(['fieldset', 'form', 'li', 'p', 'table']),
  h2: new Set(['fieldset', 'form', 'li', 'p', 'table']),
  h3: new Set(['fieldset', 'form', 'li', 'p', 'table']),
  h4: new Set(['fieldset', 'form', 'li', 'p', 'table']),
  h5: new Set(['fieldset', 'form', 'li', 'p', 'table']),
  h6: new Set(['fieldset', 'form', 'li', 'p', 'table']),
  i: new Set(['center', 'p', 'td', 'th']),
  legend: new Set(['fieldset']),
  li: new Set(['li']),
  menu: new Set(['dd', 'dl', 'dt', 'form', 'ul']),
  ol: new Set(['form']),
  option: new Set(['optgroup', 'option']),
  p: new Set(['address', 'blockquote', 'caption', 'center', 'col', 'colgroup', 'dd', 'dir', 'div', 'dl', 'dt', 'fieldset', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'menu', 'ol', 'p', 'pre', 'table', 'tbody', 'td', 'tfoot', 'th', 'tr', 'ul', 'title', 'head', 'frameset', 'body']),
  pre: new Set(['dd', 'dl', 'dt', 'fieldset', 'form', 'li', 'table', 'ul']),
  s: new Set(['p']),
  small: new Set(['p']),
  span: new Set(['td', 'th']),
  strike: new Set(['p']),
  tbody: new Set(['tbody', 'tfoot']),
  td: new Set(['tbody', 'td', 'tfoot', 'th', 'tr']),
  tfoot: new Set(['tbody']),
  th: new Set(['tbody', 'td', 'tfoot', 'th', 'tr']),
  thead: new Set(['tbody', 'tfoot']),
  tr: new Set(['tbody', 'tfoot', 'tr']),
  tt: new Set(['p']),
  u: new Set(['p', 'td', 'th']),
  ul: new Set(['address', 'form', 'menu', 'pre']),
  // head is closed by the tags that cannot live in it (anything not listed in HEAD_KEEPS opens the body).
}

/** Tags that stay inside an open <head> (they do not close it). */
const HEAD_KEEPS = new Set([
  'applet', 'base', 'basefont', 'button', 'caption', 'col', 'colgroup', 'del', 'embed', 'input', 'ins', 'label', 'legend', 'link', 'meta', 'noframes', 'noscript', 'object', 'optgroup', 'option', 'param', 'select', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'script', 'style', 'title', 'area', 'frame', 'isindex',
])
/** Tags libxml2 knows (html40ElementTable plus the ones above): an unknown tag does not close <head>. */
const KNOWN_TAGS = new Set([
  'a', 'abbr', 'acronym', 'address', 'applet', 'area', 'b', 'base', 'basefont', 'bdo', 'big', 'blockquote', 'body', 'br', 'button', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'dfn', 'dir', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'font', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'isindex', 'kbd', 'label', 'legend', 'li', 'link', 'map', 'menu', 'meta', 'noframes', 'noscript', 'object', 'ol', 'optgroup', 'option', 'p', 'param', 'pre', 'q', 's', 'samp', 'script', 'select', 'small', 'span', 'strike', 'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'tt', 'u', 'ul', 'var', 'xmp', 'listing',
])

/** Elements that never have children. */
const VOID_TAGS = new Set(['area', 'base', 'basefont', 'br', 'col', 'frame', 'hr', 'img', 'input', 'isindex', 'link', 'meta', 'param'])

/** `htmlEndPriority`: an end tag only closes open elements of lower or equal priority. */
const END_PRIORITY: Record<string, number> = { div: 150, td: 160, th: 160, tr: 170, thead: 180, tbody: 180, tfoot: 180, table: 190, head: 200, body: 200, html: 220 }
const endPriority = (name: string): number => (hasOwn(END_PRIORITY, name) ? END_PRIORITY[name]! : 100)

function startCloses(open: string, tag: string): boolean {
  if (open === 'head') return KNOWN_TAGS.has(tag) && !HEAD_KEEPS.has(tag) && tag !== 'html' && tag !== 'head'
  const set = hasOwn(START_CLOSE, open) ? START_CLOSE[open] : undefined
  return set ? set.has(tag) : false
}

// ---------------------------------------------------------------------------------------------------------------
// Tokenizer: the HTML5 states, emitting to a sink
// ---------------------------------------------------------------------------------------------------------------

type Sink = {
  text(data: string): void
  startTag(name: string, attrs: [string, string][], selfClosing: boolean): void
  endTag(name: string): void
  comment(data: string, kind: 'comment' | 'pi' | 'bogus'): void
  /** A "</>" the tokenizer ignored: the parser has left its prolog. */
  contentStarted(): void
  /** A "<" that starts no tag, about to be emitted as text. */
  strayLt(): void
  doctype(name: string, publicId: string | null, systemId: string | null): void
  /** A start tag cut off by the end of the input. */
  eofStart(name: string): void
}

const isAsciiAlpha = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
const isAsciiAlnum = (c: string): boolean => isAsciiAlpha(c) || (c >= '0' && c <= '9')
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f'

const RAWTEXT_TAGS = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes'])
const RCDATA_TAGS = new Set(['textarea', 'title'])

const C1: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
}

function numericReference(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
  if (code >= 0x80 && code <= 0x9f && hasOwn(C1, String(code))) return String.fromCodePoint(C1[code]!)
  return String.fromCodePoint(code)
}

class Tokenizer {
  private pos = 0
  private text: string[] = []
  private lastStartTag = ''

  constructor(
    private s: string,
    private sink: Sink,
  ) {}

  private flushText(): void {
    if (this.text.length) {
      this.sink.text(this.text.join(''))
      this.text = []
    }
  }

  private emitStart(name: string, attrs: [string, string][], selfClosing: boolean): void {
    this.flushText()
    this.lastStartTag = name
    this.sink.startTag(name, attrs, selfClosing)
  }

  private emitEnd(name: string): void {
    this.flushText()
    this.sink.endTag(name)
  }

  private emitComment(data: string, kind: 'comment' | 'pi' | 'bogus'): void {
    this.flushText()
    this.sink.comment(data, kind)
  }

  /** Character reference after `&` at `pos - 1` (HTML5 "consume a character reference"); returns the text it stands for. */
  private charRef(inAttr: boolean): string {
    const s = this.s
    let i = this.pos // just after '&'
    const c = s[i]
    if (c === '#') {
      i++
      let hex = false
      if (s[i] === 'x' || s[i] === 'X') {
        hex = true
        i++
      }
      const start = i
      while (i < s.length && (hex ? /[0-9a-fA-F]/.test(s[i]!) : s[i]! >= '0' && s[i]! <= '9')) i++
      if (i === start) return '&' // no digits: "&#" stays text; the "#" is read again as text
      let code = parseInt(s.slice(start, i), hex ? 16 : 10)
      if (!Number.isFinite(code) || code > 0x10ffff) code = 0x110000
      if (s[i] === ';') i++
      this.pos = i
      return numericReference(code)
    }
    if (c === undefined || !isAsciiAlnum(c)) return '&'
    // Named: the longest key of the table that is a prefix of what follows.
    const window = s.slice(i, i + 33)
    for (let len = Math.min(window.length, 32 + 1); len >= 1; len--) {
      const candidate = window.slice(0, len)
      if (hasOwn(HTML5_ENTITIES, candidate)) {
        if (inAttr && !candidate.endsWith(';')) {
          const next = s[i + len]
          if (next !== undefined && (next === '=' || isAsciiAlnum(next))) return '&'
        }
        this.pos = i + len
        return HTML5_ENTITIES[candidate]!
      }
    }
    return '&'
  }

  run(): void {
    const s = this.s
    const n = s.length
    while (this.pos < n) {
      // --- data state ---
      const ch = s[this.pos]!
      if (ch === '<') {
        this.tagOpen()
      } else if (ch === '&') {
        this.pos++
        this.text.push(this.charRef(false))
      } else if (ch === '\0') {
        this.pos++
        this.text.push('�')
      } else {
        // a run of ordinary characters
        let j = this.pos + 1
        while (j < n) {
          const cj = s.charCodeAt(j)
          if (cj === 60 || cj === 38 || cj === 0) break
          j++
        }
        this.text.push(s.slice(this.pos, j))
        this.pos = j
      }
    }
    this.flushText()
  }

  private tagOpen(): void {
    const s = this.s
    const n = s.length
    // s[pos] === '<'
    const c = s[this.pos + 1]
    if (c === undefined) {
      this.pos++
      this.strayLt('<')
      return
    }
    if (c === '!') {
      this.pos += 2
      this.markupDeclaration()
      return
    }
    if (c === '/') {
      const d = s[this.pos + 2]
      if (d === undefined) {
        this.pos = n
        this.strayLt('</')
        return
      }
      if (isAsciiAlpha(d)) {
        this.pos += 2
        this.tag(true)
        return
      }
      if (d === '>') {
        this.pos += 3
        this.flushText()
        this.sink.contentStarted()
        return
      }
      this.pos += 2
      this.bogusComment('bogus')
      return
    }
    if (isAsciiAlpha(c)) {
      this.pos++
      this.tag(false)
      return
    }
    if (c === '?') {
      this.pos++
      this.bogusComment('pi')
      return
    }
    this.pos++
    this.strayLt('<')
  }

  private strayLt(data: string): void {
    this.flushText()
    this.sink.strayLt()
    this.text.push(data)
  }

  /** From the first character of the name; parses the whole tag and emits it. */
  private tag(isEnd: boolean): void {
    const s = this.s
    const n = s.length
    let i = this.pos
    // tag name
    const nameStart = i
    while (i < n) {
      const c = s[i]!
      if (isWs(c) || c === '/' || c === '>') break
      i++
    }
    let name = s.slice(nameStart, i).toLowerCase()
    if (name.includes('\0')) name = name.replaceAll('\0', '�')
    const attrs: [string, string][] = []
    const seen = new Set<string>()
    let selfClosing = false
    // attributes
    for (;;) {
      // before attribute name
      while (i < n && isWs(s[i]!)) i++
      if (i >= n) {
        this.eofInTag(name, isEnd)
        return
      }
      const c = s[i]!
      if (c === '>') {
        i++
        break
      }
      if (c === '/') {
        i++
        if (s[i] === '>') {
          selfClosing = true
          i++
          break
        }
        if (i >= n) {
          this.eofInTag(name, isEnd)
          return
        }
        continue
      }
      // attribute name (a leading '=' belongs to the name)
      const as = i
      i++
      while (i < n) {
        const d = s[i]!
        if (isWs(d) || d === '/' || d === '>' || d === '=') break
        i++
      }
      let attrName = s.slice(as, i).toLowerCase()
      if (attrName.includes('\0')) attrName = attrName.replaceAll('\0', '�')
      // after attribute name
      while (i < n && isWs(s[i]!)) i++
      let value = ''
      if (s[i] === '=') {
        i++
        while (i < n && isWs(s[i]!)) i++
        const q = s[i]
        if (q === '"' || q === "'") {
          i++
          const parts: string[] = []
          let start = i
          for (;;) {
            if (i >= n) {
              this.eofInTag(name, isEnd)
              return
            }
            const d = s[i]!
            if (d === q) break
            if (d === '&') {
              parts.push(s.slice(start, i))
              this.pos = i + 1
              parts.push(this.charRef(true))
              i = this.pos
              start = i
            } else if (d === '\0') {
              parts.push(s.slice(start, i), '�')
              i++
              start = i
            } else i++
          }
          parts.push(s.slice(start, i))
          i++ // closing quote
          value = parts.join('')
        } else if (q === '>') {
          // missing value
        } else {
          const parts: string[] = []
          let start = i
          while (i < n) {
            const d = s[i]!
            if (isWs(d) || d === '>') break
            if (d === '&') {
              parts.push(s.slice(start, i))
              this.pos = i + 1
              parts.push(this.charRef(true))
              i = this.pos
              start = i
            } else if (d === '\0') {
              parts.push(s.slice(start, i), '�')
              i++
              start = i
            } else i++
          }
          parts.push(s.slice(start, i))
          value = parts.join('')
        }
      }
      if (!seen.has(attrName)) {
        seen.add(attrName)
        attrs.push([attrName, value])
      }
    }
    this.pos = i
    if (isEnd) {
      this.emitEnd(name)
      return
    }
    this.emitStart(name, attrs, selfClosing)
    if (selfClosing) return
    if (name === 'script') this.scriptData()
    else if (RAWTEXT_TAGS.has(name)) this.rawText(false)
    else if (RCDATA_TAGS.has(name)) this.rawText(true)
    else if (name === 'plaintext') {
      this.text.push(this.s.slice(this.pos))
      this.pos = this.s.length
    }
  }

  /** The input ended inside a tag: the tag is dropped, but libxml2 has already made room for a start tag. */
  private eofInTag(name: string, isEnd: boolean): void {
    this.pos = this.s.length
    this.flushText()
    if (!isEnd) this.sink.eofStart(name)
  }

  /** RAWTEXT / RCDATA content up to the appropriate end tag. */
  private rawText(rcdata: boolean): void {
    const s = this.s
    const n = s.length
    const name = this.lastStartTag
    for (;;) {
      if (this.pos >= n) return
      const c = s[this.pos]!
      if (c === '<' && s[this.pos + 1] === '/' && this.appropriateEnd(this.pos + 2, name)) {
        this.pos += 2 // end tag name follows; the normal tag parser takes it
        this.tag(true)
        return
      }
      if (c === '&' && rcdata) {
        this.pos++
        this.text.push(this.charRef(false))
      } else if (c === '\0') {
        this.pos++
        this.text.push('�')
      } else {
        let j = this.pos + 1
        while (j < n) {
          const cj = s.charCodeAt(j)
          if (cj === 60 || cj === 0 || (rcdata && cj === 38)) break
          j++
        }
        this.text.push(s.slice(this.pos, j))
        this.pos = j
      }
    }
  }

  /** Is there an end tag for `name` at `at` (just after "</"), followed by whitespace, "/" or ">"? */
  private appropriateEnd(at: number, name: string): boolean {
    const s = this.s
    if (s.slice(at, at + name.length).toLowerCase() !== name) return false
    const next = s[at + name.length]
    return next !== undefined && (isWs(next) || next === '/' || next === '>')
  }

  /** Script data, with the escaped and double escaped states. */
  private scriptData(): void {
    const s = this.s
    const n = s.length
    type St = 'data' | 'escaped' | 'double'
    let st: St = 'data'
    const emit = (str: string): void => {
      this.text.push(str)
    }
    while (this.pos < n) {
      const c = s[this.pos]!
      if (c === '\0') {
        emit('�')
        this.pos++
        continue
      }
      if (st === 'data') {
        if (c === '<') {
          if (s[this.pos + 1] === '/' && this.appropriateEnd(this.pos + 2, 'script')) {
            this.pos += 2
            this.tag(true)
            return
          }
          if (s.startsWith('<!--', this.pos)) {
            emit('<!--')
            this.pos += 4
            st = 'escaped'
            // "<!--" is the escaped dash dash state: a ">" right after it leaves the escape at once
            if (s[this.pos] === '>') {
              emit('>')
              this.pos++
              st = 'data'
            }
            continue
          }
          emit('<')
          this.pos++
          continue
        }
        emit(c)
        this.pos++
        continue
      }
      if (st === 'escaped') {
        if (c === '-' && s.startsWith('-->', this.pos)) {
          emit('-->')
          this.pos += 3
          st = 'data'
          continue
        }
        if (c === '<') {
          if (s[this.pos + 1] === '/') {
            if (this.appropriateEnd(this.pos + 2, 'script')) {
              this.pos += 2
              this.tag(true)
              return
            }
            emit('</')
            this.pos += 2
            continue
          }
          // "<script" followed by whitespace, "/" or ">" starts the double escape
          const m = /^<script(?=[\t\n\f />])/i.exec(s.slice(this.pos, this.pos + 9))
          if (m) {
            emit(s.slice(this.pos, this.pos + 7))
            this.pos += 7
            st = 'double'
            continue
          }
          emit('<')
          this.pos++
          continue
        }
        emit(c)
        this.pos++
        continue
      }
      // double escaped
      if (c === '-' && s.startsWith('-->', this.pos)) {
        emit('-->')
        this.pos += 3
        st = 'data'
        continue
      }
      if (c === '<' && s[this.pos + 1] === '/') {
        const m = /^<\/script(?=[\t\n\f />])/i.exec(s.slice(this.pos, this.pos + 10))
        if (m) {
          emit(s.slice(this.pos, this.pos + 8))
          this.pos += 8
          st = 'escaped'
          continue
        }
      }
      emit(c)
      this.pos++
    }
  }

  private bogusComment(kind: 'pi' | 'bogus'): void {
    const s = this.s
    const j = s.indexOf('>', this.pos)
    if (j < 0) {
      this.emitComment(s.slice(this.pos).replaceAll('\0', '\ufffd'), kind)
      this.pos = s.length
    } else {
      this.emitComment(s.slice(this.pos, j).replaceAll('\0', '\ufffd'), kind)
      this.pos = j + 1
    }
  }

  /** After "<!". */
  private markupDeclaration(): void {
    const s = this.s
    if (s.startsWith('--', this.pos)) {
      this.pos += 2
      this.comment()
      return
    }
    if (/^doctype/i.test(s.slice(this.pos, this.pos + 7))) {
      this.pos += 7
      this.doctype()
      return
    }
    // "[CDATA[" outside foreign content and anything else: a bogus comment from here
    this.bogusComment('bogus')
  }

  /** The comment states of the HTML5 tokenizer, after "<!--". */
  private comment(): void {
    const s = this.s
    let i = this.pos
    let data = ''
    type St = 'start' | 'c' | 'lt' | 'ltbang' | 'ltbangdash' | 'ltbangdashdash' | 'cdash' | 'cend' | 'cbang'
    let st: St = 'start'
    const done = (): void => {
      this.pos = i
      this.emitComment(data.replaceAll('\0', '\ufffd'), 'comment')
    }
    for (;;) {
      const ch = s[i]
      switch (st) {
        case 'start': // comment start, comment start dash
          if (ch === '-') {
            i++
            const d = s[i]
            if (d === '-') {
              i++
              st = 'cend'
            } else if (d === '>') {
              i++
              return done()
            } else if (d === undefined) return done()
            else {
              data += '-'
              st = 'c'
            }
          } else if (ch === '>') {
            i++
            return done()
          } else st = 'c'
          break
        case 'c':
          if (ch === undefined) return done()
          i++
          if (ch === '<') {
            data += '<'
            st = 'lt'
          } else if (ch === '-') st = 'cdash'
          else data += ch
          break
        case 'lt':
          if (ch === '!') {
            data += '!'
            i++
            st = 'ltbang'
          } else if (ch === '<') {
            data += '<'
            i++
          } else st = 'c'
          break
        case 'ltbang':
          if (ch === '-') {
            i++
            st = 'ltbangdash'
          } else st = 'c'
          break
        case 'ltbangdash':
          if (ch === '-') {
            i++
            st = 'ltbangdashdash'
          } else st = 'cdash'
          break
        case 'ltbangdashdash':
          st = 'cend'
          break
        case 'cdash':
          if (ch === '-') {
            i++
            st = 'cend'
          } else if (ch === undefined) return done()
          else {
            data += '-'
            st = 'c'
          }
          break
        case 'cend':
          if (ch === '>') {
            i++
            return done()
          }
          if (ch === '!') {
            i++
            st = 'cbang'
          } else if (ch === '-') {
            data += '-'
            i++
          } else if (ch === undefined) return done()
          else {
            data += '--'
            st = 'c'
          }
          break
        case 'cbang':
          if (ch === '-') {
            data += '--!'
            i++
            st = 'cdash'
          } else if (ch === '>') {
            i++
            return done()
          } else if (ch === undefined) return done()
          else {
            data += '--!'
            st = 'c'
          }
          break
      }
    }
  }

  /** DOCTYPE states after "<!DOCTYPE": name, then optional PUBLIC / SYSTEM identifiers. */
  private doctype(): void {
    const s = this.s
    const j = s.indexOf('>', this.pos)
    const body = j < 0 ? s.slice(this.pos) : s.slice(this.pos, j)
    this.pos = j < 0 ? s.length : j + 1
    const m = /^\s*([^\s>]*)\s*(?:(PUBLIC|SYSTEM)\s*(?:"([^"]*)"|'([^']*)')?\s*(?:"([^"]*)"|'([^']*)')?)?/i.exec(body)
    const name = m?.[1] ?? ''
    const kind = m?.[2]?.toUpperCase()
    let pub: string | null = null
    let sys: string | null = null
    if (kind === 'PUBLIC') {
      pub = m?.[3] ?? m?.[4] ?? null
      sys = m?.[5] ?? m?.[6] ?? null
    } else if (kind === 'SYSTEM') {
      sys = m?.[3] ?? m?.[4] ?? null
    }
    this.flushText()
    this.sink.doctype(name, pub, sys)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tree builder: libxml2's HTML parser rules, emitting bs4 events
// ---------------------------------------------------------------------------------------------------------------

class LibxmlBuilder implements Sink {
  /** libxml2's `nameTab`. */
  private stack: string[] = []
  /** `ctxt->html`: 3 once a head was seen, 10 once a body was. */
  private state = 0
  private depth = 0
  private rootSeen = false
  /** Before the first tag or text: only comments, processing instructions and a doctype have been seen. */
  private prolog = true

  constructor(private soup: BeautifulSoup) {}

  private get cur(): string | undefined {
    return this.stack[this.stack.length - 1]
  }

  private push(name: string, attrs: [string, string][]): void {
    this.rootSeen = true
    if (this.state < 3 && name === 'head') this.state = 3
    if (this.state < 10 && name === 'body') this.state = 10
    this.stack.push(name)
    this.soup.handleStartTag(name, attrs)
  }

  private pop(): void {
    const name = this.stack.pop()!
    this.soup.handleEndTag(name)
  }

  /** `htmlAutoClose`: while the open element is closed by `tag`, close it. */
  private autoClose(tag: string): void {
    while (this.stack.length && startCloses(this.cur!, tag)) this.pop()
  }

  /** `htmlCheckImplied`: the html / head / body an element needs. */
  private checkImplied(tag: string): void {
    if (tag === 'html') return
    if (this.stack.length === 0) this.push('html', [])
    if (tag === 'body' || tag === 'head') return
    if (this.stack.length <= 1 && (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link' || tag === 'title' || tag === 'base')) {
      if (this.state >= 3) return // we already saw or generated a <head> before
      this.push('head', [])
    } else if (tag !== 'noframes' && tag !== 'frame' && tag !== 'frameset') {
      if (this.state >= 10) return // we already saw or generated a <body> before
      if (this.stack.includes('body') || this.stack.includes('head')) return
      this.push('body', [])
    }
  }

  text(data: string): void {
    if (!data) return
    const cur = this.cur
    if (cur === undefined || cur === 'html' || cur === 'head') {
      // Outside the body the leading blanks of a run are separate data: ignored while the document has not started
      // (the parser skips blanks before the first tag), otherwise kept where they are, before any implied element.
      const lead = /^[ \t\n\r]*/.exec(data)![0]
      if (lead) {
        if (!(this.stack.length === 0 && this.prolog)) this.soup.handleData(lead)
        data = data.slice(lead.length)
      }
      if (!data) return
      this.prolog = false
      // htmlCheckParagraph, without the <p> this libxml2 no longer inserts
      this.autoClose('p')
      this.checkImplied('p')
    }
    this.prolog = false
    this.soup.handleData(data)
  }

  startTag(name: string, attrs: [string, string][], selfClosing: boolean): void {
    this.prolog = false
    this.autoClose(name)
    this.checkImplied(name)
    let discard = false
    if (this.stack.length > 0 && name === 'html') {
      discard = true
      this.depth++
    }
    if (this.stack.length !== 1 && name === 'head') {
      discard = true
      this.depth++
    }
    if (name === 'body' && this.stack.includes('body')) {
      discard = true
      this.depth++
    }
    if (discard) {
      // A discarded tag written "<html/>" still ends the element that is open.
      if (selfClosing && this.stack.length > 0) this.pop()
      return
    }
    this.push(name, attrs)
    if (VOID_TAGS.has(name) || selfClosing) this.pop()
  }

  eofStart(name: string): void {
    this.prolog = false
    this.autoClose(name)
    this.checkImplied(name)
  }

  endTag(name: string): void {
    this.prolog = false
    // misplaced html / head / body tags were discarded, so their end tags are too
    if (this.depth > 0 && (name === 'html' || name === 'body' || name === 'head')) {
      this.depth--
      return
    }
    // the name must be somewhere on the stack
    let i = this.stack.length - 1
    for (; i >= 0; i--) if (this.stack[i] === name) break
    if (i < 0) return
    // htmlAutoCloseOnClose: only elements of lower or equal priority can be closed on the way
    const priority = endPriority(name)
    for (let k = this.stack.length - 1; k > i; k--) if (endPriority(this.stack[k]!) > priority) return
    while (this.stack.length && this.cur !== name) this.pop()
    if (this.cur === name) this.pop()
  }

  contentStarted(): void {
    this.prolog = false
  }

  strayLt(): void {
    // libxml2 implies the elements a start tag would (a <body> even inside <frameset>, where text implies nothing).
    this.prolog = false
    this.checkImplied('')
  }

  comment(data: string, kind: 'comment' | 'pi' | 'bogus'): void {
    // Only comments, processing instructions and a doctype keep the prolog going; a bogus comment ends it.
    if (kind === 'bogus') this.prolog = false
    this.soup.endData()
    this.soup.handleData(data)
    this.soup.endData('comment')
  }

  doctype(name: string, publicId: string | null, systemId: string | null): void {
    this.soup.endData()
    let value = name || ''
    if (publicId !== null) {
      value += ` PUBLIC "${publicId}"`
      if (systemId !== null) value += ` "${systemId}"`
    } else if (systemId !== null) value += ` SYSTEM "${systemId}"`
    // An empty doctype string becomes a single space, as every empty string does in bs4's endData.
    this.soup.appendToCurrent(makeString(value || ' ', 'doctype'))
  }

  finish(): void {
    while (this.stack.length) this.pop()
  }
}

/** `BeautifulSoup(markup, "lxml")` for an HTML string. */
export function parseLxml(markup: string): BeautifulSoup {
  const soup = new BeautifulSoup()
  // lxml reads a str as UTF-8 text: a byte order mark is dropped, and CR LF / CR become LF (HTML5 input preprocessing).
  let s = markup.charCodeAt(0) === 0xfeff ? markup.slice(1) : markup
  if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n')
  const builder = new LibxmlBuilder(soup)
  new Tokenizer(s, builder).run()
  builder.finish()
  soup.finish()
  return soup
}
