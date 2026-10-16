import { describe, expect, it } from 'vitest'
import { parseReply } from '../src/chips'

describe('parseReply', () => {
  it('splits text around [[widget:<id>]] tokens', () => {
    expect(parseReply('MU is up 12%. [[widget:w1]] and [[widget:w_abc-2]].')).toEqual([
      { type: 'text', text: 'MU is up 12%. ' },
      { type: 'chip', id: 'w1' },
      { type: 'text', text: ' and ' },
      { type: 'chip', id: 'w_abc-2' },
      { type: 'text', text: '.' },
    ])
  })

  it('returns plain text untouched and handles adjacent chips', () => {
    expect(parseReply('no chips here')).toEqual([{ type: 'text', text: 'no chips here' }])
    expect(parseReply('[[widget:a]][[widget:b]]')).toEqual([
      { type: 'chip', id: 'a' },
      { type: 'chip', id: 'b' },
    ])
    expect(parseReply('')).toEqual([])
  })

  it('ignores malformed tokens', () => {
    expect(parseReply('[[widget:]] [[widget:a b]]')).toEqual([{ type: 'text', text: '[[widget:]] [[widget:a b]]' }])
  })
})
