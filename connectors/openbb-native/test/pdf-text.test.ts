import { strToU8, zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { pdfTextRuns } from '../src/lib/pdf-text.js'

/** A two-page PDF: Flate content with an Identity-H font on page 1, plain content with a 1-byte font on page 2. */
function samplePdf(): Uint8Array {
  const page1 = ['0.75 0 0 -0.75 0 792 cm', 'BT', '/F1 12 Tf', '1 0 0 -1 100 200 Tm', '[<0001>-5<0002>-3<0003>] TJ', '1 0 0 -1 300 200 Tm', '[<0002>] TJ', 'ET'].join('\n')
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0041> <0002> <0058> endbfchar 1 beginbfrange <0003> <0004> <0059> endbfrange endcmap end end'
  const page2 = ['BT', '/F2 10 Tf', '50 700 Td', '(Hello \\(PDF\\)) Tj', '0 -12 Td', '(next) Tj', 'ET'].join('\n')
  const flate = zlibSync(strToU8(page1))
  const parts: (string | Uint8Array)[] = []
  const add = (s: string | Uint8Array): void => {
    parts.push(s)
  }
  add('%PDF-1.4\n')
  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  add('2 0 obj\n<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>\nendobj\n')
  add('3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents [4 0 R] /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n')
  add(`4 0 obj\n<< /Length ${flate.length} /Filter /FlateDecode >>\nstream\n`)
  add(flate)
  add('\nendstream\nendobj\n')
  add('5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n')
  add(`6 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`)
  add('7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')
  add('8 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 9 0 R /Resources << /Font << /F2 7 0 R >> >> >>\nendobj\n')
  add(`9 0 obj\n<< /Length ${page2.length} >>\nstream\n${page2}\nendstream\nendobj\n`)
  add('trailer\n<< /Root 1 0 R /Size 10 >>\n%%EOF\n')
  const chunks = parts.map((p) => (typeof p === 'string' ? Uint8Array.from(Buffer.from(p, 'latin1')) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

describe('pdf text runs', () => {
  it('decodes Identity-H fonts through their ToUnicode map and places runs through the matrices', () => {
    const runs = pdfTextRuns(samplePdf()).filter((r) => r.page === 1)
    expect(runs.map((r) => r.text)).toEqual(['AXY', 'X'])
    // 0.75 scale with the y axis flipped: content (100, 200) is (75, 792 - 150).
    expect(runs[0]).toMatchObject({ x: 75, y: 642, size: 12 })
    expect(runs[1]).toMatchObject({ x: 225, y: 642 })
  })

  it('reads literal strings with escapes and relative moves on the next page', () => {
    const runs = pdfTextRuns(samplePdf()).filter((r) => r.page === 2)
    expect(runs.map((r) => r.text)).toEqual(['Hello (PDF)', 'next'])
    expect(runs[0]).toMatchObject({ x: 50, y: 700 })
    expect(runs[1]).toMatchObject({ x: 50, y: 688 })
  })
})
