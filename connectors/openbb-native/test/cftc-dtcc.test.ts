// The numeric and text helpers of the cftc DTCC port, checked against the Python they replace. The expected values in
// cftc-dtcc.vectors.json come from running openbb_cftc 5.0.0 (and pydantic, csv, urllib) on the same inputs: number
// formatting, the slice CSV reader, urllib's unquote, fixing compounding, the FX pricing math, the Brazilian
// business-day count and pydantic's date strings.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { brlBusinessDaysBetween } from '../src/cftc/dtcc/br-calendar.js'
import { parseSliceCsv } from '../src/cftc/dtcc/dtcc.js'
import { compoundFixings } from '../src/cftc/dtcc/fixings.js'
import { pyCommaFixed, pyFixed, pyRepr } from '../src/cftc/dtcc/format.js'
import { calibrateSabr, cipForwardRate, erf, garmanKohlhagen, impliedVol, sabrVol } from '../src/cftc/dtcc/fx-theory.js'
import { getInflationIndex } from '../src/cftc/dtcc/inflation.js'
import { toDateString, toDatetimeString } from '../src/cftc/dtcc/model.js'
import { pyUnquote } from '../src/cftc/dtcc/search.js'
import { createNativeCtx } from '../src/ctx.js'

type Pairs<T = string> = [number, T][]
type Vectors = {
  fixed2: Pairs
  fixed4: Pairs
  fixed6: Pairs
  comma2: Pairs
  comma0: Pairs
  repr: Pairs
  csv: [string, Record<string, string>[]][]
  unquote: [string, string][]
  compound: { fixings: Record<string, number>; cases: [string, string, number, number | null][] }
  erf: [number, number][]
  gk: [number, number, number, number, number, number, boolean, number][]
  implied_vol: [number, number, number, number, number, number, boolean, number | null][]
  sabr: [number, number, number, number, number, number, number][]
  calibrate: { args: [number, number, number, [number, number][]]; result: [number, number, number] | null }
  cip: [number, number, number, number, number, number, number][]
  brl: [string, string, number][]
  datetime: [string, string][]
  date: [string, string][]
}
const v = JSON.parse(readFileSync(new URL('./cftc-dtcc.vectors.json', import.meta.url), 'utf8')) as Vectors

const close = (actual: number, expected: number, rel = 1e-12): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(expected)))
}

describe('Python number formatting', () => {
  it.each(v.fixed2)('f"{%s:.2f}"', (x, text) => expect(pyFixed(x, 2)).toBe(text))
  it.each(v.fixed4)('f"{%s:.4f}"', (x, text) => expect(pyFixed(x, 4)).toBe(text))
  it.each(v.fixed6)('f"{%s:,.6f}"', (x, text) => expect(pyCommaFixed(x, 6)).toBe(text))
  it.each(v.comma2)('f"{%s:,.2f}"', (x, text) => expect(pyCommaFixed(x, 2)).toBe(text))
  it.each(v.repr)('repr(%s)', (x, text) => expect(pyRepr(x)).toBe(text))
})

describe('slice CSV reader', () => {
  it.each(v.csv.map((c, i) => [i, ...c] as const))('sample %s matches csv.DictReader', (_i, text, rows) => {
    expect(parseSliceCsv(text)).toEqual(rows)
  })
})

describe('urllib unquote', () => {
  it.each(v.unquote)('%j', (text, decoded) => expect(pyUnquote(text)).toBe(decoded))
})

describe('compound_fixings', () => {
  it.each(v.compound.cases)('%s to %s on a %s basis', (start, end, basis, expected) => {
    const result = compoundFixings(v.compound.fixings, start, end, basis)
    if (expected === null) expect(result).toBeNull()
    else close(result!, expected)
  })
})

