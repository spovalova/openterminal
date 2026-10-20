// The daily update check: on start, at most once a day, ask GitHub which release is the latest and say so in one
// line when it is newer than this one. The request carries no identifiers (no token, no version, no machine id;
// GitHub requires a User-Agent, which is the bare product name) and never blocks startup: it runs beside the
// server's start with a short timeout, and any failure is silent. OPENTERMINAL_NO_UPDATE_CHECK=1 turns it off.
import { readState, updateState } from './state.js'

export const RELEASES_REPO = 'spovalova/openterminal'
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_CHECK_TIMEOUT_MS = 2500

export function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.OPENTERMINAL_NO_UPDATE_CHECK?.trim().toLowerCase()
  return v !== undefined && v !== '' && v !== '0' && v !== 'false' && v !== 'no'
}

/** `v1.2.3` or `1.2.3` (optionally `-pre` and `+build`); undefined for anything else. */
export function parseVersion(v: string): { parts: [number, number, number]; pre: string } | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return undefined
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/** Negative when a < b, positive when a > b, 0 when equal or either is not a version. A pre-release sorts first. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i]! - pb.parts[i]!
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre < pb.pre ? -1 : 1
}

/** The latest release's version from the GitHub API, or undefined on any failure. */
export async function fetchLatestVersion(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string | undefined> {
  const f = opts.fetch ?? fetch
  try {
    const res = await f(LATEST_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'openterminal' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { tag_name?: unknown }
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : ''
    return parseVersion(tag) ? tag.replace(/^v/, '') : undefined
  } catch {
    return undefined
  }
}

export type UpdateCheckOptions = {
  current: string
  /** The CLI state file that remembers the last check. */
  stateFile: string
  now?: () => number
  fetch?: typeof fetch
  timeoutMs?: number
}

export type UpdateCheckResult = {
  /** The newest version known (from this check or the remembered one), if any. */
  latest?: string
  /** True when `latest` is newer than `current`. */
  newer: boolean
  /** True when this call asked GitHub; false when the last check was under a day ago. */
  asked: boolean
}

/**
 * Ask GitHub at most once per `UPDATE_CHECK_INTERVAL_MS`. Within the interval the remembered answer is used, so the
 * notice keeps showing without a request. A failed request still counts as the day's check (no retries when offline).
 */
export async function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const now = (opts.now ?? Date.now)()
  const last = readState(opts.stateFile).updateCheck
  let latest = last?.latest
  const fresh = last !== undefined && now >= last.checkedAt && now - last.checkedAt < UPDATE_CHECK_INTERVAL_MS
  if (!fresh) {
    const fetched = await fetchLatestVersion({ ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
    if (fetched) latest = fetched
    updateState(opts.stateFile, { updateCheck: { checkedAt: now, ...(latest ? { latest } : {}) } })
  }
  return { ...(latest ? { latest } : {}), newer: latest !== undefined && compareVersions(latest, opts.current) > 0, asked: !fresh }
}
