import { flushSync } from 'react-dom'

type DocWithVT = Document & { startViewTransition?: (cb: () => void | Promise<void>) => unknown }

/** Run a state change inside a view transition when the browser supports it; otherwise just run it. */
export function withViewTransition(update: () => void): void {
  const doc = typeof document !== 'undefined' ? (document as DocWithVT) : undefined
  if (doc && typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    doc.startViewTransition(() => {
      flushSync(update)
    })
    return
  }
  update()
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
