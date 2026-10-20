import { describe, expect, it } from 'vitest'
import { cellNumber, cellText, htmlTables, tableRecords } from '../src/lib/html-tables.js'

describe('html tables', () => {
  const page = `
    <p>intro</p>
    <table id="a"><thead><tr class="x"><th>Name</th><th>Option Symbol</th></tr></thead>
      <tbody>
        <tr><td>
          Agnico  Eagle &amp; Co.   </td><td><a href="/q?symbol=AEM*">AEM</a></td></tr>
        <tr><td>2027-01-15&nbsp;C&nbsp;290.000</td><td>3,704</td></tr>
      </tbody></table>
    <table><tr><td>no</td><td>header</td></tr></table>`

  it('reads headers, rows, entities and collapses whitespace like pandas', () => {
    const [first, second] = htmlTables(page)
    expect(first?.id).toBe('a')
    expect(first?.headers).toEqual(['Name', 'Option Symbol'])
    expect(first?.rows).toEqual([
      ['Agnico Eagle & Co.', 'AEM'],
      ['2027-01-15 C 290.000', '3,704'],
    ])
    expect(tableRecords(first!)[0]).toEqual({ Name: 'Agnico Eagle & Co.', 'Option Symbol': 'AEM' })
    expect(second?.headers).toEqual([])
    expect(second?.rows).toEqual([['no', 'header']])
  })

  it('reads numbers with thousands separators and nothing else', () => {
    expect(cellNumber('3,704')).toBe(3704)
    expect(cellNumber('4.550')).toBe(4.55)
    expect(cellNumber('-0.5')).toBe(-0.5)
    expect(cellNumber('')).toBeUndefined()
    expect(cellNumber('1,23')).toBeUndefined()
    expect(cellNumber('AEM')).toBeUndefined()
    expect(cellText('  a\n\n b   c ')).toBe('a  b c')
  })
})
