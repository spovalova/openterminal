export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent)

/** The modifier key label for hints: ⌘ on Mac, Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl'

export function isModKey(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/** True when the key event came from somewhere the user is typing. */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export const TICKER_RE = /^[A-Z]{1,5}(?:\.[A-Z])?$/

/** The ticker shortcut: an upper-case ticker typed alone becomes "Overview of <ticker>". */
export function tickerPrompt(text: string): { ticker: string; prompt: string } | null {
  const t = text.trim()
  return TICKER_RE.test(t) ? { ticker: t, prompt: `Overview of ${t}` } : null
}
