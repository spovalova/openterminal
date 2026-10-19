// Reply verification (PLAN.md section 17, "Also in v2"). Product rule 4 says every number in a reply comes from a
// preview; the prompt alone did not hold (bench v2). The server extracts every figure from the streamed reply and
// matches it against the previews of that run with unit-aware tolerance: a figure written with d decimals matches a
// preview value within half a unit of its last digit; a percent matches a percent column directly or a fraction
// column times 100; signs are ignored because the prose carries the direction ("down 11.9%" against -11.91).
// Dates, times, years, widget chip ids and small bare counts ("7 reports", "30-day") are not figures and are skipped.
import type { FieldConfig, Preview, Verification } from '@openterminal/core'

/** One preview the agent received this run, with the field config of its columns when the frame carried one. */
export type PreviewRecord = {
  preview: Preview
  fields?: Record<string, FieldConfig>
  /** Where it came from, for the match report ("recipe quote symbols=NVDA"). */
  label?: string
}

export type MentionUnit = 'percent' | 'usd' | 'ratio' | 'bps'

export type NumberMention = {
  /** The text as written ("−11.9%", "$61.39", "131M"). */
  text: string
  /** The value in product units: percent as 11.9, "$2.1B" as 2.1e9. */
  value: number
  unit?: MentionUnit
  /** Half a unit of the last written digit: the rounding tolerance. */
  tolerance: number
  index: number
  /** The suffix multiplier ("$2.1B" is 1e9), so a preview that already holds billions can match the written figure. */
  scale?: number
}

export type Match = { mention: NumberMention; value: number; column: string; source: string; scaled?: 'x100' | 'unscaled' }
export type VerificationReport = Verification & { matches: Match[] }

/** Integers below this with no decimals, unit or currency sign are counts or ordinals, not data. */
export const BARE_INTEGER_MIN = 100

const SCALES: Record<string, number> = { k: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12 }

/** A string cell that is one numeric token: an optional sign and dollar sign, digits with separators, an optional %, K/M/B/T suffix. */
const NUMERIC_CELL = /^([-−–+]?)\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s?(%|K|M|B|T|k|bn|mn)?$/

const NUMBER_RE = /(?<![\w.])([-−–+]?)(\$)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:\s?(%|percent|pct|bps|bp|basis points|[x×]|K|M|B|T|k|mn|bn|tn|million|billion|trillion)(?![\w]))?/g

/** Text with the spans that never hold a figure blanked out (same length, so indexes stay valid). */
export function maskNonFigures(text: string): string {
  const blank = (s: string) => ' '.repeat(s.length)
  return text
    .replace(/\[\[widget:[^\]\s]+\]\]/g, blank) // chips
    .replace(/\b(?:S&P|SP|Nasdaq|NASDAQ|Russell|Dow|FTSE|Nikkei|DAX|CAC|Hang Seng|Stoxx|STOXX|Euro Stoxx|Magnificent|Mag)[ -]?\d{1,4}\b/g, blank) // index and basket names: S&P 500, Russell 2000, Mag 7
    .replace(/\b(?:SMA|EMA|DMA|WMA|RSI|MACD|ATR|ADX|CCI|Bollinger|BB)[ -]?\d{1,3}(?:\s?\/\s?\d{1,3})*(?:[ -]day)?\b/g, blank) // indicator names: SMA 50/200, RSI 14, MACD 12/26/9
    .replace(/\b\d{1,3}(?:\/\d{1,3})+\s?(?:SMA|EMA|DMA|cross(?:over)?|MACD)\b/gi, blank) // 50/200 SMA cross
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/g, blank) // ISO dates and datetimes
    .replace(/(?<!\d)\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?!\d)/g, blank) // 10/16, 10/16/2026
    .replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|AM|PM|ET|UTC)?/g, blank) // times
    .replace(/(?<!\d)\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{4})?(?!\d)/g, blank) // 16 Oct 2026
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?!\d)(?:st|nd|rd|th)?(?:,?\s+\d{4})?(?!\d)/g, blank) // Oct 16, October 16, 2026
    .replace(/\b(?:Q[1-4]|FY|H[12])\s?\d{2,4}\b/g, blank) // Q3 2026, FY26
    .replace(/\b(?:19[9]\d|20[0-3]\d)\b(?![.,]\d)/g, blank) // years
    .replace(/(?<!\d)\d+(?:st|nd|rd|th)\b/g, blank) // ordinals
    .replace(/(?<![\w.])\d+(?:\.\d+)?-(?:day|week|month|year|minute|hour|session|bar|strike|name|stock|symbol)s?\b/gi, blank) // 30-day, 52-week
}

