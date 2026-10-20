// HTTP for native providers: fetch with query building, timeouts, and readable errors. Every request goes through
// the fetch it was created with, which is how the parity harness records upstream responses and the replay tests
// serve them back without a network (record.ts).

export type Query = Record<string, string | number | boolean | null | undefined | readonly (string | number)[]>

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT'
  /** Appended to the URL; arrays repeat the key (`a=1&a=2`); null and undefined are left out. */
  query?: Query
  headers?: Record<string, string>
  /** A string or bytes as is; any other object is sent as JSON with a JSON content type. */
  body?: string | Uint8Array | Record<string, unknown> | unknown[]
  /** `application/x-www-form-urlencoded` body. */
  form?: Record<string, string>
  timeoutMs?: number
}

export class NativeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'NativeHttpError'
  }
}

export type NativeHttp = {
  /** Parse the body as JSON; throws NativeHttpError on non-2xx and a clear error on a non-JSON body. */
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<T>
  text(url: string, opts?: RequestOptions): Promise<string>
  bytes(url: string, opts?: RequestOptions): Promise<Uint8Array>
  /** The raw response (status not checked), for headers, cookies and redirects. */
  response(url: string, opts?: RequestOptions): Promise<Response>
}

export const DEFAULT_TIMEOUT_MS = 30_000

/** A desktop Chrome user agent: several providers drop requests without a browser-like one. */
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export function withQuery(url: string, query: Query | undefined): string {
  if (!query) return url
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) for (const x of v) qs.append(k, String(x))
    else qs.append(k, String(v))
  }
  const s = qs.toString()
  if (!s) return url
  return `${url}${url.includes('?') ? '&' : '?'}${s}`
}

function encodeBody(opts: RequestOptions): { body?: string | Uint8Array; contentType?: string } {
  if (opts.form) return { body: new URLSearchParams(opts.form).toString(), contentType: 'application/x-www-form-urlencoded' }
  const b = opts.body
  if (b === undefined) return {}
  if (typeof b === 'string' || b instanceof Uint8Array) return { body: b }
  return { body: JSON.stringify(b), contentType: 'application/json' }
}

export function createNativeHttp(fetchImpl: typeof fetch = fetch, base: { signal?: AbortSignal; timeoutMs?: number } = {}): NativeHttp {
  async function response(url: string, opts: RequestOptions = {}): Promise<Response> {
    const full = withQuery(url, opts.query)
    const { body, contentType } = encodeBody(opts)
    const headers: Record<string, string> = { ...(contentType ? { 'content-type': contentType } : {}), ...opts.headers }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? base.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = base.signal ? AbortSignal.any([base.signal, timeout]) : timeout
    const init: RequestInit = { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, signal }
    if (body !== undefined) init.body = body as NonNullable<RequestInit['body']>
    return fetchImpl(full, init)
  }
  async function ok(url: string, opts?: RequestOptions): Promise<Response> {
    const res = await response(url, opts)
    if (!res.ok) throw new NativeHttpError(res.status, res.url || withQuery(url, opts?.query), (await res.text().catch(() => '')).slice(0, 500))
    return res
  }
  return {
    response,
    async text(url, opts) {
      return (await ok(url, opts)).text()
    },
    async bytes(url, opts) {
      return new Uint8Array(await (await ok(url, opts)).arrayBuffer())
    },
    async json<T>(url: string, opts?: RequestOptions) {
      const res = await ok(url, opts)
      const text = await res.text()
      try {
        return JSON.parse(text) as T
      } catch {
        throw new Error(`expected JSON from ${withQuery(url, opts?.query)}, got: ${text.slice(0, 200)}`)
      }
    },
  }
}
