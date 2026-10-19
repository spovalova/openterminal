import { useEffect, useRef, useState, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, type Frame } from '@openterminal/core'
import { IconButton, formatCell } from '@openterminal/ui'
import { api } from '../api'

/** Short labels for the default strip; anything else shows its symbol. */
export const TICKER_LABELS: Record<string, string> = { '^GSPC': 'SPX', '^NDX': 'NDX', '^TNX': '10Y', '^VIX': 'VIX', 'CL=F': 'Oil', 'GC=F': 'Gold', '^DJI': 'DJI', '^RUT': 'RUT', 'BTC-USD': 'BTC', 'ES=F': 'ES', 'NQ=F': 'NQ', 'SI=F': 'Silver', 'DX-Y.NYB': 'DXY' }

const PRICE_COLUMNS = ['price', 'last_price', 'regularMarketPrice', 'close', 'last', 'value', 'c']
const CHANGE_COLUMNS = ['change_pct', 'change_percent', 'regularMarketChangePercent', 'changesPercentage', 'dp']
const PREV_COLUMNS = ['prev_close', 'previous_close', 'regularMarketPreviousClose', 'pc']

export type TickerQuote = { symbol: string; price: number | null; changePct: number | null }

/** The quote a frame holds for a symbol, tolerant of the column names the quote routes use (v1 kind, OpenBB yfinance, yahoo). */
export function quoteFromFrame(frame: Frame, symbol: string): TickerQuote {
  const si = columnIndex(frame, 'symbol')
  const row = frame.rows.find((r) => si < 0 || String(r[si]).toUpperCase() === symbol.toUpperCase()) ?? frame.rows[0]
  const num = (names: string[]): number | null => {
    for (const n of names) {
      const i = columnIndex(frame, n)
      const v = row?.[i]
      if (i >= 0 && typeof v === 'number' && Number.isFinite(v)) return v
    }
    return null
  }
  const price = num(PRICE_COLUMNS)
  let changePct = num(CHANGE_COLUMNS)
  if (changePct === null && price !== null) {
    const prev = num(PREV_COLUMNS)
    if (prev) changePct = ((price - prev) / prev) * 100
  }
  return { symbol, price, changePct }
}

/** When to ask again: the frame's own TTL, never under 15 s (quotes are 10 s; the strip is not a widget). */
export function nextDelay(frame: Frame | undefined, now: number, min = 15_000, error = 60_000): number {
  if (!frame) return error
  return Math.max(min, frame.meta.fetchedAt + frame.meta.ttl - now)
}

/** One `{ recipe: 'quote' }` dataset per symbol, each refreshed on its own TTL. */
function useQuote(symbol: string): { quote: TickerQuote | null; error: boolean } {
  const [quote, setQuote] = useState<TickerQuote | null>(null)
  const [error, setError] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      let frame: Frame | undefined
      try {
        frame = await api.query({ recipe: 'quote', params: { symbols: [symbol] } })
        if (!alive) return
        setQuote(quoteFromFrame(frame, symbol))
        setError(false)
      } catch {
        if (!alive) return
        setError(true)
      }
      timer.current = setTimeout(() => void tick(), nextDelay(frame, Date.now()))
    }
    void tick()
    return () => {
      alive = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [symbol])
  return { quote, error }
}

const TickerItem: FC<{ symbol: string }> = ({ symbol }) => {
  const { quote, error } = useQuote(symbol)
  const label = TICKER_LABELS[symbol] ?? symbol
  const dir = quote?.changePct == null ? null : quote.changePct > 0 ? 'up' : quote.changePct < 0 ? 'down' : null
  return (
    <div data-ticker={symbol} className="flex shrink-0 items-baseline gap-1.5 px-3 text-xs" title={symbol}>
      <span className="font-medium text-fg-2">{label}</span>
      {quote?.price != null ? (
        <>
          <span className="num text-fg">{formatCell(quote.price, 'price')}</span>
          <span className={clsx('num', dir === 'up' && 'text-up', dir === 'down' && 'text-down', dir === null && 'text-fg-3')}>{quote.changePct == null ? '' : formatCell(quote.changePct, 'change')}</span>
        </>
      ) : (
        <span className="num text-fg-3">{error ? 'n/a' : '…'}</span>
      )}
    </div>
  )
}

/**
 * The ticker strip under the tabs (PLAN.md section 17, "UI changes from the Instinct reference"): four to six live
 * quotes the user chooses, SPX NDX 10y VIX oil gold by default, stored in the server's settings so every browser
 * shows the same strip. Click the pencil to edit the list.
 */
export const TickerStrip: FC = () => {
  const [symbols, setSymbols] = useState<string[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .setting<string[]>('ticker')
      .then((v) => setSymbols(Array.isArray(v) ? v : []))
      .catch(() => setSymbols([]))
  }, [])

  const save = async () => {
    const list = text.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 12)
    if (list.length === 0) return
    setSaving(true)
    try {
      setSymbols(await api.setSetting('ticker', list))
      setEditing(false)
    } catch {
      /* keep editing */
    } finally {
      setSaving(false)
    }
  }

  if (symbols === null) return null
  return (
    <div data-ticker-strip="" className="flex h-7 items-center overflow-hidden border-b border-border bg-bg">
      <div className="flex min-w-0 flex-1 items-center divide-x divide-border overflow-x-auto">
        {editing ? (
          <form
            className="flex items-center gap-2 px-3"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <input
              autoFocus
              aria-label="Ticker symbols"
              className="num w-[min(60vw,420px)] rounded border border-border bg-surface px-2 py-0.5 text-xs text-fg outline-none focus:border-accent"
              value={text}
              placeholder="^GSPC, ^NDX, ^TNX, ^VIX, CL=F, GC=F"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <button type="submit" className="text-xs text-accent hover:underline" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="text-xs text-fg-2 hover:text-fg" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          symbols.map((s) => <TickerItem key={s} symbol={s} />)
        )}
      </div>
      {!editing && (
        <IconButton
          label="Edit ticker strip"
          onClick={() => {
            setText(symbols.join(', '))
            setEditing(true)
          }}
        >
          <span aria-hidden className="text-[11px]">
            ✎
          </span>
        </IconButton>
      )}
    </div>
  )
}
