// The characters and words of a PDF laid out the way pdfplumber (0.11) lays them out, for the providers that read a
// published fact sheet by glyph position (nasdaq's Nordic fact sheets). It follows pdfminer.six's interpreter closely
// enough that the numbers agree to the last bit: the same matrices multiplied in the same order, the same glyph
// advances, the same bounding box from the font's descent and the font size. On top of that `extractWords` is
// pdfplumber's `Page.extract_words` (cluster the characters into lines by `top`, sort each line by `x0`, break words
// where the gap is wider than the tolerance or the line changes).
//
// Like pdf-text.ts it reads classic PDFs (objects in the file body, Flate or unfiltered streams, no encryption, no
// object streams) and not much more: Type0 fonts with an Identity-H encoding and a ToUnicode map, and simple fonts that
// carry /Widths and a ToUnicode map covering the text. Anything else it would have to guess at (a rotated page, a
// vertical font, a font without a ToUnicode map, the standard 14 fonts' built-in metrics) throws `PdfUnsupported`
// instead, so a caller can leave the file to the program that has the full reader.
import { latin1, multiply, pageObjects, parseCMap, readObjects, tokenize, type Matrix, type PdfObject, type Token } from './pdf-text.js'

export class PdfUnsupported extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfUnsupported'
  }
}

/** A character as pdfplumber's `page.chars` has it: top-left origin, so `top` grows down the page. */
export type PdfChar = {
  text: string
  x0: number
  x1: number
  top: number
  bottom: number
  /** Height of the glyph box (the font size scaled by the matrix). */
  size: number
  /** False for text that is rotated or mirrored. */
  upright: boolean
}

export type PdfWord = { text: string; x0: number; x1: number; top: number; bottom: number }

export type PdfPage = {
  /** 1-based. */
  number: number
  width: number
  height: number
  chars: PdfChar[]
}

// --- object values -----------------------------------------------------------------------------------------------

class Name {
  constructor(readonly name: string) {}
}
class Ref {
  constructor(readonly num: number) {}
}
type Dict = Map<string, Value>
/** A string is a PDF string (latin1); a `Name` is a /Name. */
type Value = number | boolean | null | string | Name | Ref | Value[] | Dict

const WHITE = /[\s\0]/
const DELIM = '()<>[]{}/%'

/** The first value in `src` from `at.i`, advancing `at.i` past it. A bare keyword comes back as null. */
function parseValue(src: string, at: { i: number }): Value {
  const skip = (): void => {
    for (;;) {
      while (at.i < src.length && WHITE.test(src[at.i]!)) at.i++
      if (src[at.i] !== '%') return
      while (at.i < src.length && src[at.i] !== '\n' && src[at.i] !== '\r') at.i++
    }
  }
  skip()
  const c = src[at.i]
  if (c === undefined) return null
  if (c === '<' && src[at.i + 1] === '<') {
    at.i += 2
    const dict: Dict = new Map()
    for (;;) {
      skip()
      if (at.i >= src.length) return dict
      if (src.startsWith('>>', at.i)) {
        at.i += 2
        return dict
      }
      const key = parseValue(src, at)
      if (!(key instanceof Name)) continue
      dict.set(key.name, parseValue(src, at))
    }
  }
  if (c === '[') {
    at.i++
    const list: Value[] = []
    for (;;) {
      skip()
      if (at.i >= src.length) return list
      if (src[at.i] === ']') {
        at.i++
        return list
      }
      list.push(parseValue(src, at))
    }
  }
  if (c === '/') {
    let j = at.i + 1
    while (j < src.length && !WHITE.test(src[j]!) && !DELIM.includes(src[j]!)) j++
    const raw = src.slice(at.i + 1, j)
    at.i = j
    return new Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))))
  }
  if (c === '(') {
    let depth = 1
    let out = ''
    at.i++
    while (at.i < src.length && depth > 0) {
      const ch = src[at.i]!
      if (ch === '\\') {
        out += src[at.i + 1] ?? ''
        at.i += 2
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth > 0) out += ch
      at.i++
    }
    return out
  }
  if (c === '<') {
    const end = src.indexOf('>', at.i)
    const hex = src.slice(at.i + 1, end < 0 ? src.length : end).replace(/\s+/g, '')
    at.i = end < 0 ? src.length : end + 1
    let out = ''
    for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16))
    return out
  }
  let j = at.i
  while (j < src.length && !WHITE.test(src[j]!) && !DELIM.includes(src[j]!)) j++
  if (j === at.i) {
    at.i++
    return null
  }
  const word = src.slice(at.i, j)
  at.i = j
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
    if (/^\d+$/.test(word)) {
      const ref = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(src.slice(at.i, at.i + 24))
      if (ref) {
        at.i += ref[0].length
        return new Ref(Number(word))
      }
    }
    return Number(word)
  }
  if (word === 'true') return true
  return null
}

