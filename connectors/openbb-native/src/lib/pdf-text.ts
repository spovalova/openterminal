// Text runs of a PDF with their positions, for the providers that scrape a table out of a published PDF. It reads
// classic PDFs (objects in the file body, Flate or unfiltered streams, no encryption, no object streams): fonts are
// decoded through their ToUnicode CMaps (Identity-H fonts as 2-byte codes, others as 1-byte), and the content stream
// operators that place text (cm, q, Q, BT, Tf, Tm, Td, TD, T*, TL, Tj, TJ, ', ") are followed so each run knows
// where it starts. It is not a general PDF reader: page content outside those operators is ignored.
import { unzlibSync } from 'fflate'

export type PdfRun = {
  /** 1-based page number. */
  page: number
  /** Where the run starts, in PDF user space (points, origin at the bottom left of the page). */
  x: number
  y: number
  size: number
  text: string
}

type PdfObject = { dict: string; stream: Uint8Array | undefined }
type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `a` applied first, then `b`. */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]]
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1')

function readObjects(bytes: Uint8Array): Map<number, PdfObject> {
  const text = latin1(bytes)
  const objects = new Map<number, PdfObject>()
  const header = /(\d+) (\d+) obj\b/g
  let m: RegExpExecArray | null
  while ((m = header.exec(text))) {
    const start = m.index + m[0].length
    const streamAt = text.indexOf('stream', start)
    const endAt = text.indexOf('endobj', start)
    const hasStream = streamAt >= 0 && (endAt < 0 || streamAt < endAt) && /^stream\r?\n/.test(text.slice(streamAt, streamAt + 8))
    if (!hasStream) {
      const end = endAt < 0 ? text.length : endAt
      objects.set(Number(m[1]), { dict: text.slice(start, end), stream: undefined })
      header.lastIndex = end
      continue
    }
    const dict = text.slice(start, streamAt)
    const dataStart = streamAt + (text[streamAt + 6] === '\r' ? 8 : 7)
    const declared = /\/Length (\d+)(?!\d)(?! \d+ R)/.exec(dict)
    let dataEnd = declared ? dataStart + Number(declared[1]) : -1
    if (dataEnd < 0 || !/^\s*endstream/.test(text.slice(dataEnd, dataEnd + 12))) dataEnd = text.indexOf('endstream', dataStart)
    let data: Uint8Array = bytes.subarray(dataStart, dataEnd < 0 ? bytes.length : dataEnd)
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = unzlibSync(data)
      } catch {
        // A stream with trailing line breaks or padding: retry without them.
        try {
          data = unzlibSync(bytes.subarray(dataStart, Math.max(dataStart, dataEnd - 2)))
        } catch {
          data = new Uint8Array()
        }
      }
    }
    objects.set(Number(m[1]), { dict, stream: data })
    header.lastIndex = Math.max(dataEnd, start)
  }
  return objects
}

const refOf = (text: string, key: string): number | undefined => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text)
  return m ? Number(m[1]) : undefined
}

/** The pages in reading order: the page tree from the catalog, or every /Page object in file order. */
function pageObjects(objects: Map<number, PdfObject>): number[] {
  const pages: number[] = []
  const walk = (n: number, seen: Set<number>): void => {
    const obj = objects.get(n)
    if (!obj || seen.has(n)) return
    seen.add(n)
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = /\/Kids\s*\[(.*?)\]/s.exec(obj.dict)?.[1] ?? ''
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), seen)
    } else if (/\/Type\s*\/Page\b/.test(obj.dict)) pages.push(n)
  }
  for (const obj of objects.values()) if (/\/Type\s*\/Catalog\b/.test(obj.dict)) walk(refOf(obj.dict, 'Pages') ?? -1, new Set())
  if (pages.length > 0) return pages
  return [...objects].filter(([, o]) => /\/Type\s*\/Page\b(?!s)/.test(o.dict)).map(([n]) => n)
}

