import { useEffect, useState, type FC } from 'react'
import clsx from 'clsx'
import { describeMarketTime, nextTradingDay, nyDate, sessionAt, type Session } from '@openterminal/core'

const SESSION_LABEL: Record<Session, string> = { regular: 'open', pre: 'pre-market', post: 'after-hours', closed: 'closed' }
const SESSION_CLASS: Record<Session, string> = { regular: 'text-up', pre: 'text-accent', post: 'text-accent', closed: 'text-fg-3' }

/** The status-bar line: `describeMarketTime` ("Saturday 2026-10-18 23:40 ET, market closed") and, when closed, the next session day. */
export function marketLine(now: number): { text: string; session: Session; next?: string } {
  const session = sessionAt(now)
  const text = describeMarketTime(now)
  if (session !== 'closed') return { text, session }
  return { text, session, next: nextTradingDay(nyDate(now)) }
}

/** The market strip in the status bar (PLAN.md section 17, "Shell"), from the clock module, refreshed every 30 s. */
export const MarketStrip: FC<{ now?: () => number }> = ({ now = Date.now }) => {
  const [at, setAt] = useState(() => now())
  useEffect(() => {
    const id = setInterval(() => setAt(now()), 30_000)
    return () => clearInterval(id)
  }, [now])
  const m = marketLine(at)
  return (
    <span data-market-strip="" className="flex items-center gap-2" title={m.next ? `Next session ${m.next}` : undefined}>
      <span className={clsx('text-[9px]', SESSION_CLASS[m.session])} aria-hidden>
        ●
      </span>
      <span className="num">{m.text}</span>
      {m.session !== 'closed' && <span className={SESSION_CLASS[m.session]}>{SESSION_LABEL[m.session]}</span>}
      {m.next && <span className="text-fg-3">· next {m.next}</span>}
    </span>
  )
}