/** Every figure in the reply, in order. */
export function extractNumbers(text: string): NumberMention[] {
  const masked = maskNonFigures(text)
  const out: NumberMention[] = []
  for (const m of masked.matchAll(NUMBER_RE)) {
    const [whole, sign, dollar, digits, suffix] = m
    const raw = Number(digits!.replace(/,/g, ''))
    if (!Number.isFinite(raw)) continue
    const decimals = digits!.includes('.') ? digits!.split('.')[1]!.length : 0
    const unitKey = suffix?.toLowerCase()
    let unit: MentionUnit | undefined
    let scale = 1
    if (unitKey === '%' || unitKey === 'percent' || unitKey === 'pct') unit = 'percent'
    else if (unitKey === 'bps' || unitKey === 'bp' || unitKey === 'basis points') unit = 'bps'
    else if (unitKey === 'x' || unitKey === '×') unit = 'ratio'
    else if (unitKey && unitKey in SCALES) scale = SCALES[unitKey]!
    if (dollar) unit = 'usd'
    const bare = !unit && scale === 1 && decimals === 0 && !dollar
    if (bare && Math.abs(raw) < BARE_INTEGER_MIN) continue
    const value = (sign === '-' || sign === '−' || sign === '–' ? -raw : raw) * scale
    const tolerance = (0.5 * 10 ** -decimals) * scale
    out.push({ text: whole.trim(), value, ...(unit ? { unit } : {}), tolerance, index: m.index ?? 0, ...(scale !== 1 ? { scale } : {}) })
  }
  return out
}

type Candidate = { value: number; column: string; unit?: FieldConfig['unit']; source: string }

/** Every numeric value a reply may quote: the preview cells and the per-group stats. */
export function candidateValues(records: readonly PreviewRecord[]): Candidate[] {
  const out: Candidate[] = []
  records.forEach((r, ri) => {
    const source = r.label ?? `preview ${ri + 1}`
    const unitOf = (col: string): FieldConfig['unit'] | undefined => r.fields?.[col]?.unit ?? (/(_pct|_percent|percent)$/.test(col) ? 'percent' : undefined)
    r.preview.columns.forEach((c, i) => {
      const unit = unitOf(c.name)
      if (c.type === 'string') {
        // A data cell that arrives as text ("2.6%", "199K", "1.300M", "$5.2B" in the nasdaq calendar's actual and
        // consensus columns) is a figure the reply may quote; a headline is not (it is not one numeric token).
        for (const row of r.preview.rows) {
          const v = row[i]
          if (typeof v !== 'string') continue
          const t = NUMERIC_CELL.exec(v.trim())
          if (!t) continue
          const n = Number(t[2]!.replace(/,/g, ''))
          if (!Number.isFinite(n)) continue
          const suffix = t[3]?.toLowerCase()
          const scale = suffix && suffix in SCALES ? SCALES[suffix]! : 1
          const signed = t[1] === '-' || t[1] === '−' || t[1] === '–' ? -n : n
          const cellUnit: FieldConfig['unit'] | undefined = suffix === '%' ? 'percent' : v.trim().startsWith('$') ? 'usd' : unit
          out.push({ value: signed * scale, column: c.name, ...(cellUnit ? { unit: cellUnit } : {}), source })
          if (scale !== 1) out.push({ value: signed, column: c.name, ...(cellUnit ? { unit: cellUnit } : {}), source })
        }
        return
      }
      if (c.type !== 'number') return
      for (const row of r.preview.rows) {
        const v = row[i]
        if (typeof v === 'number' && Number.isFinite(v)) out.push({ value: v, column: c.name, ...(unit ? { unit } : {}), source })
      }
    })
    for (const [group, cols] of Object.entries(r.preview.stats)) {
      for (const [col, s] of Object.entries(cols)) {
        const unit = unitOf(col)
        const where = `${source} stats ${group}.${col}`
        for (const k of ['first', 'last', 'min', 'max', 'change'] as const) out.push({ value: s[k], column: `${col}.${k}`, ...(unit ? { unit } : {}), source: where })
        if (s.changePct !== null) out.push({ value: s.changePct, column: `${col}.changePct`, unit: 'percent', source: where })
      }
    }
  })
  return out
}

