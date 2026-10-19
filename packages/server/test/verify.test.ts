import { describe, expect, it } from 'vitest'
import { preview, type Frame } from '@terminal/core'
import { BARE_INTEGER_MIN, extractNumbers, maskNonFigures, verifyReply, type PreviewRecord } from '../src/verify.js'

/** A quote frame as the v2 runner annotates it: change_percent already percent, last_price usd. */
const quote: Frame = {
  columns: [
    { name: 'symbol', type: 'string' },
    { name: 'last_price', type: 'number' },
    { name: 'change_percent', type: 'number' },
    { name: 'volume', type: 'number' },
  ],
  rows: [
    ['CRWV', 61.39, -11.91, 95_412_300],
    ['SMH', 312.5, -3.41, 12_000_000],
  ],
  meta: { connector: 'openbb', fetchedAt: 0, ttl: 0, fields: { last_price: { unit: 'usd' }, change_percent: { unit: 'percent' }, volume: { unit: 'shares' } } },
}
/** An unannotated frame with a fraction column (a raw provider route nobody annotated). */
const raw: Frame = {
  columns: [
    { name: 'symbol', type: 'string' },
    { name: 'gross_margin', type: 'number' },
    { name: 'pe_ratio', type: 'number' },
  ],
  rows: [['NVDA', 0.7512, 42.13]],
  meta: { connector: 'openbb', fetchedAt: 0, ttl: 0 },
}
/** Bars: the stats carry first, last and changePct per symbol. */
const bars: Frame = {
  columns: [
    { name: 'symbol', type: 'string' },
    { name: 'time', type: 'time' },
    { name: 'close', type: 'number' },
  ],
  rows: [
    ['CRWV', 1, 81.36],
    ['CRWV', 2, 70.1],
    ['CRWV', 3, 61.39],
  ],
  meta: { connector: 'yahoo', fetchedAt: 0, ttl: 0, fields: { close: { unit: 'usd' } } },
}
const records: PreviewRecord[] = [
  { preview: preview(quote), fields: quote.meta.fields!, label: 'recipe quote symbols=CRWV,SMH' },
  { preview: preview(raw), label: 'openbb equity/fundamental/metrics symbol=NVDA' },
  { preview: preview(bars), fields: bars.meta.fields!, label: 'recipe ohlcv symbols=CRWV' },
]

describe('maskNonFigures', () => {
  it('blanks chips, dates, times, years, quarters, ordinals and hyphenated counts, keeping the length', () => {
    const text = 'On 2026-10-16 at 14:00 ET, Oct 16 and 16 Oct 2026, the 2030 notes; Q3 2026; the 3rd report; a 30-day IV; 52-week high [[widget:w1]].'
    const masked = maskNonFigures(text)
    expect(masked).toHaveLength(text.length)
    expect(masked).not.toMatch(/2026|14:00|Oct 16|16 Oct|2030|Q3|3rd|30-day|52-week|widget:w1/)
  })
})

describe('extractNumbers', () => {
  it('reads percents, dollars, multiples, scaled suffixes and plain decimals, and skips small bare counts', () => {
    const got = extractNumbers('CRWV fell 11.9% to $61.39 on 95M shares, 3 of 7 names red; P/E 42.1x; OI 3,574 at the 350 puts; spread 45 bps.')
    expect(got.map((m) => [m.text, m.value, m.unit ?? null])).toEqual([
      ['11.9%', 11.9, 'percent'],
      ['$61.39', 61.39, 'usd'],
      ['95M', 95_000_000, null],
      ['42.1x', 42.1, 'ratio'],
      ['3,574', 3574, null],
      ['350', 350, null],
      ['45 bps', 45, 'bps'],
    ])
    expect(got[0]!.tolerance).toBeCloseTo(0.05)
    expect(got[2]!.tolerance).toBe(500_000)
    expect(BARE_INTEGER_MIN).toBe(100)
  })

  it('keeps the sign and tolerates unicode minus', () => {
    const got = extractNumbers('down −3.41% and -0.5%')
    expect(got.map((m) => m.value)).toEqual([-3.41, -0.5])
  })

  it('returns nothing for a reply without figures', () => {
    expect(extractNumbers('No news available. [[widget:w1]]')).toEqual([])
  })
})

describe('verifyReply', () => {
  it('matches a percent against a percent column within rounding, ignoring the sign', () => {
    const v = verifyReply('CRWV is down 11.9% today against SMH down 3.4%. [[widget:w1]]', records)
    expect(v.ok).toBe(true)
    expect(v.checked).toBe(2)
    expect(v.matched).toBe(2)
    expect(v.matches[0]).toMatchObject({ column: 'change_percent', value: -11.91, source: 'recipe quote symbols=CRWV,SMH' })
    expect(v.matches[1]).toMatchObject({ column: 'change_percent', value: -3.41 })
  })

  it('matches a percent against an unannotated fraction by scaling, and a multiple against a plain column', () => {
    const v = verifyReply('NVDA runs a 75.1% gross margin at 42.1x earnings.', records)
    expect(v.ok).toBe(true)
    expect(v.matches[0]).toMatchObject({ column: 'gross_margin', value: 0.7512, scaled: 'x100' })
    expect(v.matches[1]).toMatchObject({ column: 'pe_ratio', value: 42.13 })
    expect(v.matches[1]!.scaled).toBeUndefined()
  })

  it('does not match a fraction written as a percent against a percent column (5.63% is not 0.0563%)', () => {
    const v = verifyReply('SMH is down 0.0341%.', records)
    expect(v.ok).toBe(false)
    expect(v.unmatched).toEqual([{ text: '0.0341%', value: 0.0341, unit: 'percent' }])
  })

  it('flags an invented number and reports the rest as matched', () => {
    const v = verifyReply('CRWV closed at $61.39, down 24.5% over the month from $81.36, after 95M shares traded; its bonds yield 13.63%.', records)
    expect(v.checked).toBe(5)
    expect(v.matched).toBe(4)
    expect(v.ok).toBe(false)
    expect(v.unmatched).toEqual([{ text: '13.63%', value: 13.63, unit: 'percent' }])
    // The month change came from the bars' changePct stat (−24.55 → "24.5%").
    const chg = v.matches.find((m) => m.mention.text === '24.5%')!
    expect(chg.column).toBe('close.changePct')
    expect(chg.value).toBeCloseTo(-24.55, 1)
    // 95M matched the volume cell within half a million.
    expect(v.matches.find((m) => m.mention.text === '95M')).toMatchObject({ column: 'volume', value: 95_412_300 })
  })

  it('does not match a dollar figure against a percent column or a multiple against a usd column', () => {
    const v = verifyReply('CRWV trades at 61.39x and pays $11.91.', records)
    expect(v.unmatched.map((u) => u.text)).toEqual(['61.39x', '$11.91'])
  })

  it('is ok with no figures, and fails with figures but no previews', () => {
    expect(verifyReply('Nothing to show. [[widget:w1]]', records)).toMatchObject({ ok: true, checked: 0, matched: 0 })
    expect(verifyReply('NVDA is at 180.25.', [])).toMatchObject({ ok: false, checked: 1, matched: 0 })
  })
})
