// The Montreal Exchange's expiry-cycle table (cycles_opt_en.pdf). Ported from openbb_tmx/utils/mx.py `_parse_cycles`
// (OpenBB Platform 5.0.0, Apache-2.0); modified: the table is rebuilt from the positions of the text runs on each page
// (pdfplumber finds it from the ruling lines in Python), anchoring each row on its symbol and reading the cycle and the
// X marks in the columns the page header names, and the name from the first column (a wrapped name keeps its line break).
import { pdfTextRuns, type PdfRun } from '../lib/pdf-text.js'

export type CycleListing = { name: string; expiry_cycle: string | null; has_long_term: boolean; has_weeklies: boolean }

const CYCLE_NAMES: Record<string, string | null> = { S: 'standard', SC: 'short', '': null }

/** The header runs of a page: `Symbol`, `Cycle`, `Long` and `Weeklies` with their extents. */
function headerOf(runs: PdfRun[]): { top: number; symbolLeft: number; symbolRight: number; cycleLeft: number; cycleRight: number; longLeft: number; longRight: number; weeklyLeft: number } | undefined {
  const find = (text: string): PdfRun | undefined => runs.find((r) => r.text.trim() === text)
  const symbol = find('Symbol')
  const cycle = find('Cycle')
  const long = find('Long')
  const weekly = find('Weeklies')
  if (!symbol || !cycle || !long || !weekly) return undefined
  const width = (r: PdfRun): number => r.size * 0.75 * 0.5 * r.text.length * 1.1
  return { top: symbol.y, symbolLeft: symbol.x, symbolRight: symbol.x + width(symbol), cycleLeft: cycle.x, cycleRight: cycle.x + width(cycle), longLeft: long.x, longRight: long.x + width(long), weeklyLeft: weekly.x }
}

/** `_parse_cycles`: per option symbol, the cycle and whether long-term and weekly expiries are listed. */
export function parseCycles(bytes: Uint8Array): Map<string, CycleListing> {
  const listings = new Map<string, CycleListing>()
  const pages = new Map<number, PdfRun[]>()
  for (const run of pdfTextRuns(bytes)) pages.set(run.page, [...(pages.get(run.page) ?? []), run])
  for (const runs of pages.values()) {
    const h = headerOf(runs)
    if (!h) continue
    // Column edges between the header words: symbol | cycle | long terms | weeklies.
    const symbolFrom = h.symbolLeft - 8
    const cycleFrom = (h.symbolRight + h.cycleLeft) / 2
    const longFrom = (h.cycleRight + h.longLeft) / 2
    const weeklyFrom = (h.longRight + h.weeklyLeft) / 2
    const inRow = (r: PdfRun, y: number): boolean => Math.abs(r.y - y) <= 9
    for (const anchor of runs) {
      // PDF user space has y up, so a row below the header has a smaller y.
      if (anchor.y >= h.top - 5 || anchor.x < symbolFrom || anchor.x >= cycleFrom) continue
      const symbol = anchor.text.trim()
      if (!symbol || symbol === 'Symbol') continue
      const row = runs.filter((r) => r !== anchor && inRow(r, anchor.y))
      const cell = (from: number, to: number): string => row.filter((r) => r.x >= from && r.x < to).map((r) => r.text).join('').trim()
      const cycle = cell(cycleFrom, longFrom)
      const name = row
        .filter((r) => r.x < symbolFrom)
        .sort((a, b) => b.y - a.y)
        .map((r) => r.text.trim())
        .join('\n')
      listings.set(symbol, {
        name,
        expiry_cycle: cycle in CYCLE_NAMES ? CYCLE_NAMES[cycle]! : cycle || null,
        has_long_term: cell(longFrom, weeklyFrom).includes('X'),
        has_weeklies: cell(weeklyFrom, Infinity).includes('X'),
      })
    }
  }
  return listings
}
