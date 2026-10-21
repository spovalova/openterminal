// URL handling the way feedparser has it. Ported from Python's urllib.parse (urlsplit, urlparse, urlunsplit,
// urlunparse, urljoin; CPython 3.12) and feedparser/urls.py (feedparser 6.0.14, BSD-2-Clause); modified: only the
// string forms, and a ValueError is a thrown Error.
import sanitizer from './sanitizer.json' with { type: 'json' }

const SCHEME_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.')
const USES_RELATIVE = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'imap', 'wais', 'file', 'https', 'shttp', 'mms', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp', 'svn', 'svn+ssh', 'ws', 'wss'])
const USES_NETLOC = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp', 'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services'])
const USES_PARAMS = new Set(['', 'ftp', 'hdl', 'prospero', 'http', 'imap', 'https', 'shttp', 'rtsp', 'rtsps', 'rtspu', 'sip', 'sips', 'mms', 'sftp', 'tel'])

type Split = { scheme: string; netloc: string; path: string; query: string; fragment: string }
type Parsed = Split & { params: string }

const isAsciiAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c)

/** Python's `str.lstrip` / `str.strip` with `_WHATWG_C0_CONTROL_OR_SPACE`: the C0 control characters and the space. */
function stripControl(s: string, left: boolean, right: boolean): string {
  let a = 0
  let b = s.length
  if (left) while (a < b && s.charCodeAt(a) <= 0x20) a++
  if (right) while (b > a && s.charCodeAt(b - 1) <= 0x20) b--
  return s.slice(a, b)
}


/** Is this an IPv4 address in dotted decimal, as `ipaddress.IPv4Address` reads one (no leading zeros)? */
const isIpv4 = (text: string): boolean => /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(text) && text.split('.').every((part) => Number(part) <= 255)

/** Is this an IPv6 address, as `ipaddress.IPv6Address` reads one (an optional `%scope` id, an embedded IPv4 tail)? */
function isIpv6(text: string): boolean {
  const percent = text.indexOf('%')
  let address = text
  if (percent >= 0) {
    const scope = text.slice(percent + 1)
    if (!scope || scope.includes('%')) return false
    address = text.slice(0, percent)
  }
  const parts = address.split(':')
  if (parts.length < 3) return false
  if (parts.at(-1)!.includes('.')) {
    // An IPv4 tail stands for two groups.
    const tail = parts.pop()!
    if (!isIpv4(tail)) return false
    parts.push('0', '0')
  }
  if (parts.length > 9) return false
  // Find the one place a run of zero groups may have been skipped: an empty group between the first and the last.
  let skip: number | undefined
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === '') {
      if (skip !== undefined) return false
      skip = i
    }
  }
  if (skip !== undefined) {
    let hi = skip
    let lo = parts.length - skip - 1
    if (!parts[0]) {
      hi -= 1
      if (hi) return false // a leading ':' is only allowed as part of '::'
    }
    if (!parts.at(-1)) {
      lo -= 1
      if (lo) return false // a trailing ':' is only allowed as part of '::'
    }
    if (8 - (hi + lo) < 1) return false
  } else if (parts.length !== 8 || !parts[0] || !parts.at(-1)) return false
  // Empty groups are only the ends of a '::'.
  const empty = new Set<number>(skip === undefined ? [] : [skip, ...(parts[0] ? [] : [0]), ...(parts.at(-1) ? [] : [parts.length - 1])])
  return parts.every((group, i) => (empty.has(i) ? group === '' : /^[0-9a-fA-F]{1,4}$/.test(group)))
}

/** `_check_bracketed_netloc`: what is in brackets must be an IPv6 address or an IPvFuture one. */
function checkBracketedNetloc(netloc: string): void {
  const hostnameAndPort = netloc.slice(netloc.lastIndexOf('@') + 1)
  const open = hostnameAndPort.indexOf('[')
  let hostname: string
  if (open >= 0) {
    // No data is allowed before a bracket.
    if (open > 0) throw new Error('Invalid IPv6 URL')
    const bracketed = hostnameAndPort.slice(open + 1)
    const close = bracketed.indexOf(']')
    hostname = close >= 0 ? bracketed.slice(0, close) : bracketed
    const port = close >= 0 ? bracketed.slice(close + 1) : ''
    // No data is allowed after the bracket but before the port delimiter.
    if (port && !port.startsWith(':')) throw new Error('Invalid IPv6 URL')
  } else hostname = hostnameAndPort.split(':')[0]!
  if (hostname.startsWith('v')) {
    if (!/^v[a-fA-F0-9]+\..+$/s.test(hostname)) throw new Error('IPvFuture address is invalid')
  } else if (isIpv4(hostname)) throw new Error('An IPv4 address cannot be in brackets')
  else if (!isIpv6(hostname)) throw new Error('Invalid IPv6 URL')
}

/** `_checknetloc`: a non-ASCII host that normalises to something with URL delimiters in it is refused. */
function checkNetloc(netloc: string): void {
  if (!netloc || [...netloc].every((c) => c.charCodeAt(0) < 128)) return
  const n = netloc.replaceAll('@', '').replaceAll(':', '').replaceAll('#', '').replaceAll('?', '')
  const normalized = n.normalize('NFKC')
  if (n === normalized) return
  if ([...'/?#@:'].some((c) => normalized.includes(c))) throw new Error(`netloc '${netloc}' contains invalid characters under NFKC normalization`)
}