class Doc {
  private readonly cache = new Map<number, Value>()
  constructor(readonly objects: Map<number, PdfObject>) {}

  /** An indirect object's value (a dictionary, array or number), or null when it is missing. */
  object(num: number): Value {
    if (!this.cache.has(num)) {
      const obj = this.objects.get(num)
      this.cache.set(num, obj ? parseValue(obj.dict, { i: 0 }) : null)
    }
    return this.cache.get(num)!
  }

  resolve(v: Value | undefined): Value {
    let cur: Value = v ?? null
    for (let hops = 0; cur instanceof Ref && hops < 20; hops++) cur = this.object(cur.num)
    return cur instanceof Ref ? null : cur
  }

  dict(v: Value | undefined): Dict | undefined {
    const r = this.resolve(v)
    return r instanceof Map ? r : undefined
  }

  list(v: Value | undefined): Value[] | undefined {
    const r = this.resolve(v)
    return Array.isArray(r) ? r : undefined
  }

  num(v: Value | undefined): number | undefined {
    const r = this.resolve(v)
    return typeof r === 'number' ? r : undefined
  }

  name(v: Value | undefined): string | undefined {
    const r = this.resolve(v)
    return r instanceof Name ? r.name : undefined
  }

  stream(v: Value | undefined): Uint8Array | undefined {
    return v instanceof Ref ? this.objects.get(v.num)?.stream : undefined
  }
}

// --- fonts -------------------------------------------------------------------------------------------------------

type Font = {
  /** Two-byte codes (a Type0 font); also what pdfminer's `is_multibyte` says, so no word spacing. */
  multibyte: boolean
  unicode: Map<number, string>
  /** Glyph advances in thousandths of the font size. */
  widths: Map<number, number>
  defaultWidth: number
  /** The descriptor's descent in thousandths of the font size (always zero or negative). */
  descent: number
  /** Why text in this font cannot be placed, when it cannot. */
  unsupported?: string
}

/** The descendant (CID) font's `/W` array: `c [w1 w2 …]` and `first last w` entries (pdfminer `get_widths`). */
function cidWidths(doc: Doc, list: Value[] | undefined): Map<number, number> {
  const widths = new Map<number, number>()
  let pending: number[] = []
  for (const raw of list ?? []) {
    const v = doc.resolve(raw)
    if (Array.isArray(v)) {
      if (pending.length > 0) {
        const first = pending[pending.length - 1]!
        v.forEach((w, k) => {
          const n = doc.num(w)
          if (n !== undefined) widths.set(first + k, n)
        })
        pending = []
      }
    } else if (typeof v === 'number') {
      pending.push(v)
      if (pending.length === 3) {
        const [first, last, w] = pending as [number, number, number]
        if (Number.isInteger(first) && Number.isInteger(last)) for (let c = first; c <= last; c++) widths.set(c, w)
        pending = []
      }
    }
  }
  return widths
}

const STANDARD_FONTS = new Set(['Courier', 'Courier-Bold', 'Courier-BoldOblique', 'Courier-Oblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-BoldOblique', 'Helvetica-Oblique', 'Times-Roman', 'Times-Bold', 'Times-BoldItalic', 'Times-Italic', 'Symbol', 'ZapfDingbats'])

