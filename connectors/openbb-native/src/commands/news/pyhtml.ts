// The text of a piece of HTML the way Python's `html.parser.HTMLParser` hands it to `handle_data` with
// `convert_charrefs=True`, when the parser is fed once and never closed (`strip_html` in openbb_news/parser.py does
// that). Ported from CPython 3.12.3's Lib/html/parser.py (PSF license); modified: only the data is kept, since a
// tag stripper ignores every other handler, and the unescaping is the html.unescape port the SEC markdown code has.
import { strip } from '../../sec/markdown/py.js'
import { unescape } from '../../sec/markdown/soup.js'

const CDATA_CONTENT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes'])
const RCDATA_CONTENT_ELEMENTS = new Set(['textarea', 'title'])

const STARTTAGOPEN = /<[a-zA-Z]/y
const ENDTAGOPEN = /<\/[a-zA-Z]/y
const COMMENTCLOSE = /--!?>/g
const COMMENTABRUPTCLOSE = /-?>/y
const TAGFIND_TOLERANT = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y
const ATTRFIND_TOLERANT = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y
const LOCATETAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y

function matchAt(re: RegExp, s: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(s)
}

class TextParser {
  private rawdata = ''
  private cdataElem: string | null = null
  private escapable = true
  private interesting: RegExp | null = null
  readonly parts: string[] = []

  feed(data: string): void {
    this.rawdata += data
    this.goahead(false)
  }

  private setCdataMode(elem: string, escapable: boolean): void {
    this.cdataElem = elem.toLowerCase()
    this.escapable = escapable
    // With character references converted, an escapable element is read to its end tag like any other.
    this.interesting = this.cdataElem === 'plaintext' ? /$(?![\s\S])/g : new RegExp(`</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, 'gi')
  }

  private clearCdataMode(): void {
    this.interesting = null
    this.cdataElem = null
    this.escapable = true
  }

  private data(text: string): void {
    this.parts.push(text)
  }

  private goahead(end: boolean): void {
    const rawdata = this.rawdata
    let i = 0
    const n = rawdata.length
    while (i < n) {
      let j: number
      if (!this.cdataElem) {
        j = rawdata.indexOf('<', i)
        if (j < 0) {
          // If we can't find the next <, either we are at the end or there's more text incoming. If the latter, we can't
          // pass the text on in case a character reference is cut in half at the end: look for an & near the end that is
          // not followed by a space or a semicolon.
          const amppos = rawdata.lastIndexOf('&', n - 1)
          const from = Math.max(i, n - 34)
          const at = amppos >= from ? amppos : -1
          if (at >= 0 && !/[\t\n\r\f ;]/.test(rawdata.slice(at))) break // wait till we get all the text
          j = n
        }
      } else {
        this.interesting!.lastIndex = i
        const match = this.interesting!.exec(rawdata)
        if (match) j = match.index
        else break
      }
      if (i < j) this.data(this.escapable ? unescape(rawdata.slice(i, j)) : rawdata.slice(i, j))
      i = j
      if (i === n) break
      if (rawdata.startsWith('<', i)) {
        let k: number
        if (matchAt(STARTTAGOPEN, rawdata, i)) k = this.parseStarttag(i)
        else if (rawdata.startsWith('</', i)) k = this.parseEndtag(i)
        else if (rawdata.startsWith('<!--', i)) k = this.parseComment(i)
        else if (rawdata.startsWith('<?', i)) k = this.parsePi(i)
        else if (rawdata.startsWith('<!', i)) k = this.parseHtmlDeclaration(i)
        else if (i + 1 < n || end) {
          this.data('<')
          k = i + 1
        } else break
        if (k < 0) {
          if (!end) break
          if (matchAt(STARTTAGOPEN, rawdata, i)) {
            // pass
          } else if (rawdata.startsWith('</', i)) {
            if (i + 2 === n) this.data('</')
            else if (!matchAt(ENDTAGOPEN, rawdata, i)) {
              // bogus comment: no data
            }
          }
          k = n
        }
        i = k
      } else break
    }
    if (end && i < n) this.data(this.escapable ? unescape(rawdata.slice(i, n)) : rawdata.slice(i, n))
    this.rawdata = rawdata.slice(i)
  }

  private parseHtmlDeclaration(i: number): number {
    const rawdata = this.rawdata
    if (rawdata.slice(i, i + 4) === '<!--') return this.parseComment(i)
    if (rawdata.slice(i, i + 9) === '<![CDATA[') {
      const j = rawdata.indexOf(']]>', i + 9)
      return j < 0 ? -1 : j + 3
    }
    if (rawdata.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gtpos = rawdata.indexOf('>', i + 9)
      return gtpos === -1 ? -1 : gtpos + 1
    }
    if (rawdata.slice(i, i + 3) === '<![') {
      const j = rawdata.indexOf('>', i + 3)
      return j < 0 ? -1 : j + 1
    }
    return this.parseBogusComment(i)
  }

  private parseComment(i: number): number {
    const rawdata = this.rawdata
    COMMENTCLOSE.lastIndex = i + 4
    const match = COMMENTCLOSE.exec(rawdata) ?? matchAt(COMMENTABRUPTCLOSE, rawdata, i + 4)
    return match ? match.index + match[0].length : -1
  }

  private parseBogusComment(i: number): number {
    const pos = this.rawdata.indexOf('>', i + 2)
    return pos === -1 ? -1 : pos + 1
  }

  private parsePi(i: number): number {
    const j = this.rawdata.indexOf('>', i + 2)
    return j < 0 ? -1 : j + 1
  }

  private parseStarttag(i: number): number {
    const rawdata = this.rawdata
    const endpos = this.checkForWholeStartTag(i)
    if (endpos < 0) return endpos
    const match = matchAt(TAGFIND_TOLERANT, rawdata, i + 1)!
    let k = match.index + match[0].length
    const tag = match[1]!.toLowerCase()
    while (k < endpos) {
      const m = matchAt(ATTRFIND_TOLERANT, rawdata, k)
      if (!m) break
      k = m.index + m[0].length
    }
    const endText = strip(rawdata.slice(k, endpos))
    if (endText !== '>' && endText !== '/>') {
      this.data(rawdata.slice(i, endpos))
      return endpos
    }
    if (!endText.endsWith('/>')) {
      if (CDATA_CONTENT_ELEMENTS.has(tag) || tag === 'plaintext') this.setCdataMode(tag, false)
      else if (RCDATA_CONTENT_ELEMENTS.has(tag)) this.setCdataMode(tag, true)
    }
    return endpos
  }

  private checkForWholeStartTag(i: number): number {
    const match = matchAt(LOCATETAGEND, this.rawdata, i + 1)!
    const j = match.index + match[0].length
    return this.rawdata[j - 1] !== '>' ? -1 : j
  }

  private parseEndtag(i: number): number {
    const rawdata = this.rawdata
    if (rawdata.indexOf('>', i + 2) < 0) return -1
    if (!matchAt(ENDTAGOPEN, rawdata, i)) {
      if (rawdata.slice(i + 2, i + 3) === '>') return i + 3
      return this.parseBogusComment(i)
    }
    const m = matchAt(LOCATETAGEND, rawdata, i + 2)!
    const j = m.index + m[0].length
    if (rawdata[j - 1] !== '>') return -1
    this.clearCdataMode()
    return j
  }
}

/** The text of the HTML as `HTMLParser.feed` (never `close`d) passes it to `handle_data`. */
export function htmlTextParts(html: string): string {
  const parser = new TextParser()
  parser.feed(html)
  return parser.parts.join('')
}