/** The resources of a page, looking up the page tree for inherited ones. */
function pageResources(objects: Map<number, PdfObject>, page: number): string {
  for (let n: number | undefined = page, hops = 0; n !== undefined && hops < 20; hops++) {
    const dict = objects.get(n)?.dict ?? ''
    const ref = refOf(dict, 'Resources')
    if (ref !== undefined) return objects.get(ref)?.dict ?? ''
    const inline = /\/Resources\s*(<<.*>>)/s.exec(dict)
    if (inline) return inline[1]!
    n = refOf(dict, 'Parent')
  }
  return ''
}

type FontInfo = {
  unicode: Map<number, string>
  twoByte: boolean
  /** Glyph advances in thousandths of the font size, by code. */
  widths: Map<number, number>
  defaultWidth: number
}

/** The /W array of a CID font: `c [w1 w2 …]` and `first last w` entries. */
function parseCidWidths(text: string): Map<number, number> {
  const widths = new Map<number, number>()
  const tokens = [...text.matchAll(/\[|\]|-?\d+(?:\.\d+)?/g)].map((t) => t[0])
  let i = 0
  const num = (k: number): number => Number(tokens[k])
  while (i < tokens.length) {
    if (tokens[i] === '[' || tokens[i] === ']') {
      i++
      continue
    }
    if (tokens[i + 1] === '[') {
      let code = num(i)
      i += 2
      while (i < tokens.length && tokens[i] !== ']') widths.set(code++, num(i++))
      i++
    } else {
      const first = num(i)
      const last = num(i + 1)
      const w = num(i + 2)
      for (let c = first; c <= last && c - first < 70000; c++) widths.set(c, w)
      i += 3
    }
  }
  return widths
}

/** The /Widths of a simple font. */
function parseSimpleWidths(font: string): Map<number, number> {
  const widths = new Map<number, number>()
  const first = Number(/\/FirstChar\s+(\d+)/.exec(font)?.[1] ?? 0)
  const list = /\/Widths\s*\[(.*?)\]/s.exec(font)?.[1]
  if (list) [...list.matchAll(/-?\d+(?:\.\d+)?/g)].forEach((w, k) => widths.set(first + k, Number(w[0])))
  return widths
}

/** `beginbfchar` / `beginbfrange` sections of a ToUnicode CMap. */
function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>()
  const utf16 = (hex: string): string => {
    let s = ''
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    return hex.length === 2 ? String.fromCharCode(parseInt(hex, 16)) : s
  }
  for (const section of text.matchAll(/beginbfchar(.*?)endbfchar/gs)) {
    for (const pair of section[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(pair[1]!, 16), utf16(pair[2]!))
  }
  for (const section of text.matchAll(/beginbfrange(.*?)endbfrange/gs)) {
    for (const range of section[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const lo = parseInt(range[1]!, 16)
      const hi = parseInt(range[2]!, 16)
      const target = range[3]!
      if (target.startsWith('[')) {
        const items = [...target.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16(x[1]!))
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]!)
      } else {
        const base = target.slice(1, -1)
        const start = parseInt(base, 16)
        const width = base.length
        for (let c = lo; c <= hi; c++) map.set(c, utf16((start + (c - lo)).toString(16).padStart(width, '0')))
      }
    }
  }
  return map
}

function fontsOf(objects: Map<number, PdfObject>, resources: string): Map<string, FontInfo> {
  const fonts = new Map<string, FontInfo>()
  let fontDict = /\/Font\s*<<(.*?)>>/s.exec(resources)?.[1]
  if (fontDict === undefined) {
    const ref = refOf(resources, 'Font')
    if (ref !== undefined) fontDict = objects.get(ref)?.dict
  }
  for (const m of (fontDict ?? '').matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = objects.get(Number(m[2]))
    if (!font) continue
    const toUnicode = refOf(font.dict, 'ToUnicode')
    const cmap = toUnicode !== undefined && objects.get(toUnicode)?.stream ? parseCMap(latin1(objects.get(toUnicode)!.stream!)) : new Map<number, string>()
    const twoByte = /\/Encoding\s*\/Identity-[HV]/.test(font.dict) || /\/Subtype\s*\/Type0/.test(font.dict)
    const widthRef = refOf(font.dict, 'W')
    const widthText = widthRef !== undefined ? objects.get(widthRef)?.dict : /\/W\s*(\[.*?\])\s*(?:\/|>>)/s.exec(font.dict)?.[1]
    const widths = twoByte ? parseCidWidths(widthText ?? '') : parseSimpleWidths(font.dict)
    const dw = Number(/\/DW\s+(\d+(?:\.\d+)?)/.exec(font.dict)?.[1] ?? (twoByte ? 1000 : 500))
    fonts.set(m[1]!, { unicode: cmap, twoByte, widths, defaultWidth: dw })
  }
  return fonts
}