function loadFont(doc: Doc, spec: Dict): Font {
  const subtype = doc.name(spec.get('Subtype'))
  const toUnicodeRef = spec.get('ToUnicode')
  const toUnicodeBytes = doc.stream(toUnicodeRef)
  const unicode = toUnicodeBytes ? parseCMap(latin1(toUnicodeBytes)) : new Map<number, string>()
  if (subtype === 'Type0') {
    const encoding = doc.resolve(spec.get('Encoding'))
    const font: Font = { multibyte: true, unicode, widths: new Map(), defaultWidth: 1000, descent: 0 }
    const encodingName = encoding instanceof Name ? encoding.name : undefined
    if (encodingName !== 'Identity-H') return { ...font, unsupported: `the font encoding ${encodingName ?? 'stream'} is not Identity-H` }
    const descendant = doc.dict(doc.list(spec.get('DescendantFonts'))?.[0])
    if (!descendant) return { ...font, unsupported: 'the Type0 font has no descendant font' }
    if (!toUnicodeBytes) return { ...font, unsupported: 'the Type0 font has no ToUnicode map' }
    const descriptor = doc.dict(descendant.get('FontDescriptor'))
    const descent = doc.num(descriptor?.get('Descent')) ?? 0
    return { ...font, widths: cidWidths(doc, doc.list(descendant.get('W'))), defaultWidth: doc.num(descendant.get('DW')) ?? 1000, descent: descent > 0 ? -descent : descent }
  }
  const descriptor = doc.dict(spec.get('FontDescriptor'))
  const descent = doc.num(descriptor?.get('Descent')) ?? 0
  const font: Font = { multibyte: false, unicode, widths: new Map(), defaultWidth: doc.num(descriptor?.get('MissingWidth')) ?? 0, descent: descent > 0 ? -descent : descent }
  if (subtype !== 'Type1' && subtype !== 'MMType1' && subtype !== 'TrueType') return { ...font, unsupported: `the font type ${subtype ?? 'unknown'} is not read` }
  // pdfminer measures the standard 14 fonts from its built-in AFM tables, whatever /Widths says; this reader has none.
  const baseFont = doc.name(spec.get('BaseFont')) ?? ''
  if (STANDARD_FONTS.has(baseFont)) return { ...font, unsupported: `${baseFont} is measured from the standard 14 font metrics` }
  const widths = doc.list(spec.get('Widths')) ?? new Array<Value>(256).fill(0)
  const first = doc.num(spec.get('FirstChar')) ?? 0
  widths.forEach((w, k) => {
    const n = doc.num(w)
    if (n !== undefined) font.widths.set(first + k, n)
  })
  return font
}

// --- content streams ---------------------------------------------------------------------------------------------

type TextState = {
  font: Font | undefined
  size: number
  charSpace: number
  wordSpace: number
  scaling: number
  leading: number
  rise: number
  matrix: Matrix
  line: [number, number]
}

const freshText = (): TextState => ({ font: undefined, size: 0, charSpace: 0, wordSpace: 0, scaling: 100, leading: 0, rise: 0, matrix: [1, 0, 0, 1, 0, 0], line: [0, 0] })

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** The box of a point list pdfminer's way: the corners of a rectangle through the matrix, then their extent. */
function transformRect(m: Matrix, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const [l1, b1] = apply(m, x0, y0)
  const [r1, b2] = apply(m, x1, y0)
  const [r2, t1] = apply(m, x1, y1)
  const [l2, t2] = apply(m, x0, y1)
  return [Math.min(l1, l2, r1, r2), Math.min(b1, b2, t1, t2), Math.max(l1, l2, r1, r2), Math.max(b1, b2, t1, t2)]
}

/** A page's `/Name` entry, looking up the page tree for inherited ones. */
function inherited(doc: Doc, page: Dict, key: string): Value | undefined {
  let cur: Dict | undefined = page
  for (let hops = 0; cur && hops < 20; hops++) {
    if (cur.has(key)) return cur.get(key)
    cur = doc.dict(cur.get('Parent'))
  }
  return undefined
}

