import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractWords, pdfPages, PdfUnsupported, type PdfChar } from '../src/lib/pdf-words.js'

/** A PDF whose objects are given as [number, dictionary text, optional stream text]. */
function buildPdf(objects: [number, string, string?][], trailer = '<< /Root 1 0 R >>'): Uint8Array {
  let out = '%PDF-1.4\n'
  for (const [n, dict, stream] of objects) {
    out += stream === undefined ? `${n} 0 obj\n${dict}\nendobj\n` : `${n} 0 obj\n${dict.replace(/>>$/, `/Length ${stream.length} >>`)}\nstream\n${stream}\nendstream\nendobj\n`
  }
  out += `trailer\n${trailer}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(out, 'latin1'))
}

const CMAP = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 6 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> <0004> <0020> <0005> <FB01> <0006> <0078> endbfchar endcmap end end'

const CMAP_BYTES = 'begincmap 3 beginbfchar <20> <0020> <41> <0041> <42> <0042> endbfchar endcmap'

/** Two pages: a Type0 font with a descendant /W, /DW and a descent; then a simple font on a page whose media box starts at (10, 20). */
function samplePdf(): Uint8Array {
  const page1 = [
    '0.5 0 0 0.5 0 0 cm', // concatenated matrices: halved, then doubled again
    '2 0 0 2 0 0 cm',
    '1 0 0 -1 0 800 cm',
    'BT /F1 10 Tf 1 0 0 -1 50 100 Tm <0001000200030004000100020005> Tj ET',
    'BT /F1 10 Tf 1 0 0 -1 50 101.5 Tm <00010002> Tj ET',
    'BT /F1 20 Tf 1 0 0 -1 50 140 Tm [<0001> -500 <0002> 3000 <0001>] TJ ET',
    'q BT /F1 12 Tf 2 Tc 1 0 0 -1 50 180 Tm <00010002> Tj ET Q',
    'BT 1 0 0 -1 50 200 Tm <0001> Tj ET',
    'BT /F1 10 Tf 50 Tz 5 Ts 1 0 0 -1 50 220 Tm <00010006> Tj ET',
  ].join('\n')
  const page2 = ['BT /F2 10 Tf 1 0 0 1 30 700 Tm (AB A) Tj 0 -12 Td 5 Tw (A B) Tj 12 TL T* (A) Tj (B) \' ET'].join('\n')
  return buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 /MediaBox [0 0 600 800] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
    [4, '<< >>', page1],
    [5, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [ 6 0 R ] /ToUnicode 7 0 R >>'],
    [6, '<< /Type /Font /Subtype /CIDFontType2 /W [ 1 [ 500 600 ] 3 4 400 ] /DW 700 /FontDescriptor 10 0 R >>'],
    [7, '<< >>', CMAP],
    [8, '<< /Type /Page /Parent 2 0 R /MediaBox [10 20 610 820] /Contents 9 0 R /Resources << /Font << /F2 11 0 R >> >> >>'],
    [9, '<< >>', page2],
    [10, '<< /Type /FontDescriptor /Ascent 900 /Descent -250 >>'],
    [11, '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /FirstChar 65 /LastChar 66 /Widths [ 600 500 ] /FontDescriptor 12 0 R /ToUnicode 13 0 R >>'],
    [12, '<< /Type /FontDescriptor /MissingWidth 250 /Descent 210 >>'],
    [13, '<< >>', CMAP_BYTES],
  ])
}

/** One page of text turned a quarter circle, reading up the page. */
function rotatedPdf(): Uint8Array {
  return buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 800] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
    [4, '<< >>', 'BT /F1 10 Tf 0 1 -1 0 300 100 Tm <00010002> Tj ET'],
    [5, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [ 6 0 R ] /ToUnicode 7 0 R >>'],
    [6, '<< /Type /Font /Subtype /CIDFontType2 /W [ 1 [ 500 600 ] ] /DW 700 /FontDescriptor 8 0 R >>'],
    [7, '<< >>', CMAP],
    [8, '<< /Type /FontDescriptor /Descent -250 >>'],
  ])
}

// The expected values below were produced by pdfplumber 0.11.10 (pdfminer.six 20260107) on these files; to check them
// again, write a file with DUMP_TEST_PDF=<path> (or DUMP_TEST_PDF_ROT) and run pdfplumber on it.
if (process.env.DUMP_TEST_PDF) writeFileSync(process.env.DUMP_TEST_PDF, samplePdf())
if (process.env.DUMP_TEST_PDF_ROT) writeFileSync(process.env.DUMP_TEST_PDF_ROT, rotatedPdf())

const round = (n: number): number => Math.round(n * 1000) / 1000
const brief = (c: PdfChar): [string, number, number, number, number] => [c.text, round(c.x0), round(c.x1), round(c.top), round(c.bottom)]

describe('pdf chars', () => {
  const [one, two] = pdfPages(samplePdf())

  it('places characters from the glyph widths, the descent and the matrices, top-left origin', () => {
    expect(one).toMatchObject({ number: 1, width: 600, height: 800 })
    // Font size 10, descent -250: the box runs 2.5 below the baseline and 7.5 above it. Baseline at y = 100 from the top.
    expect(one!.chars.slice(0, 7).map(brief)).toEqual([
      ['A', 50, 55, 92.5, 102.5],
      ['B', 55, 61, 92.5, 102.5],
      ['C', 61, 65, 92.5, 102.5],
      [' ', 65, 69, 92.5, 102.5],
      ['A', 69, 74, 92.5, 102.5],
      ['B', 74, 80, 92.5, 102.5],
      ['ﬁ', 80, 87, 92.5, 102.5],
    ])
    expect(one!.chars.slice(7, 9).map(brief)).toEqual([
      ['A', 50, 55, 94, 104],
      ['B', 55, 61, 94, 104],
    ])
  })

  it('applies kerning adjustments, character spacing, horizontal scaling, rise and the restored state after Q', () => {
    // TJ with 20-point text: A is 10 wide, -500 moves right 10, 3000 moves left 60.
    expect(one!.chars.slice(9, 12).map(brief)).toEqual([
      ['A', 50, 60, 125, 145],
      ['B', 70, 82, 125, 145],
      ['A', 22, 32, 125, 145],
    ])
    // Tc 2 adds 2 before the second character.
    expect(one!.chars.slice(12, 14).map(brief)).toEqual([
      ['A', 50, 56, 171, 183],
      ['B', 58, 65.2, 171, 183],
    ])
    // After Q the font is the one before the q (20 pt F1), whatever was set inside it.
    expect(brief(one!.chars[14]!)).toEqual(['A', 50, 60, 185, 205])
    // Tz 50 halves the advances (A is 500 wide, x falls back to the 700 default); Ts 5 raises the baseline.
    expect(one!.chars.slice(15).map(brief)).toEqual([
      ['A', 50, 52.5, 207.5, 217.5],
      ['x', 52.5, 56, 207.5, 217.5],
    ])
  })

  it('reads simple fonts from /Widths, the missing width and the descent, on a page whose media box has an origin', () => {
    expect(two).toMatchObject({ number: 2, width: 600, height: 800 })
    // Descent 210 is taken as negative. The word space of the second Tj lands after its space; T* and ' follow the leading.
    expect(two!.chars.map(brief)).toEqual([
      ['A', 30, 36, 92.1, 102.1],
      ['B', 36, 41, 92.1, 102.1],
      [' ', 41, 43.5, 92.1, 102.1],
      ['A', 43.5, 49.5, 92.1, 102.1],
      ['A', 30, 36, 104.1, 114.1],
      [' ', 36, 38.5, 104.1, 114.1],
      ['B', 43.5, 48.5, 104.1, 114.1],
      ['A', 30, 36, 116.1, 126.1],
      ['B', 30, 35, 128.1, 138.1],
    ])
  })

  it('refuses what it would have to guess at', () => {
    const pdfWith = (font: string, descendant?: string): Uint8Array =>
      buildPdf([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>'],
        [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
        [4, '<< >>', 'BT /F1 10 Tf 1 0 0 1 0 0 Tm <0041> Tj ET'],
        [5, font],
        ...(descendant ? ([[6, descendant]] as [number, string][]) : []),
      ])
    // A Type0 font without a ToUnicode map, a standard 14 font, a simple font without a ToUnicode entry for the code.
    expect(() => pdfPages(pdfWith('<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [ 6 0 R ] >>', '<< /Type /Font /Subtype /CIDFontType2 /DW 500 >>'))).toThrow(/ToUnicode/)
    expect(() => pdfPages(pdfWith('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 65 /Widths [ 600 ] >>'))).toThrow(/standard 14/)
    expect(() => pdfPages(pdfWith('<< /Type /Font /Subtype /Type1 /BaseFont /Custom /FirstChar 65 /Widths [ 600 ] >>'))).toThrow(PdfUnsupported)
    const rotated = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Rotate 90 >>'],
    ])
    expect(() => pdfPages(rotated)).toThrow(/rotated/)
  })
})

describe('pdf words', () => {
  const chars = pdfPages(samplePdf())[0]!.chars

  it('clusters characters whose tops are within the tolerance into one line, then reads it by x0', () => {
    // The first run (top 92.5) and the second (top 94) are one cluster; sorted by x0 they interleave (A A B B C), and
    // as each next character is within 1.5 of the last one's end and 3 of its top they stay one word. The space ends it.
    const words = extractWords(chars.slice(0, 9), { xTolerance: 1.5 })
    expect(words.map((w) => [w.text, round(w.x0), round(w.x1), round(w.top), round(w.bottom)])).toEqual([
      ['AABBC', 50, 65, 92.5, 104],
      ['ABfi', 69, 87, 92.5, 102.5],
    ])
  })

  it('breaks a word when the next character starts left of the previous one or past the tolerance', () => {
    // Lines read left to right: A (22-32), A (50-60), B (70-82).
    expect(extractWords(chars.slice(9, 12), { xTolerance: 1.5 }).map((w) => w.text)).toEqual(['A', 'A', 'B'])
    // A 10 gap joins A and B at tolerance 11; the 18 gap before them still breaks.
    expect(extractWords(chars.slice(9, 12), { xTolerance: 11 }).map((w) => w.text)).toEqual(['A', 'AB'])
  })

  it('separates lines further apart than the line tolerance and applies the default tolerance of 3', () => {
    const words = extractWords(chars, { xTolerance: 1.5 })
    expect(words.map((w) => w.text)).toEqual(['AABBC', 'ABfi', 'A', 'A', 'B', 'A', 'B', 'A', 'Ax'])
    // A and B of the Tc 2 run are 2 apart: two words at 1.5, one at the default 3.
    expect(extractWords(chars.slice(12, 14), { xTolerance: 1.5 }).map((w) => w.text)).toEqual(['A', 'B'])
    expect(extractWords(chars.slice(12, 14)).map((w) => w.text)).toEqual(['AB'])
  })

  it('reads rotated text by columns', () => {
    const page = pdfPages(rotatedPdf())[0]!
    expect(page.chars.every((c) => !c.upright)).toBe(true)
    // The text runs up the page, so the later character is higher: read top to bottom it is "BA", as pdfplumber has it.
    expect(extractWords(page.chars, { xTolerance: 1.5 }).map((w) => w.text)).toEqual(['BA'])
  })
})