// --- content streams -----------------------------------------------------------------------------------------------

type Token = { kind: 'num'; value: number } | { kind: 'name'; value: string } | { kind: 'str'; value: Uint8Array } | { kind: 'array'; value: Token[] } | { kind: 'op'; value: string }

function tokenize(content: string): Token[] {
  const tokens: Token[] = []
  const stack: Token[][] = [tokens]
  const push = (t: Token): void => {
    stack[stack.length - 1]!.push(t)
  }
  const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'
  const isDelim = (c: string): boolean => '()<>[]{}/%'.includes(c)
  let i = 0
  while (i < content.length) {
    const c = content[i]!
    if (isSpace(c)) i++
    else if (c === '%') {
      while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++
    } else if (c === '[') {
      const arr: Token[] = []
      push({ kind: 'array', value: arr })
      stack.push(arr)
      i++
    } else if (c === ']') {
      if (stack.length > 1) stack.pop()
      i++
    } else if (c === '(') {
      const bytes: number[] = []
      let depth = 1
      i++
      while (i < content.length && depth > 0) {
        const ch = content[i]!
        if (ch === '\\') {
          const next = content[i + 1] ?? ''
          if (/[0-7]/.test(next)) {
            const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))![0]
            bytes.push(parseInt(oct, 8) & 0xff)
            i += 1 + oct.length
          } else {
            const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
            if (next === '\n') i += 2
            else if (next === '\r') i += content[i + 2] === '\n' ? 3 : 2
            else {
              bytes.push(map[next] ?? next.charCodeAt(0))
              i += 2
            }
          }
        } else {
          if (ch === '(') depth++
          else if (ch === ')') depth--
          if (depth > 0) bytes.push(ch.charCodeAt(0) & 0xff)
          i++
        }
      }
      push({ kind: 'str', value: Uint8Array.from(bytes) })
    } else if (c === '<' && content[i + 1] === '<') {
      // A dictionary (inline images, marked content): skip to its end.
      let depth = 1
      i += 2
      while (i < content.length && depth > 0) {
        if (content.startsWith('<<', i)) {
          depth++
          i += 2
        } else if (content.startsWith('>>', i)) {
          depth--
          i += 2
        } else i++
      }
    } else if (c === '<') {
      const end = content.indexOf('>', i)
      const hex = content.slice(i + 1, end < 0 ? content.length : end).replace(/\s+/g, '')
      const padded = hex.length % 2 ? `${hex}0` : hex
      const bytes = new Uint8Array(padded.length / 2)
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(padded.slice(2 * k, 2 * k + 2), 16)
      push({ kind: 'str', value: bytes })
      i = end < 0 ? content.length : end + 1
    } else if (c === '/') {
      let j = i + 1
      while (j < content.length && !isSpace(content[j]!) && !isDelim(content[j]!)) j++
      push({ kind: 'name', value: content.slice(i + 1, j) })
      i = j
    } else if (c === ')' || c === '>' || c === '{' || c === '}') i++
    else {
      let j = i
      while (j < content.length && !isSpace(content[j]!) && !isDelim(content[j]!)) j++
      const word = content.slice(i, j)
      i = Math.max(j, i + 1)
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ kind: 'num', value: Number(word) })
      else push({ kind: 'op', value: word })
    }
  }
  return tokens
}