describe('FX pricing math', () => {
  it.each(v.erf)('erf(%s)', (x, expected) => close(erf(x), expected, 1e-14))
  it.each(v.gk)('Garman-Kohlhagen %s %s %s', (spot, strike, t, rd, rf, vol, call, expected) => close(garmanKohlhagen(spot, strike, t, rd, rf, vol, call), expected))
  it.each(v.implied_vol)('implied vol of %s', (price, spot, strike, t, rd, rf, call, expected) => {
    const result = impliedVol(price, spot, strike, t, rd, rf, call)
    if (expected === null) expect(result).toBeNull()
    else close(result!, expected, 1e-9)
  })
  it.each(v.sabr)('SABR vol %s %s', (f, k, t, a, r, n, expected) => close(sabrVol(f, k, t, a, r, n), expected))
  it.each(v.cip)('CIP forward %s', (spot, rq, rb, days, bq, bb, expected) => close(cipForwardRate(spot, rq, rb, days, bq, bb), expected))
  it('calibrates SABR to a smile like the Python grid search', () => {
    const [f, t, atm, points] = v.calibrate.args
    const fit = calibrateSabr(f, t, atm, points)
    if (v.calibrate.result === null) expect(fit).toBeNull()
    else v.calibrate.result.forEach((x, i) => close(fit![i]!, x, 1e-9))
  })
})

describe('BUS/252 business days', () => {
  it.each(v.brl)('%s to %s', (start, end, expected) => expect(brlBusinessDaysBetween(start, end)).toBe(expected))
})

describe('pydantic date strings', () => {
  it.each(v.datetime)('datetime %s', (text, expected) => {
    if (expected === 'ERR') expect(() => toDatetimeString(text)).toThrow()
    else expect(toDatetimeString(text)).toBe(expected)
  })
  it.each(v.date)('date %s', (text, expected) => {
    if (expected === 'ERR') expect(() => toDateString(text)).toThrow()
    else expect(toDateString(text)).toBe(expected)
  })
})

describe('BLS inflation index (the key-free public API)', () => {
  const now = new Date('2026-10-21T09:00:00Z')
  const bls = (windows: Record<string, unknown>) => {
    const asked: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { seriesid: string[]; startyear: string; endyear: string }
      asked.push(`${body.seriesid[0]} ${body.startyear}-${body.endyear}`)
      const answer = windows[`${body.startyear}-${body.endyear}`] ?? { status: 'REQUEST_NOT_PROCESSED', message: ['daily threshold reached'], Results: {} }
      return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } })
    }
    return { asked, ctx: createNativeCtx({ fetch: fetchImpl, now: () => now, cache: new Map() }) }
  }
  const series = (rows: [string, string, string][]) => ({ Results: { series: [{ data: rows.map(([year, period, value]) => ({ year, period, value })) }] } })

  it('asks in ten-year windows from thirty years back, skips annual and half-year rows, and fills a skipped month', async () => {
    const { asked, ctx } = bls({
      '1996-2005': series([['2005', 'M12', '190.3']]),
      '2006-2015': series([['2015', 'M12', '234.8']]),
      '2016-2025': series([['2025', 'M12', '315.6'], ['2025', 'M13', '310.0'], ['2025', 'S01', '300.0']]),
      '2026-2026': series([['2026', 'M01', '320'], ['2026', 'M03', '324'], ['2026', 'M04', 'x']]),
    })
    const levels = await getInflationIndex(ctx, 'USCPI')
    expect(asked.sort()).toEqual(['CUUR0000SA0 1996-2005', 'CUUR0000SA0 2006-2015', 'CUUR0000SA0 2016-2025', 'CUUR0000SA0 2026-2026'])
    expect(levels.get('2026-01-01')).toBe(320)
    expect(levels.get('2026-02-01')).toBe(322)
    expect(levels.get('2026-03-01')).toBe(324)
    expect(levels.has('2026-04-01')).toBe(false)
    expect(levels.get('2025-12-01')).toBe(315.6)
  })

  it('reports what BLS says when it answers without the series', async () => {
    const { ctx } = bls({})
    await expect(getInflationIndex(ctx, 'USCPI')).rejects.toThrow('The BLS API did not return CUUR0000SA0 -> daily threshold reached')
  })
})
