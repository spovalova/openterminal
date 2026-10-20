// sec/htm_file, provider sec. Ported from openbb_sec/models/htm_file.py and `SecBaseFiling.download_file` in
// openbb_sec/models/sec_filing.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the document is parsed and written
// back by ../markdown/soup.ts, an emulation of BeautifulSoup's html.parser mode.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { parse } from '../markdown/soup.js'
import { SEC_HEADERS, cachedRequest } from '../helpers.js'

/** `transform_query`: only http(s) URLs of an .htm or .html file on sec.gov; the query string and fragment are dropped. */
function checkedUrl(params: NativeParams): string {
  const raw = typeof params.url === 'string' ? params.url : ''
  if (!raw.trim()) throw new Error('Please enter a URL.')
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error('Invalid URL supplied, must use http or https scheme.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid URL supplied, must use http or https scheme.')
  const host = parsed.hostname.toLowerCase()
  if (host !== 'sec.gov' && !host.endsWith('.sec.gov')) throw new Error('Invalid URL supplied, host must be sec.gov (e.g. https://www.sec.gov/...).')
  if (!(parsed.pathname.endsWith('.htm') || parsed.pathname.endsWith('.html'))) throw new Error('Invalid URL. Please a SEC URL that directs specifically to a HTM or HTML file.')
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

export async function secHtmFile(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const url = checkedUrl(params)
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)
  // `sec_callback`: HTML is decoded as latin-1.
  const content = (await cachedRequest(ctx, url, { kind: 'sec', headers: SEC_HEADERS, useCache })) as string
  if (!content) throw new Error('Failed to extract HTM file data.')

  const soup = parse(content, 'html.parser').find('html')
  if (!soup) throw new TypeError("'NoneType' object has no attribute 'find_all'")
  // Remove style elements that add background color to table rows.
  for (const row of soup.findAll('tr')) {
    if (row.getStr('style').includes('background-color')) row.delete('style')
    for (const attr of ['class', 'bgcolor']) if (row.has(attr)) row.delete(attr)
  }
  return { url, content: soup.toString() }
}
