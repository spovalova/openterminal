// Record every upstream exchange a native handler makes, and serve them back later without a network. The parity
// run records while it compares against OpenBB; the replay tests run the same handler on the recording, so CI
// checks every ported route offline. Credentials are replaced by `{{name}}` before anything is stored.

export type Exchange = {
  method: string
  url: string
  requestBody?: string
  status: number
  headers: [string, string][]
  encoding: 'utf8' | 'base64'
  body: string
}

/** Response headers worth keeping: the ones handlers read. */
const KEEP_HEADERS = new Set(['content-type', 'set-cookie', 'location', 'content-disposition', 'x-csrf-token', 'x-xsrf-token'])
const NULL_BODY = new Set([101, 204, 205, 304])

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function requestBodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString('base64')
  if (body instanceof URLSearchParams) return body.toString()
  return String(body)
}

function isText(contentType: string, bytes: Uint8Array): boolean {
  if (/json|text|xml|csv|javascript|html/i.test(contentType)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return !bytes.includes(0)
  } catch {
    return false
  }
}

/** Replace each secret value with `{{name}}` (credentials), longest first so one secret inside another stays whole. */
export function redact(text: string, secrets: Record<string, string>): string {
  let out = text
  const entries = Object.entries(secrets).filter(([, v]) => v && v.length >= 4).sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of entries) {
    out = out.split(value).join(`{{${name}}}`)
    const enc = encodeURIComponent(value)
    if (enc !== value) out = out.split(enc).join(`{{${name}}}`)
  }
  return out
}

export function recordingFetch(inner: typeof fetch = fetch, secrets: Record<string, string> = {}): { fetch: typeof fetch; exchanges: Exchange[] } {
  const exchanges: Exchange[] = []
  const recording: typeof fetch = async (input, init) => {
    const res = await inner(input, init)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const headers: [string, string][] = []
    res.headers.forEach((v, k) => {
      if (KEEP_HEADERS.has(k) && k !== 'set-cookie') headers.push([k, v])
    })
    for (const c of res.headers.getSetCookie()) headers.push(['set-cookie', c])
    const text = isText(res.headers.get('content-type') ?? '', bytes)
    const reqBody = requestBodyText(init?.body)
    exchanges.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url: redact(requestUrl(input), secrets),
      ...(reqBody !== undefined ? { requestBody: redact(reqBody, secrets) } : {}),
      status: res.status,
      headers: headers.map(([k, v]) => [k, redact(v, secrets)]),
      encoding: text ? 'utf8' : 'base64',
      body: text ? redact(new TextDecoder().decode(bytes), secrets) : Buffer.from(bytes).toString('base64'),
    })
    return new Response(NULL_BODY.has(res.status) ? null : bytes, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  return { fetch: recording, exchanges }
}

const exchangeKey = (method: string, url: string, body: string | undefined): string => `${method} ${url}\n${body ?? ''}`

/**
 * A fetch that answers from recorded exchanges, matched by method, URL and request body; identical requests get
 * their recordings in order (the last one repeats). Anything unrecorded throws, naming the closest recorded URL.
 */
export function replayFetch(exchanges: readonly Exchange[]): typeof fetch {
  const queues = new Map<string, Exchange[]>()
  for (const e of exchanges) {
    const k = exchangeKey(e.method, e.url, e.requestBody)
    queues.set(k, [...(queues.get(k) ?? []), e])
  }
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = placeholders(requestUrl(input))
    const body = requestBodyText(init?.body)
    const k = exchangeKey(method, url, body === undefined ? undefined : placeholders(body))
    const queue = queues.get(k)
    if (!queue || queue.length === 0) {
      const near = exchanges.map((e) => e.url).sort((a, b) => commonPrefix(b, url) - commonPrefix(a, url))[0]
      throw new Error(`replay: no recorded response for ${method} ${url}${near ? `\n  closest recorded: ${near}` : ''}`)
    }
    const e = queue.length > 1 ? queue.shift()! : queue[0]!
    const payload = e.encoding === 'base64' ? Buffer.from(e.body, 'base64') : e.body
    return new Response(NULL_BODY.has(e.status) ? null : payload, { status: e.status, headers: e.headers })
  }
}

/** A replayed credential is `{{name}}`; once URL-encoded it must still match the recording's placeholder. */
function placeholders(text: string): string {
  return text.replace(/%7B%7B([a-z0-9_]+)%7D%7D/gi, '{{$1}}')
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
