// Ported from openbb_finra/utils/client.py (OpenBB Platform 5.0.0, Apache-2.0); modified: requests go through ctx.http
// (the TRACE session keeps its cookies in a small jar of its own, since fetch has none), the Query API pages are read
// one after another until a short page (the record-total header is not kept in recordings), and the Market Data
// Center sessions are left out because that service no longer answers (see securities.ts).
import { BROWSER_UA } from '../http.js'
import type { NativeCtx, Row } from '../types.js'
import { QUERY_API_PAGE_LIMIT, QUERY_API_URL, TRACE_ATTEMPTS, TRACE_BACKOFF, TRACE_CONCURRENCY, TRACE_ORIGIN, TRACE_PAGE_LIMIT, TRACE_REFERER, TRACE_RETRY_CODES, TRACE_URL, USER_AGENT } from './constants.js'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---- query API (api.finra.org) ----

/** The rows of every page of a Query API dataset that a payload matches. */
export async function queryApi(ctx: NativeCtx, group: string, dataset: string, payload: Row, maxRows?: number): Promise<Row[]> {
  const rows: Row[] = []
  for (;;) {
    const limit = maxRows === undefined ? QUERY_API_PAGE_LIMIT : Math.min(QUERY_API_PAGE_LIMIT, maxRows - rows.length)
    const res = await ctx.http.response(`${QUERY_API_URL}/data/group/${group}/name/${dataset}`, {
      method: 'POST',
      body: { ...payload, offset: rows.length, limit },
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      timeoutMs: 60_000,
    })
    if (res.status === 204) return rows
    const text = await res.text()
    if (res.status !== 200) {
      let message = text
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text
      } catch {
        // not JSON: the text is the message
      }
      throw new Error(`FINRA answered ${group}/${dataset} with HTTP ${res.status}: ${message}`)
    }
    const page = JSON.parse(text) as unknown
    if (!Array.isArray(page)) throw new Error(`FINRA returned an unexpected ${dataset} response.`)
    rows.push(...(page as Row[]))
    // A short page is the last one; a full page may be followed by more.
    if (page.length < limit || (maxRows !== undefined && rows.length >= maxRows)) return rows
  }
}

/** The partition values a Query API dataset holds: one list per partition (`partitions`). */
export async function queryPartitions(ctx: NativeCtx, group: string, dataset: string): Promise<string[][]> {
  const res = await ctx.http.response(`${QUERY_API_URL}/partitions/group/${group}/name/${dataset}`, { headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA }, timeoutMs: 60_000 })
  const body = res.status === 200 ? ((await res.json().catch(() => undefined)) as { availablePartitions?: { partitions?: string[] }[] } | undefined) : undefined
  if (!body || typeof body !== 'object') throw new Error(`FINRA answered the ${dataset} partitions with HTTP ${res.status}.`)
  return (body.availablePartitions ?? []).map((item) => [...(item.partitions ?? [])])
}

// ---- TRACE (services-dynarep.ddwa.finra.org) ----

