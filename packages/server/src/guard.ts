// Only this machine's own pages may drive the server. The server listens on loopback, but a web page the user has
// open elsewhere can still reach it through the browser: by DNS rebinding (a hostile name that resolves to 127.0.0.1,
// so the request carries that name as its Host) or by a cross-site request (a form post, a fetch, a WebSocket, all
// carrying the hostile page's Origin). So:
// - every request must name a loopback host (or the host the server was bound to): `Host` is checked on all of them;
// - every state-changing request (POST, PUT, PATCH, DELETE) and the WebSocket upgrade must come from the server's own
//   origin, or carry no Origin at all (curl, scripts, the tests); a few extra origins may be allowed by name
//   (`OPENTERMINAL_ALLOWED_ORIGINS`, comma-separated).
// The Vite dev server proxies with its Origin rewritten to the server's (packages/web/vite.config.ts).
import type { MiddlewareHandler } from 'hono'

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type GuardOptions = {
  /** Host names accepted besides loopback, e.g. the address the server was bound to. */
  hosts?: string[]
  /** Origins accepted besides the server's own, e.g. `http://localhost:5173`. */
  origins?: string[]
}

/**
 * The verdict for one request; a string is the reason it is refused. Pure, for the tests. The `Host` header wins over
 * the URL's host when both are there: the WebSocket upgrade reaches the app with a placeholder URL.
 */
export function checkRequest(req: { method: string; url: string; host?: string | null; origin?: string | null; upgrade?: string | null }, opts: GuardOptions = {}): true | string {
  let url: URL
  try {
    const given = new URL(req.url)
    url = req.host ? new URL(`${given.protocol}//${req.host}`) : given
  } catch {
    return 'bad request URL or Host'
  }
  const hosts = new Set<string>([...LOOPBACK_HOSTS, ...(opts.hosts ?? [])].map((h) => h.toLowerCase()))
  if (!hosts.has(url.hostname.toLowerCase())) return `host ${url.hostname} is not this machine`
  const mutating = STATE_CHANGING.has(req.method.toUpperCase()) || (req.upgrade ?? '').toLowerCase() === 'websocket'
  if (!mutating || !req.origin) return true
  if (req.origin === url.origin) return true
  if ((opts.origins ?? []).some((o) => o.replace(/\/+$/, '') === req.origin)) return true
  return `origin ${req.origin} may not change anything here`
}

/** Hono middleware refusing (403) what `checkRequest` refuses. */
export function localOnly(opts: GuardOptions = {}, log: (msg: string) => void = () => {}): MiddlewareHandler {
  return async (c, next) => {
    const verdict = checkRequest({ method: c.req.method, url: c.req.url, host: c.req.header('host'), origin: c.req.header('origin'), upgrade: c.req.header('upgrade') }, opts)
    if (verdict !== true) {
      log(`refused ${c.req.method} ${c.req.path}: ${verdict}`)
      return c.json({ error: `forbidden: ${verdict}` }, 403)
    }
    await next()
  }
}

/** `OPENTERMINAL_ALLOWED_ORIGINS` as a list. */
export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.OPENTERMINAL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}