/** `urlsplit(url, scheme)`; throws where Python raises ValueError. */
function urlsplit(url: string, scheme = ''): Split {
  url = stripControl(url, true, false).replace(/[\t\r\n]/g, '')
  scheme = stripControl(scheme, true, true).replace(/[\t\r\n]/g, '')
  let netloc = ''
  let query = ''
  let fragment = ''
  const i = url.indexOf(':')
  if (i > 0 && url.charCodeAt(0) < 128 && isAsciiAlpha(url[0]!) && [...url.slice(0, i)].every((c) => SCHEME_CHARS.has(c))) {
    scheme = url.slice(0, i).toLowerCase()
    url = url.slice(i + 1)
  }
  if (url.startsWith('//')) {
    let delim = url.length
    for (const c of '/?#') {
      const at = url.indexOf(c, 2)
      if (at >= 0) delim = Math.min(delim, at)
    }
    netloc = url.slice(2, delim)
    url = url.slice(delim)
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) throw new Error('Invalid IPv6 URL')
    if (netloc.includes('[') && netloc.includes(']')) checkBracketedNetloc(netloc)
  }
  if (url.includes('#')) [url, fragment] = [url.slice(0, url.indexOf('#')), url.slice(url.indexOf('#') + 1)]
  if (url.includes('?')) [url, query] = [url.slice(0, url.indexOf('?')), url.slice(url.indexOf('?') + 1)]
  checkNetloc(netloc)
  return { scheme, netloc, path: url, query, fragment }
}

function urlparse(url: string, scheme = ''): Parsed {
  const s = urlsplit(url, scheme)
  let { path } = s
  let params = ''
  if (USES_PARAMS.has(s.scheme) && path.includes(';')) {
    let i: number
    if (path.includes('/')) {
      i = path.indexOf(';', path.lastIndexOf('/'))
      if (i < 0) return { ...s, params }
    } else i = path.indexOf(';')
    params = path.slice(i + 1)
    path = path.slice(0, i)
  }
  return { ...s, path, params }
}

function urlunsplit(scheme: string, netloc: string, url: string, query: string, fragment: string): string {
  if (netloc || (scheme && USES_NETLOC.has(scheme) && url.slice(0, 2) !== '//')) {
    if (url && url[0] !== '/') url = `/${url}`
    url = `//${netloc}${url}`
  }
  if (scheme) url = `${scheme}:${url}`
  if (query) url = `${url}?${query}`
  if (fragment) url = `${url}#${fragment}`
  return url
}

const urlunparse = (p: Parsed): string => urlunsplit(p.scheme, p.netloc, p.params ? `${p.path};${p.params}` : p.path, p.query, p.fragment)

/** `urllib.parse.urljoin(base, url)`. */
export function urljoin(base: string, url: string): string {
  if (!base) return url
  if (!url) return base
  const b = urlparse(base)
  let u = urlparse(url, b.scheme)
  if (u.scheme !== b.scheme || !USES_RELATIVE.has(u.scheme)) return url
  if (USES_NETLOC.has(u.scheme)) {
    if (u.netloc) return urlunparse(u)
    u = { ...u, netloc: b.netloc }
  }
  if (!u.path && !u.params) {
    return urlunparse({ ...u, path: b.path, params: b.params, query: u.query || b.query })
  }
  const baseParts = b.path.split('/')
  if (baseParts[baseParts.length - 1] !== '') baseParts.pop()
  // For RFC 3986, ignore all base path should the first character be root.
  let segments: string[]
  if (u.path.startsWith('/')) segments = u.path.split('/')
  else {
    segments = [...baseParts, ...u.path.split('/')]
    // Filter out elements that would cause redundant slashes on re-joining the resolved path.
    segments = [segments[0]!, ...segments.slice(1, -1).filter(Boolean), ...(segments.length > 1 ? [segments[segments.length - 1]!] : [])]
  }
  const resolved: string[] = []
  for (const seg of segments) {
    if (seg === '..') resolved.pop()
    else if (seg !== '.') resolved.push(seg)
  }
  if (['.', '..'].includes(segments[segments.length - 1]!)) resolved.push('')
  return urlunparse({ ...u, path: resolved.join('/') || '/' })
}

// ---- feedparser/urls.py ----

const URI_SCHEMES = new Set<string>(sanitizer.schemes)

/** `_urljoin`: a URI with no run of slashes after `scheme://`, joined to the base; '' where Python's urljoin raises. */
export function feedUrljoin(base: string, uri: string): string {
  // The scheme's character class is Python's `[A-Za-z0-9+-.]`, a range that takes in the comma.
  uri = uri.replace(/^([A-Za-z][A-Za-z0-9+,\-.]*:\/\/)(\/*)(.*?)/s, '$1$3')
  try {
    return urljoin(base, uri)
  } catch {
    return ''
  }
}

/** `make_safe_absolute_uri(base, rel)`: the joined URI when its scheme is an acceptable one, else ''. */
export function makeSafeAbsoluteUri(base: string, rel?: string): string {
  if (!base) return rel ?? ''
  if (!rel) {
    let scheme: string
    try {
      scheme = urlparse(base).scheme
    } catch {
      return ''
    }
    return !scheme || URI_SCHEMES.has(scheme) ? base : ''
  }
  const uri = feedUrljoin(base, rel)
  return URI_SCHEMES.has(uri.trim().split(':')[0]!) ? uri : ''
}
