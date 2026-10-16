// Reply text carries [[widget:<id>]] tokens; the web app renders them as chips.
import { WIDGET_CHIP_RE } from '@terminal/core'

export type ReplyPart = { type: 'text'; text: string } | { type: 'chip'; id: string }

export function parseReply(text: string): ReplyPart[] {
  const parts: ReplyPart[] = []
  const re = new RegExp(WIDGET_CHIP_RE.source, 'g')
  let last = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) })
    parts.push({ type: 'chip', id: m[1]! })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}

export function widgetDomId(widgetId: string): string {
  return `widget-${widgetId}`
}

/** Scroll the widget into view and flash it. Pure DOM so chips need no store. */
export function highlightWidget(widgetId: string): void {
  const el = document.getElementById(widgetDomId(widgetId))
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove('flash')
  // Restart the animation when the same widget is flashed twice in a row.
  void el.offsetWidth
  el.classList.add('flash')
  const clear = () => el.classList.remove('flash')
  el.addEventListener('animationend', clear, { once: true })
  setTimeout(clear, 1200)
}
