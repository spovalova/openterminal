import { describe, expect, it } from 'vitest'
import { plainProse } from '../src/plain.js'
import { extractNumbers } from '../src/verify.js'

describe('plainProse (rule 8 enforced on the stored reply)', () => {
  it('leaves plain prose with chips untouched', () => {
    const text = 'CRWV fell 11.91% on Friday to $61.39. Nebius lost 12.18%. [[widget:w1]] [[widget:w3]]\n\nThe bonds yield 13.63% to 14.85%. [[widget:w5]]'
    expect(plainProse(text)).toBe(text)
  })
  it('turns bold bullets under a heading line into sentences of one paragraph (the neoclouds reply)', () => {
    const text = [
      'All four fell about 11–12% on Friday.',
      '',
      'On the fundamentals:',
      '- **CoreWeave** looks most stretched on its balance sheet. Its debt-to-equity is 1,027%',
      '- **Nebius** has the least debt relative to equity (98.6%), the fastest revenue growth (454%)',
      '',
      'Three of them report soon. [[widget:w1]] [[widget:w3]]',
    ].join('\n')
    const out = plainProse(text)
    expect(out).toBe(
      'All four fell about 11–12% on Friday.\n\nOn the fundamentals. CoreWeave looks most stretched on its balance sheet. Its debt-to-equity is 1,027%. Nebius has the least debt relative to equity (98.6%), the fastest revenue growth (454%).\n\nThree of them report soon. [[widget:w1]] [[widget:w3]]',
    )
    expect(out).not.toMatch(/\*\*|^\s*-\s/m)
    // The figures are the same before and after, so verification is unchanged.
    expect(extractNumbers(out).map((n) => n.text)).toEqual(extractNumbers(text).map((n) => n.text))
  })
  it('flattens headings, numbered lists, rules and inline code', () => {
    expect(plainProse('## What moved\n1. CPI came in at 3.7%\n2. PPI at 6.3%\n---\nDone `now`')).toBe('What moved.\n1. CPI came in at 3.7%. PPI at 6.3%.\nDone now'.replace('1. CPI', 'CPI'))
  })
  it('turns a markdown table into one sentence per row', () => {
    const text = '| Symbol | P/E | Debt |\n|---|---|---|\n| CRWV | 12.1 | 5.2B |\n| NBIS | 35.0 | 1.1B |\n\nSo CRWV is cheaper.'
    expect(plainProse(text)).toBe('CRWV: P/E 12.1, Debt 5.2B. NBIS: P/E 35.0, Debt 1.1B.\n\nSo CRWV is cheaper.')
  })
  it('keeps multiplication asterisks and underscores inside identifiers', () => {
    expect(plainProse('close * shares is 1.2B; debt_to_equity is 10.3x')).toBe('close * shares is 1.2B; debt_to_equity is 10.3x')
  })
})