/** The codes of a shown string with their text and advance (thousandths of the font size). */
function glyphs(bytes: Uint8Array, font: FontInfo | undefined): { text: string; width: number }[] {
  if (!font) return []
  const out: { text: string; width: number }[] = []
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i]! << 8) | bytes[i + 1]!
      out.push({ text: font.unicode.get(code) ?? '', width: font.widths.get(code) ?? font.defaultWidth })
    }
  } else {
    for (const b of bytes) out.push({ text: font.unicode.get(b) ?? String.fromCharCode(b), width: font.widths.get(b) ?? font.defaultWidth })
  }
  return out
}

/** A kerning adjustment this large (thousandths of the font size) is a jump to another cell, not a letter space. */
const GAP = 1000

/** Every text run of every page, in content-stream order. */
export function pdfTextRuns(bytes: Uint8Array): PdfRun[] {
  const objects = readObjects(bytes)
  const runs: PdfRun[] = []
  pageObjects(objects).forEach((pageNo, index) => {
    const page = objects.get(pageNo)!
    const contentsText = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/s.exec(page.dict)?.[1] ?? ''
    const parts = [...contentsText.matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => objects.get(Number(r[1]))?.stream).filter((s): s is Uint8Array => s !== undefined)
    const content = parts.map(latin1).join('\n')
    const fonts = fontsOf(objects, pageResources(objects, pageNo))

    let ctm = IDENTITY
    const saved: Matrix[] = []
    let tm = IDENTITY
    let tlm = IDENTITY
    let leading = 0
    let font: FontInfo | undefined
    let size = 0
    let operands: Token[] = []
    const nums = (): number[] => operands.filter((t): t is { kind: 'num'; value: number } => t.kind === 'num').map((t) => t.value)
    /** Show strings and adjustments (`TJ`): a jump of a GAP or more starts a new run where the text lands. */
    const show = (items: (Uint8Array | number)[]): void => {
      let tx = 0
      let text = ''
      let start = 0
      const flush = (): void => {
        const trimmed = text.trimEnd()
        if (trimmed !== '') {
          const at = multiply(multiply([1, 0, 0, 1, start, 0], tm), ctm)
          runs.push({ page: index + 1, x: at[4], y: at[5], size, text: trimmed })
        }
        text = ''
      }
      for (const item of items) {
        if (typeof item === 'number') {
          tx -= (item / 1000) * size
          if (Math.abs(item) >= GAP) flush()
          continue
        }
        for (const g of glyphs(item, font)) {
          if (text === '' && g.text.trim() === '') {
            tx += (g.width / 1000) * size
            continue
          }
          if (text === '') start = tx
          text += g.text
          tx += (g.width / 1000) * size
        }
      }
      flush()
      tm = multiply([1, 0, 0, 1, tx, 0], tm)
    }
    const moveLine = (tx: number, ty: number): void => {
      tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
      tm = tlm
    }
    for (const token of tokenize(content)) {
      if (token.kind !== 'op') {
        operands.push(token)
        continue
      }
      const n = nums()
      switch (token.value) {
        case 'q':
          saved.push(ctm)
          break
        case 'Q':
          ctm = saved.pop() ?? ctm
          break
        case 'cm':
          if (n.length >= 6) ctm = multiply(n.slice(-6) as Matrix, ctm)
          break
        case 'BT':
          tm = IDENTITY
          tlm = IDENTITY
          break
        case 'Tf': {
          const name = operands.find((t) => t.kind === 'name')
          font = name && name.kind === 'name' ? fonts.get(name.value) : undefined
          size = n[n.length - 1] ?? size
          break
        }
        case 'Tm':
          if (n.length >= 6) {
            tm = n.slice(-6) as Matrix
            tlm = tm
          }
          break
        case 'Td':
          if (n.length >= 2) moveLine(n[n.length - 2]!, n[n.length - 1]!)
          break
        case 'TD':
          if (n.length >= 2) {
            leading = -n[n.length - 1]!
            moveLine(n[n.length - 2]!, n[n.length - 1]!)
          }
          break
        case 'TL':
          leading = n[n.length - 1] ?? leading
          break
        case 'T*':
          moveLine(0, -leading)
          break
        case 'Tj':
        case "'":
        case '"': {
          if (token.value !== 'Tj') moveLine(0, -leading)
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
  })
  return runs
}
