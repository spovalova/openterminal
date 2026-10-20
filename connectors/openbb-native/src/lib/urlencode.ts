// Python's urllib.parse.urlencode / quote_plus in TypeScript, for providers whose request URLs are built with it:
// the same bytes on the wire, so recordings and the upstream see what OpenBB's own requests look like.
// URLSearchParams differs in two characters ("~" is escaped, "*" is not).

const UNRESERVED = /[A-Za-z0-9_.\-~]/

/** `urllib.parse.quote_plus(value, safe='')`: UTF-8 percent-encoding, spaces as "+". */
export function quotePlus(value: string): string {
  let out = ''
  for (const ch of value) {
    if (UNRESERVED.test(ch)) out += ch
    else if (ch === ' ') out += '+'
    else for (const byte of new TextEncoder().encode(ch)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[]

/** `urlencode(pairs)` for a list of pairs, or `urlencode(dict, doseq=True)` for a record: a list value repeats its key. */
export function urlencode(query: readonly (readonly [string, string | number | boolean])[] | Record<string, QueryValue>): string {
  const pairs: [string, string][] = []
  const entries: [string, QueryValue][] = Array.isArray(query) ? (query as readonly (readonly [string, string])[]).map(([k, v]) => [k, v]) : Object.entries(query as Record<string, QueryValue>)
  for (const [k, v] of entries) {
    if (Array.isArray(v)) for (const x of v) pairs.push([k, pyStr(x)])
    else pairs.push([k, pyStr(v as string | number | boolean | null | undefined)])
  }
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&')
}

/** Python's `str()` of the values a query carries: booleans as True/False, None as "None". */
function pyStr(v: string | number | boolean | null | undefined): string {
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (v === null || v === undefined) return 'None'
  return String(v)
}
