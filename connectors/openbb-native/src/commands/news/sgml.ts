// A parser for SGML, using the derived class as a static DTD. Ported from feedparser_sgmllib 2.1.0 (the sgmllib module
// of Python 2, kept alive for feedparser; PSF license), with the end-bracket pattern feedparser/sgml.py puts in its place
// and the declaration scanning of Python's _markupbase (CPython 3.12); modified: the DTD hooks `start_x`, `do_x` and
// `end_x` are not used by any class here, so every tag goes to `unknownStarttag` and `unknownEndtag`, and the feed is
// always handed over whole (the incremental retry bookkeeping is left out).
import { strip } from '../../sec/markdown/py.js'

const INTERESTING = /[&<]/g
const INCOMPLETE = /&([a-zA-Z][a-zA-Z0-9]*|#[0-9]*)?|<([a-zA-Z][^<>]*|\/([a-zA-Z][^<>]*)?|![^<>]*)?/y
const ENTITYREF = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/y
const CHARREF = /&#([0-9]+|[xX][0-9a-fA-F]+);/y
const STARTTAGOPEN = /<[>a-zA-Z]/y
const SHORTTAGOPEN = /<[a-zA-Z][-.a-zA-Z0-9]*\//y
const SHORTTAG = /<([a-zA-Z][-.a-zA-Z0-9]*)\/([^/]*)\//y
// feedparser's replacement for sgmllib's `[<>]`: it skips quoted attribute values, so a `>` inside one does not end the tag.
const ENDBRACKET = /(?:[^'"<>]|"[^"]*"(?=>|\/|\s|\w+=)|'[^']*'(?=>|\/|\s|\w+=))*(?=[<>])|[^\n]*?(?=[<>])/y
const TAGFIND = /[a-zA-Z][-_.:a-zA-Z0-9]*/y
const ATTRFIND = /\s*([a-zA-Z_][-:.a-zA-Z_0-9]*)[$]?(\s*=\s*('[^']*'|"[^"]*"|[\][\-a-zA-Z0-9./,:;+*%?!&$()_#=~'"@]*))?/y
const ENTITY_OR_CHARREF = /&(?:([a-zA-Z][-.a-zA-Z0-9]*)|#([0-9]+))(;?)/g
const COMMENTCLOSE = /--\s*>/g
const DECLSTRINGLIT = /('[^']*'|"[^"]*")\s*/y

export class SGMLParseError extends Error {}

/** Python's AssertionError, which `_markupbase` raises for a declaration it cannot scan. */
export class AssertionError extends Error {}

/** A sticky regex matched at `at`, or null. */
function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(text)
}

export class SGMLParser {
  rawdata = ''
  lasttag = '???'
  nomoretags = 0
  literal = 0
  protected declOtherChars = '='

  reset(): void {
    this.rawdata = ''
    this.lasttag = '???'
    this.nomoretags = 0
    this.literal = 0
  }

  feed(data: string): void {
    this.rawdata += data
    this.goahead(false)
  }

  close(): void {
    this.goahead(true)
  }

  // Internal -- handle data as far as reasonable. If `end` is true, force handling all data as if followed by EOF.
  protected goahead(end: boolean): void {
    const rawdata = this.rawdata
    let i = 0
    const n = rawdata.length
    while (i < n) {
      if (this.nomoretags) {
        this.handleData(rawdata.slice(i, n))
        i = n
        break
      }
      INTERESTING.lastIndex = i
      const found = INTERESTING.exec(rawdata)
      const j = found ? found.index : n
      if (i < j) this.handleData(rawdata.slice(i, j))
      i = j
      if (i === n) break
      if (rawdata[i] === '<') {
        if (matchAt(STARTTAGOPEN, rawdata, i)) {
          if (this.literal) {
            this.handleData(rawdata[i]!)
            i += 1
            continue
          }
          const k = this.parseStarttag(i)
          if (k < 0) break
          i = k
          continue
        }
        if (rawdata.startsWith('</', i)) {
          const k = this.parseEndtag(i)
          if (k < 0) break
          i = k
          this.literal = 0
          continue
        }
        if (this.literal) {
          if (n > i + 1) {
            this.handleData('<')
            i += 1
          } else break
          continue
        }
        if (rawdata.startsWith('<!--', i)) {
          const k = this.parseComment(i)
          if (k < 0) break
          i = k
          continue
        }
        if (rawdata.startsWith('<?', i)) {
          const k = this.parsePi(i)
          if (k < 0) break
          i += k
          continue
        }
        if (rawdata.startsWith('<!', i)) {
          // Some sort of declaration; in "HTML as deployed", the document type declaration.
          let k: number
          try {
            k = this.parseDeclaration(i)
          } catch (error) {
            if (error instanceof AssertionError) throw new SGMLParseError(error.message)
            throw error
          }
          if (k < 0) break
          i = k
          continue
        }
      } else if (rawdata[i] === '&') {
        if (this.literal) {
          this.handleData(rawdata[i]!)
          i += 1
          continue
        }
        let match = matchAt(CHARREF, rawdata, i)
        if (match) {
          this.handleCharref(match[1]!)
          i += match[0].length
          if (rawdata[i - 1] !== ';') i -= 1
          continue
        }
        match = matchAt(ENTITYREF, rawdata, i)
        if (match) {
          this.handleEntityref(match[1]!)
          i += match[0].length
          if (rawdata[i - 1] !== ';') i -= 1
          continue
        }
      } else throw new SGMLParseError('neither < nor & ??')
      // We get here only if incomplete matches but nothing else.
      const match = matchAt(INCOMPLETE, rawdata, i)
      if (!match) {
        this.handleData(rawdata[i]!)
        i += 1
        continue
      }
      const j2 = i + match[0].length
      if (j2 === n) break // really incomplete
      this.handleData(rawdata.slice(i, j2))
      i = j2
    }
    if (end && i < n) {
      this.handleData(rawdata.slice(i, n))
      i = n
    }
    this.rawdata = rawdata.slice(i)
  }

  // Internal -- parse processing instr, return length or -1 if not terminated.
  protected parsePi(i: number): number {
    const at = this.rawdata.indexOf('>', i + 2)
    if (at < 0) return -1
    this.handlePi(this.rawdata.slice(i + 2, at))
    return at + 1 - i
  }

  // Internal -- parse a comment, return the end of it or -1 if not terminated (_markupbase.parse_comment).
  protected parseComment(i: number): number {
    const rawdata = this.rawdata
    COMMENTCLOSE.lastIndex = i + 4
    const match = COMMENTCLOSE.exec(rawdata)
    if (!match) return -1
    this.handleComment(rawdata.slice(i + 4, match.index))
    return match.index + match[0].length
  }

  // Internal -- parse a declaration (_markupbase.parse_declaration, without the document type's internal subset).
  protected parseDeclaration(i: number): number {
    const rawdata = this.rawdata
    let j = i + 2
    if (rawdata.slice(j, j + 1) === '>') return j + 1 // the empty comment <!>
    if (['-', ''].includes(rawdata.slice(j, j + 1))) return -1
    const n = rawdata.length
    if (rawdata.slice(j, j + 2) === '--') return this.parseComment(i)
    if (rawdata[j] === '[') return this.parseMarkedSection(i)
    const scanned = this.scanName(j, i)
    const declType = scanned[0]
    j = scanned[1]
    if (j < 0) return j
    if (declType === 'doctype') this.declOtherChars = ''
    while (j < n) {
      const c = rawdata[j]!
      if (c === '>') {
        const data = rawdata.slice(i + 2, j)
        if (declType === 'doctype') this.handleDecl(data)
        else this.unknownDecl(data)
        return j + 1
      }
      if (c === '"' || c === "'") {
        const m = matchAt(DECLSTRINGLIT, rawdata, j)
        if (!m) return -1
        j += m[0].length
      } else if (/[a-zA-Z]/.test(c)) {
        j = this.scanName(j, i)[1]
      } else if (this.declOtherChars.includes(c)) j += 1
      else if (c === '[') {
        // The document type's internal subset: skip to its end.
        const end = rawdata.indexOf(']', j + 1)
        if (declType === 'doctype' && end >= 0) j = end + 1
        else throw new AssertionError("unexpected '[' char in declaration")
      } else throw new AssertionError(`unexpected ${JSON.stringify(c)} char in declaration`)
      if (j < 0) return j
    }
    return -1
  }

  // Internal -- parse a marked section (_markupbase.parse_marked_section).
  protected parseMarkedSection(i: number): number {
    const rawdata = this.rawdata
    const sectName = /^<!\[\s*([a-zA-Z_][-_.a-zA-Z0-9]*)\s*/.exec(rawdata.slice(i))
    if (!sectName) throw new AssertionError('unknown status keyword in marked section')
    const name = sectName[1]!.toLowerCase()
    let close: RegExp
    if (['temp', 'cdata', 'ignore', 'include', 'rcdata'].includes(name)) close = /\]\s*\]\s*>/g
    else if (['if', 'else', 'endif'].includes(name)) close = /\]\s*>/g
    else throw new AssertionError(`unknown status keyword ${JSON.stringify(rawdata.slice(i + 3, i + 8))} in marked section`)
    close.lastIndex = i + 3
    const match = close.exec(rawdata)
    if (!match) return -1
    return match.index + match[0].length
  }

  /**
   * `_scan_name` as feedparser's `_BaseHTMLProcessor` has it: a declaration name, lower-cased, and where it ends;
   * [null, -1] when the buffer ends first, or (after handing the whole buffer over as text) when there is no name.
   */
  protected scanName(i: number, _declstartpos: number): [string | null, number] {
    const rawdata = this.rawdata
    const n = rawdata.length
    if (i === n) return [null, -1]
    const m = matchAt(/[a-zA-Z][-_.a-zA-Z0-9:]*\s*/y, rawdata, i)
    if (m) {
      const s = m[0]
      if (i + s.length === n) return [null, -1] // end of buffer
      return [strip(s).toLowerCase(), i + s.length]
    }
    this.handleData(rawdata)
    return [null, -1]
  }

  // Internal -- handle starttag, return length or -1 if not terminated.
  protected parseStarttag(i: number): number {
    const rawdata = this.rawdata
    if (matchAt(SHORTTAGOPEN, rawdata, i)) {
      // SGML shorthand: <tag/data/ == <tag>data</tag>
      const match = matchAt(SHORTTAG, rawdata, i)
      if (!match) return -1
      const tag = match[1]!.toLowerCase()
      this.finishShorttag(tag, match[2]!)
      return i + match[0].length
    }
    const bracket = matchAt(ENDBRACKET, rawdata, i + 1)
    if (!bracket) return -1
    let j = i + 1 + bracket[0].length
    // Now parse the data between i+1 and j into a tag and attrs.
    const attrs: [string, string][] = []
    let k: number
    let tag: string
    if (rawdata.slice(i, i + 2) === '<>') {
      // SGML shorthand: <> == <last open tag seen>
      k = j
      tag = this.lasttag
    } else {
      const match = matchAt(TAGFIND, rawdata, i + 1)
      if (!match) throw new SGMLParseError('unexpected call to parse_starttag')
      k = i + 1 + match[0].length
      tag = rawdata.slice(i + 1, k).toLowerCase()
      this.lasttag = tag
    }
    while (k < j) {
      const match = matchAt(ATTRFIND, rawdata, k)
      if (!match) break
      const attrname = match[1]!
      const rest = match[2]
      let attrvalue = match[3] ?? ''
      if (!rest) attrvalue = attrname
      else {
        if ((attrvalue.startsWith("'") && attrvalue.endsWith("'") && attrvalue.length >= 1) || (attrvalue.startsWith('"') && attrvalue.endsWith('"') && attrvalue.length >= 1)) attrvalue = attrvalue.slice(1, -1)
        attrvalue = attrvalue.replace(ENTITY_OR_CHARREF, (_m, entity: string | undefined, charref: string | undefined, semicolon: string) => {
          if (charref) return this.convertCharref(charref) ?? `&#${charref}${semicolon}`
          if (semicolon) return this.convertEntityref(entity!) ?? `&${entity};`
          return `&${entity}`
        })
      }
      attrs.push([attrname.toLowerCase(), attrvalue])
      k += match[0].length
    }
    if (rawdata[j] === '>') j += 1
    this.finishStarttag(tag, attrs)
    return j
  }

  // Internal -- parse endtag.
  protected parseEndtag(i: number): number {
    const rawdata = this.rawdata
    const bracket = matchAt(ENDBRACKET, rawdata, i + 1)
    if (!bracket) return -1
    let j = i + 1 + bracket[0].length
    const tag = strip(rawdata.slice(i + 2, j)).toLowerCase()
    if (rawdata[j] === '>') j += 1
    this.finishEndtag(tag)
    return j
  }

  // Internal -- finish parsing of <tag/data/ (same as <tag>data</tag>).
  protected finishShorttag(tag: string, data: string): void {
    this.finishStarttag(tag, [])
    this.handleData(data)
    this.finishEndtag(tag)
  }

  // Internal -- finish processing of start tag. No class here keeps a DTD, so a tag is always an unknown one.
  protected finishStarttag(tag: string, attrs: [string, string][]): void {
    this.unknownStarttag(tag, attrs)
  }

  // Internal -- finish processing of end tag.
  protected finishEndtag(tag: string): void {
    const match = matchAt(TAGFIND, tag, 0)
    if (match) tag = match[0]
    this.unknownEndtag(tag)
  }

  /** `convert_charref`: a character reference as text, or null. */
  protected convertCharref(name: string): string | null {
    const n = Number(name)
    return n >= 0 && n <= 127 ? String.fromCodePoint(n) : null
  }

  /** `convert_entityref`: an entity reference as text, or null. */
  protected convertEntityref(name: string): string | null {
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[name] ?? null
  }

  // Overridable hooks.
  protected handleCharref(name: string): void {
    const replacement = this.convertCharref(name)
    if (replacement === null) this.unknownCharref(name)
    else this.handleData(replacement)
  }

  protected handleEntityref(name: string): void {
    const replacement = this.convertEntityref(name)
    if (replacement === null) this.unknownEntityref(name)
    else this.handleData(replacement)
  }

  protected handleData(_data: string): void {}
  protected handleComment(_data: string): void {}
  protected handleDecl(_decl: string): void {}
  protected handlePi(_data: string): void {}
  protected unknownDecl(_data: string): void {}
  protected unknownStarttag(_tag: string, _attrs: [string, string][]): void {}
  protected unknownEndtag(_tag: string): void {}
  protected unknownCharref(_ref: string): void {}
  protected unknownEntityref(_ref: string): void {}
}