/** Cookies by name, as one host's Set-Cookie headers leave them; enough of a browser jar for the TRACE token dance. */
class CookieJar {
  private cookies = new Map<string, { value: string; path: string }>()

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim())
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq)
      const attr = (key: string) => attributes.find((a) => a.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1)
      const maxAge = attr('max-age')
      const expires = attr('expires')
      if ((maxAge !== undefined && Number(maxAge) <= 0) || (maxAge === undefined && expires !== undefined && Date.parse(expires) < 1)) this.cookies.delete(name)
      else this.cookies.set(name, { value: pair.slice(eq + 1), path: attr('path') ?? '/' })
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value
  }

  header(url: string): string {
    const path = new URL(url).pathname
    return [...this.cookies].filter(([, c]) => path.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`).join('; ')
  }
}

export type TraceSession = {
  /** The rows a dataset query matches, `maxRows` at most. */
  query(dataset: string, payload: Row, maxRows?: number): Promise<Row[]>
}

type TracePage = { status?: string; statusMessage?: string; returnBody?: { data?: unknown; headers?: Record<string, string[]> } }

/** Open a session on the public TRACE service: its first answer sets the XSRF token every later request must echo. */
export async function openTraceSession(ctx: NativeCtx): Promise<TraceSession> {
  const jar = new CookieJar()
  const first = await ctx.http.response(`${TRACE_URL}/CorporateAndAgencySecurities`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeoutMs: 60_000 })
  await first.arrayBuffer()
  jar.store(first)
  const token = jar.get('XSRF-TOKEN')
  if (!token) throw new Error('FINRA TRACE did not issue the XSRF token its service requires.')

  async function page(dataset: string, payload: Row, offset: number, limit: number): Promise<{ rows: Row[]; total: number }> {
    const url = `${TRACE_URL}/${dataset}`
    let res: Response
    for (let attempt = 0; ; attempt++) {
      res = await ctx.http.response(url, {
        method: 'POST',
        body: { ...payload, offset, limit },
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          Origin: TRACE_ORIGIN,
          Referer: TRACE_REFERER,
          'X-XSRF-TOKEN': token!,
          ...(jar.header(url) ? { Cookie: jar.header(url) } : {}),
        },
        timeoutMs: 120_000,
      })
      if (!TRACE_RETRY_CODES.includes(res.status) || attempt + 1 === TRACE_ATTEMPTS) break
      await res.arrayBuffer()
      await sleep(TRACE_BACKOFF * 2 ** attempt * 1000)
    }
    const text = await res.text()
    let body: TracePage | undefined
    try {
      body = JSON.parse(text) as TracePage
    } catch {
      body = undefined
    }
    if (res.status !== 200 || !body || typeof body !== 'object') throw new Error(`FINRA TRACE answered ${dataset} with HTTP ${res.status}.`)
    if (body.status !== 'success') throw new Error(`FINRA TRACE rejected the ${dataset} request: ${body.statusMessage ?? body.status}`)
    const returned = body.returnBody ?? {}
    const data = returned.data
    const parsed = typeof data === 'string' && data.trim() ? (JSON.parse(data) as unknown) : data
    const rows = Array.isArray(parsed) ? (parsed as Row[]) : []
    const totals = returned.headers?.['Record-Total']
    return { rows, total: totals?.[0] !== undefined ? Number(totals[0]) : rows.length }
  }

  return {
    async query(dataset, payload, maxRows) {
      const firstLimit = maxRows ? Math.min(TRACE_PAGE_LIMIT, maxRows) : TRACE_PAGE_LIMIT
      const { rows, total } = await page(dataset, payload, 0, firstLimit)
      const wanted = maxRows ? Math.min(total, maxRows) : total
      if (rows.length === 0 || rows.length >= wanted) return wanted ? rows.slice(0, wanted) : rows

      // The rest of the dataset in blocks, TRACE_CONCURRENCY at a time; a short page is asked for again from where it stopped.
      const fill = async (offset: number, expected: number): Promise<Row[]> => {
        const block: Row[] = []
        while (block.length < expected) {
          const next = await page(dataset, payload, offset + block.length, Math.min(TRACE_PAGE_LIMIT, expected - block.length))
          if (next.rows.length === 0) break
          block.push(...next.rows)
        }
        return block
      }
      const firstEnd = Math.min(TRACE_PAGE_LIMIT, wanted)
      const jobs: (() => Promise<Row[]>)[] = [() => fill(rows.length, firstEnd - rows.length)]
      for (let offset = TRACE_PAGE_LIMIT; offset < wanted; offset += TRACE_PAGE_LIMIT) jobs.push(() => fill(offset, Math.min(TRACE_PAGE_LIMIT, wanted - offset)))
      const blocks: Row[][] = new Array(jobs.length)
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(TRACE_CONCURRENCY, jobs.length) }, async () => {
          while (next < jobs.length) {
            const mine = next++
            blocks[mine] = await jobs[mine]!()
          }
        }),
      )
      for (const block of blocks) rows.push(...block)
      return rows
    },
  }
}