function close(a: number, b: number, tol: number): boolean {
  return Math.abs(Math.abs(a) - Math.abs(b)) <= tol + 1e-9
}

/** The first candidate the mention matches, unit-aware. */
export function matchMention(mention: NumberMention, candidates: readonly Candidate[]): Match | undefined {
  let scaledHit: Match | undefined
  for (const c of candidates) {
    const u = c.unit
    switch (mention.unit) {
      case 'percent':
        if ((u === undefined || u === 'percent') && close(mention.value, c.value, mention.tolerance)) return { mention, value: c.value, column: c.column, source: c.source }
        if ((u === 'fraction' || (u === undefined && Math.abs(c.value) < 1)) && close(mention.value, c.value * 100, mention.tolerance)) {
          scaledHit ??= { mention, value: c.value, column: c.column, source: c.source, scaled: 'x100' }
        }
        break
      case 'bps':
        if (u === 'bps' && close(mention.value, c.value, mention.tolerance)) return { mention, value: c.value, column: c.column, source: c.source }
        if ((u === undefined || u === 'percent') && close(mention.value, c.value * 100, mention.tolerance)) scaledHit ??= { mention, value: c.value, column: c.column, source: c.source, scaled: 'x100' }
        break
      case 'ratio':
        if ((u === undefined || u === 'ratio') && close(mention.value, c.value, mention.tolerance)) return { mention, value: c.value, column: c.column, source: c.source }
        break
      case 'usd':
        if ((u === undefined || u === 'usd') && close(mention.value, c.value, mention.tolerance)) return { mention, value: c.value, column: c.column, source: c.source }
        // "$51.61B" against a preview that already holds billions (a pivot with "Market cap ($bn)" rows): the figure as written.
        if (mention.scale && (u === undefined || u === 'usd') && close(mention.value / mention.scale, c.value, mention.tolerance / mention.scale)) scaledHit ??= { mention, value: c.value, column: c.column, source: c.source, scaled: 'unscaled' }
        break
      default:
        if (close(mention.value, c.value, mention.tolerance)) return { mention, value: c.value, column: c.column, source: c.source }
        if (mention.scale && close(mention.value / mention.scale, c.value, mention.tolerance / mention.scale)) scaledHit ??= { mention, value: c.value, column: c.column, source: c.source, scaled: 'unscaled' }
    }
  }
  return scaledHit
}

/** Check a reply against the previews of its run. */
export function verifyReply(text: string, records: readonly PreviewRecord[]): VerificationReport {
  const mentions = extractNumbers(text)
  const candidates = candidateValues(records)
  const matches: Match[] = []
  const unmatched: Verification['unmatched'] = []
  for (const m of mentions) {
    const hit = matchMention(m, candidates)
    if (hit) matches.push(hit)
    else unmatched.push({ text: m.text, value: m.value, ...(m.unit ? { unit: m.unit } : {}) })
  }
  return { ok: unmatched.length === 0, checked: mentions.length, matched: matches.length, unmatched, matches }
}

/** The schema-shaped result without the match list, for the message and the run log row. */
export function verificationOf(report: VerificationReport): Verification {
  return { ok: report.ok, checked: report.checked, matched: report.matched, unmatched: report.unmatched }
}