function pageBox(doc: Doc, page: Dict): [number, number, number, number] {
  const nums = (doc.list(inherited(doc, page, 'MediaBox')) ?? []).map((v) => doc.num(v))
  if (nums.length < 4 || nums.some((n) => n === undefined)) throw new PdfUnsupported('a page has no MediaBox')
  const [a, b, c, d] = nums as number[] as [number, number, number, number]
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

function pageChars(doc: Doc, pageNum: number, number: number, fonts: Map<number, Font>): PdfPage {
  const page = doc.dict(new Ref(pageNum))!
  const rotation = (((doc.num(inherited(doc, page, 'Rotate')) ?? 0) % 360) + 360) % 360
  if (rotation !== 0) throw new PdfUnsupported('a rotated page')
  const [mbX0, mbY0, mbX1, mbY1] = pageBox(doc, page)
  // pdfplumber flips the media box to a top-left origin (`_invert_box`); its top is where `top` starts counting.
  const mbHeight = mbY1 - mbY0
  const mbTop = mbHeight - mbY1
  const height = mbHeight - mbY0 - mbTop

  const resources = doc.dict(inherited(doc, page, 'Resources'))
  const fontDict = doc.dict(resources?.get('Font'))
  const pageFonts = new Map<string, Font>()
  for (const [name, ref] of fontDict ?? []) {
    const spec = doc.dict(ref)
    if (!spec) continue
    if (ref instanceof Ref) {
      if (!fonts.has(ref.num)) fonts.set(ref.num, loadFont(doc, spec))
      pageFonts.set(name, fonts.get(ref.num)!)
    } else pageFonts.set(name, loadFont(doc, spec))
  }

  const contents = doc.resolve(page.get('Contents'))
  const refs = Array.isArray(contents) ? contents : [page.get('Contents')]
  const content = refs
    .map((r) => doc.stream(r))
    .filter((s): s is Uint8Array => s !== undefined)
    .map(latin1)
    .join('\n')

  const chars: PdfChar[] = []
  let ctm: Matrix = [1, 0, 0, 1, -mbX0, -mbY0]
  const saved: { ctm: Matrix; text: TextState }[] = []
  let ts = freshText()

  const renderChar = (matrix: Matrix, font: Font, cid: number, scaling: number): number => {
    let text = font.unicode.get(cid)
    if (text === undefined) {
      // pdfminer would turn the code into a character through the font's encoding tables, which this reader does not carry.
      if (!font.multibyte) throw new PdfUnsupported(`a simple font has no ToUnicode entry for code ${cid}`)
      text = `(cid:${cid})`
    }
    const textWidth = (font.widths.get(cid) ?? font.defaultWidth) * 0.001
    const adv = textWidth * ts.size * scaling
    const descent = font.descent * 0.001 * ts.size
    const [a, b, c, d] = matrix
    const upright = a * d * scaling > 0 && b * c <= 0
    const [x0, y0, x1, y1] = transformRect(matrix, 0, descent + ts.rise, adv, descent + ts.rise + ts.size)
    chars.push({ text, x0: x0 + mbX0, x1: x1 + mbX0, top: height - y1 + mbTop, bottom: height - y0 + mbTop, size: y1 - y0, upright })
    return adv
  }

  /** Show strings and adjustments (`TJ`, `Tj`, `'`, `"`): pdfminer's `render_string_horizontal`. */
  const show = (items: (Uint8Array | number)[]): void => {
    const font = ts.font
    if (!font) return
    if (font.unsupported) throw new PdfUnsupported(font.unsupported)
    const matrix = multiply(ts.matrix, ctm)
    const scaling = ts.scaling * 0.01
    const charSpace = ts.charSpace * scaling
    const wordSpace = font.multibyte ? 0 : ts.wordSpace * scaling
    const dxScale = 0.001 * ts.size * scaling
    let x = ts.line[0]
    const y = ts.line[1]
    let needCharSpace = false
    for (const item of items) {
      if (typeof item === 'number') {
        x -= item * dxScale
        needCharSpace = true
        continue
      }
      const codes: number[] = []
      if (font.multibyte) for (let i = 0; i + 1 < item.length; i += 2) codes.push((item[i]! << 8) | item[i + 1]!)
      else codes.push(...item)
      for (const cid of codes) {
        if (needCharSpace) x += charSpace
        const origin: Matrix = [matrix[0], matrix[1], matrix[2], matrix[3], x * matrix[0] + y * matrix[2] + matrix[4], x * matrix[1] + y * matrix[3] + matrix[5]]
        x += renderChar(origin, font, cid, scaling)
        if (cid === 32 && wordSpace) x += wordSpace
        needCharSpace = true
      }
    }
    ts.line = [x, y]
  }

  const moveLine = (tx: number, ty: number): void => {
    const [a, b, c, d, e, f] = ts.matrix
    ts.matrix = [a, b, c, d, tx * a + ty * c + e, tx * b + ty * d + f]
    ts.line = [0, 0]
  }

  let operands: Token[] = []
  for (const token of tokenize(content)) {
    if (token.kind !== 'op') {
      operands.push(token)
      continue
    }
    const n = operands.filter((t): t is { kind: 'num'; value: number } => t.kind === 'num').map((t) => t.value)
    const last = n[n.length - 1]
    switch (token.value) {
      case 'q':
        saved.push({ ctm, text: { ...ts } })
        break
      case 'Q': {
        const top = saved.pop()
        if (top) {
          ctm = top.ctm
          ts = top.text
        }
        break
      }
      case 'cm':
        if (n.length >= 6) ctm = multiply(n.slice(-6) as Matrix, ctm)
        break
      case 'BT':
        ts.matrix = [1, 0, 0, 1, 0, 0]
        ts.line = [0, 0]
        break
      case 'Tc':
        if (last !== undefined) ts.charSpace = last
        break
      case 'Tw':
        if (last !== undefined) ts.wordSpace = last
        break
      case 'Tz':
        if (last !== undefined) ts.scaling = last
        break
      case 'TL':
        if (last !== undefined) ts.leading = -last
        break
      case 'Ts':
        if (last !== undefined) ts.rise = last
        break
      case 'Tf': {
        const name = operands.filter((t) => t.kind === 'name').pop()
        if (name && name.kind === 'name') {
          ts.font = pageFonts.get(name.value)
          if (last !== undefined) ts.size = last
        }
        break
      }
      case 'Tm':
        if (n.length >= 6) {
          ts.matrix = n.slice(-6) as Matrix
          ts.line = [0, 0]
        }
        break
      case 'Td':
        if (n.length >= 2) moveLine(n[n.length - 2]!, last!)
        break
      case 'TD':
        if (n.length >= 2) {
          moveLine(n[n.length - 2]!, last!)
          ts.leading = last!
        }
        break
      case 'T*': {
        const [a, b, c, d, e, f] = ts.matrix
        ts.matrix = [a, b, c, d, ts.leading * c + e, ts.leading * d + f]
        ts.line = [0, 0]
        break
      }
      case 'Tj':
      case "'":
      case '"': {
        if (token.value === "'") {
          const [a, b, c, d, e, f] = ts.matrix
          ts.matrix = [a, b, c, d, ts.leading * c + e, ts.leading * d + f]
          ts.line = [0, 0]
        }
        if (token.value === '"' && n.length >= 2) {
          ts.wordSpace = n[n.length - 2]!
          ts.charSpace = last!
        }
        const s = operands.filter((t) => t.kind === 'str').pop()
        if (s && s.kind === 'str') show([s.value])
        break
      }
      case 'TJ': {
        const arr = operands.find((t) => t.kind === 'array')
        if (arr && arr.kind === 'array') {
          const items: (Uint8Array | number)[] = []
          for (const t of arr.value) if (t.kind === 'str' || t.kind === 'num') items.push(t.value)
          show(items)
        }
        break
      }
      default:
        break
    }
    operands = []
  }
  return { number, width: mbX1 - mbX0, height, chars }
}

/** The characters of every page, as pdfplumber's `page.chars` lists them (content-stream order). */
export function pdfPages(bytes: Uint8Array): PdfPage[] {
  const objects = readObjects(bytes)
  if (/\/Encrypt\b/.test(latin1(bytes.subarray(Math.max(0, bytes.length - 2048))))) throw new PdfUnsupported('an encrypted PDF')
  const doc = new Doc(objects)
  const fonts = new Map<number, Font>()
  return pageObjects(objects).map((num, index) => pageChars(doc, num, index + 1, fonts))
}

// --- words -------------------------------------------------------------------------------------------------------

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬆ': 'st', 'ﬅ': 'st' }

/** The code points Python's `str.isspace` accepts: ASCII whitespace and separators, then the Unicode space separators. */
const SPACE_RANGES: [number, number][] = [[0x09, 0x0d], [0x1c, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]

/** Python's `str.isspace`: not empty, and every character is whitespace. */
export const isSpace = (s: string): boolean => s !== '' && [...s].every((ch) => SPACE_RANGES.some(([lo, hi]) => ch.codePointAt(0)! >= lo && ch.codePointAt(0)! <= hi))

/** pdfplumber's `cluster_list`: sorted distinct values chained into one group while each is within `tolerance` of the last. */
function clusterValues(values: number[], tolerance: number): Map<number, number> {
  const xs = [...new Set(values)].sort((a, b) => a - b)
  const ids = new Map<number, number>()
  if (xs.length === 0) return ids
  let group = 0
  let last = xs[0]!
  ids.set(last, group)
  for (const x of xs.slice(1)) {
    if (!(x <= last + tolerance)) group++
    ids.set(x, group)
    last = x
  }
  return ids
}

/** pdfplumber's `cluster_objects`: the items grouped by `key` within `tolerance`, groups in ascending order. */
function clusterObjects<T>(items: readonly T[], key: (item: T) => number, tolerance: number): T[][] {
  const ids = clusterValues(items.map(key), tolerance)
  const groups: T[][] = []
  for (const item of items) (groups[ids.get(key(item))!] ??= []).push(item)
  return groups
}

export type WordOptions = { xTolerance?: number; yTolerance?: number }

/**
 * pdfplumber's `Page.extract_words`: characters are clustered into lines by `top` (`yTolerance`, default 3), each line
 * is read left to right, and a word ends at whitespace, where the next character starts more than `xTolerance`
 * (default 3) after the last one ends or before it starts, or where its `top` differs by more than `yTolerance`.
 */
export function extractWords(chars: readonly PdfChar[], opts: WordOptions = {}): PdfWord[] {
  const xTolerance = opts.xTolerance ?? 3
  const yTolerance = opts.yTolerance ?? 3
  const words: PdfWord[] = []
  // itertools.groupby over the upright flag: consecutive characters with the same flag are read together.
  const runs: PdfChar[][] = []
  for (const ch of chars) {
    const run = runs[runs.length - 1]
    if (run && run[0]!.upright === ch.upright) run.push(ch)
    else runs.push([ch])
  }
  for (const run of runs) {
    const upright = run[0]!.upright
    // Upright text: lines by `top`, read by x0. Rotated text swaps the roles: lines by x0, read by `top`.
    const lineKey = upright ? (c: PdfChar) => c.top : (c: PdfChar) => c.x0
    const lines = clusterObjects(run, lineKey, upright ? yTolerance : xTolerance)
    for (const line of lines) {
      // Array#sort is stable, as Python's `sorted` is.
      const sorted = [...line].sort(upright ? (p, q) => p.x0 - q.x0 : (p, q) => p.top - q.top || p.bottom - q.bottom)
      let word: PdfChar[] = []
      const flush = (): void => {
        if (word.length === 0) return
        words.push({
          text: word.map((c) => LIGATURES[c.text] ?? c.text).join(''),
          x0: Math.min(...word.map((c) => c.x0)),
          x1: Math.max(...word.map((c) => c.x1)),
          top: Math.min(...word.map((c) => c.top)),
          bottom: Math.max(...word.map((c) => c.bottom)),
        })
        word = []
      }
      for (const c of sorted) {
        if (isSpace(c.text)) {
          flush()
          continue
        }
        if (c.text === '') {
          // pdfplumber tests `text in split_at_punctuation`, and '' is "in" the empty string: the character is a word of its own.
          flush()
          word.push(c)
          flush()
          continue
        }
        const prev = word[word.length - 1]
        if (prev) {
          const begins = upright
            ? c.x0 < prev.x0 || c.x0 > prev.x1 + xTolerance || Math.abs(c.top - prev.top) > yTolerance
            : c.top < prev.top || c.top > prev.bottom + yTolerance || Math.abs(c.x0 - prev.x0) > xTolerance
          if (begins) flush()
        }
        word.push(c)
      }
      flush()
    }
  }
  return words
}
