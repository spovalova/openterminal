import { useEffect, useMemo, useRef, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, type Frame, type Size } from '@terminal/core'
import { useWidth } from './use-width'
import { EMPTY_CELL, EmptyState, formatCell } from '@terminal/ui'
import type { ViewProps } from './types'

/** One contract's quoted fields, nulls where the source had none. */
export type Contract = {
  bid: number | null
  ask: number | null
  last: number | null
  volume: number | null
  open_interest: number | null
  iv: number | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
}
const CONTRACT_FIELDS = ['bid', 'ask', 'last', 'volume', 'open_interest', 'iv', 'delta', 'gamma', 'theta', 'vega'] as const
type ContractField = (typeof CONTRACT_FIELDS)[number]

/** One strike with the call and the put listed at it (either may be missing). */
export type ChainRow = { strike: number; call: Contract | null; put: Contract | null }

export type Chain = {
  symbol: string | null
  expiration: string | null
  dte: number | null
  underlying: number | null
  /** Strikes ascending, one row each. */
  rows: ChainRow[]
  /** Index of the row whose strike is nearest the underlying price; -1 without a price. */
  atmIndex: number
  hasCalls: boolean
  hasPuts: boolean
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Pivot an `options` frame (one row per contract) into one row per strike with a call and a put side. */
export function buildChain(frame: Frame): Chain {
  const iStrike = columnIndex(frame, 'strike')
  const iType = columnIndex(frame, 'type')
  const iSymbol = columnIndex(frame, 'symbol')
  const iExp = columnIndex(frame, 'expiration')
  const iDte = columnIndex(frame, 'dte')
  const iUnderlying = columnIndex(frame, 'underlying_price')
  const fieldIdx = Object.fromEntries(CONTRACT_FIELDS.map((f) => [f, columnIndex(frame, f)])) as Record<ContractField, number>

  const byStrike = new Map<number, ChainRow>()
  let symbol: string | null = null
  let expiration: string | null = null
  let dte: number | null = null
  let underlying: number | null = null
  let hasCalls = false
  let hasPuts = false

  if (iStrike >= 0 && iType >= 0) {
    for (const row of frame.rows) {
      const strike = num(row[iStrike])
      const type = row[iType]
      if (strike == null || (type !== 'call' && type !== 'put')) continue
      if (symbol == null && iSymbol >= 0 && typeof row[iSymbol] === 'string') symbol = row[iSymbol] as string
      if (expiration == null && iExp >= 0 && typeof row[iExp] === 'string') expiration = row[iExp] as string
      if (dte == null && iDte >= 0) dte = num(row[iDte])
      if (underlying == null && iUnderlying >= 0) underlying = num(row[iUnderlying])
      const contract = {} as Contract
      for (const f of CONTRACT_FIELDS) contract[f] = fieldIdx[f] >= 0 ? num(row[fieldIdx[f]]) : null
      let entry = byStrike.get(strike)
      if (!entry) byStrike.set(strike, (entry = { strike, call: null, put: null }))
      if (type === 'call') {
        entry.call = contract
        hasCalls = true
      } else {
        entry.put = contract
        hasPuts = true
      }
    }
  }

  const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike)
  let atmIndex = -1
  if (underlying != null) {
    let best = Infinity
    rows.forEach((r, i) => {
      const d = Math.abs(r.strike - underlying)
      if (d < best) {
        best = d
        atmIndex = i
      }
    })
  }
  return { symbol, expiration, dte, underlying, rows, atmIndex, hasCalls, hasPuts }
}

/** A call is in the money below the underlying price, a put above it. */
export function inTheMoney(side: 'call' | 'put', strike: number, underlying: number | null): boolean {
  if (underlying == null) return false
  return side === 'call' ? strike < underlying : strike > underlying
}

type SideColumn = { key: ContractField; label: string; format: (v: number | null) => string }
const fmtPrice = (v: number | null) => formatCell(v, 'price')
const fmtInt = (v: number | null) => formatCell(v, 'integer')
const fmtIv = (v: number | null) => (v == null ? EMPTY_CELL : `${v.toFixed(1)}%`)
const fmtDelta = (v: number | null) => (v == null ? EMPTY_CELL : v.toFixed(2))

const ALL_COLUMNS: SideColumn[] = [
  { key: 'bid', label: 'Bid', format: fmtPrice },
  { key: 'ask', label: 'Ask', format: fmtPrice },
  { key: 'last', label: 'Last', format: fmtPrice },
  { key: 'volume', label: 'Vol', format: fmtInt },
  { key: 'open_interest', label: 'OI', format: fmtInt },
  { key: 'iv', label: 'IV', format: fmtIv },
  { key: 'delta', label: 'Delta', format: fmtDelta },
]
/**
 * Per-side columns by the view's width (the widget body, not the size enum), so a wide hero in a narrow
 * grid still fits and never scrolls sideways. Thresholds leave each column about 60px.
 */
const WIDTH_TIERS: { min: number; keys: ContractField[] }[] = [
  { min: 840, keys: ['bid', 'ask', 'last', 'volume', 'open_interest', 'iv', 'delta'] },
  { min: 660, keys: ['bid', 'ask', 'last', 'open_interest', 'iv'] },
  { min: 480, keys: ['bid', 'ask', 'open_interest', 'iv'] },
  { min: 400, keys: ['bid', 'ask', 'iv'] },
  { min: 0, keys: ['bid', 'ask'] },
]

/** The per-side columns that fit a view of this width. */
export function sideColumns(width: number): SideColumn[] {
  const tier = WIDTH_TIERS.find((t) => width >= t.min) ?? WIDTH_TIERS[WIDTH_TIERS.length - 1]!
  return ALL_COLUMNS.filter((c) => tier.keys.includes(c.key))
}

/** Width to assume before the view is measured (or without ResizeObserver): a size's usual width. */
export function hintWidth(size: Size): number {
  return size === 'sm' ? 700 : Infinity
}

/** "2026-10-24" → "Oct 24, 2026"; anything else passes through. */
function formatExpiration(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

const ATM_SHADOW = 'shadow-[inset_0_1px_0_var(--color-accent),inset_0_-1px_0_var(--color-accent)]'

/**
 * `chain` view: the classic option chain. Calls on the left, the strike spine in the middle, puts on
 * the right, one row per strike. The row nearest the underlying price is marked, in-the-money cells
 * are shaded (calls below the price, puts above), and the body scrolls with the strike nearest the
 * price centred on first paint.
 */
export const ChainView: FC<ViewProps> = ({ widget, frame }) => {
  const chain = useMemo(() => buildChain(frame), [frame])
  const [rootRef, measured] = useWidth()
  const width = measured ?? hintWidth(widget.size)
  const columns = sideColumns(width)
  const narrow = width < 660
  const scrollRef = useRef<HTMLDivElement>(null)
  const atmRef = useRef<HTMLTableRowElement>(null)

  useEffect(() => {
    const box = scrollRef.current
    const row = atmRef.current
    if (!box || !row) return
    const target = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2
    if (Number.isFinite(target) && target > 0) box.scrollTop = target
  }, [chain])

  if (chain.rows.length === 0) {
    return <EmptyState title="No contracts" hint="No calls or puts matched this expiration and strike window." />
  }

  const showCalls = chain.hasCalls || !chain.hasPuts
  const showPuts = chain.hasPuts || !chain.hasCalls
  const callColumns = [...columns].reverse()
  const n = columns.length

  // border-separate (not collapse) so the sticky header's cell backgrounds cover the rows scrolling under it.
  const pad = narrow ? 'px-1.5' : 'px-2'
  const cellCls = `num h-6 ${pad} text-right whitespace-nowrap border-b border-border/60`
  const headCls = `h-6 ${pad} text-right whitespace-nowrap border-b border-border bg-surface text-[11px] font-medium text-fg-3`

  return (
    <div ref={rootRef} data-view="chain" data-size={widget.size} data-columns={columns.length} className="flex h-full w-full flex-col overflow-hidden">
      {/* The chain's own header line: the same facts as the widget sub-header, kept for the expand dialog and the gallery. */}
      <div data-chain-header="" className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-b border-border px-3 text-xs whitespace-nowrap text-fg-2">
        {chain.symbol && <span className="num font-semibold text-fg">{chain.symbol}</span>}
        {chain.expiration && <span data-field="expiration">{formatExpiration(chain.expiration)}</span>}
        {chain.dte != null && (
          <span data-field="dte" className="num">
            {chain.dte} DTE
          </span>
        )}
        {chain.underlying != null && (
          <span data-field="underlying" className="ml-auto">
            Underlying <span className="num font-medium text-fg">{formatCell(chain.underlying, 'price')}</span>
          </span>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              {showCalls && (
                <th scope="colgroup" colSpan={n} className="h-5 border-b border-border bg-surface text-center text-[10px] font-medium tracking-wider text-fg-3 uppercase">
                  Calls
                </th>
              )}
              <th scope="col" rowSpan={2} className={clsx('h-5 border-x border-b border-border bg-surface-2 text-center text-[11px] font-medium text-fg-2', pad)}>
                Strike
              </th>
              {showPuts && (
                <th scope="colgroup" colSpan={n} className="h-5 border-b border-border bg-surface text-center text-[10px] font-medium tracking-wider text-fg-3 uppercase">
                  Puts
                </th>
              )}
            </tr>
            <tr>
              {showCalls && callColumns.map((c) => <th key={`c-${c.key}`} scope="col" className={headCls}>{c.label}</th>)}
              {showPuts && columns.map((c) => <th key={`p-${c.key}`} scope="col" className={headCls}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {chain.rows.map((row, i) => {
              const atm = i === chain.atmIndex
              const callItm = inTheMoney('call', row.strike, chain.underlying)
              const putItm = inTheMoney('put', row.strike, chain.underlying)
              const side = (contract: Contract | null, cols: SideColumn[], kind: 'call' | 'put', itm: boolean) =>
                cols.map((c) => {
                  const v = contract ? contract[c.key] : null
                  const text = c.format(v)
                  return (
                    <td key={`${kind}-${c.key}`} data-side={kind} data-itm={itm ? '' : undefined} className={clsx(cellCls, itm && 'bg-fg/8', atm && ATM_SHADOW, text === EMPTY_CELL ? 'text-fg-3' : 'text-fg')}>
                      {text}
                    </td>
                  )
                })
              return (
                <tr key={row.strike} ref={atm ? atmRef : undefined} data-strike={row.strike} data-atm={atm ? '' : undefined} className="hover:bg-surface-2">
                  {showCalls && side(row.call, callColumns, 'call', callItm)}
                  <td data-field="strike" className={clsx(cellCls, 'border-x border-border bg-surface-2 text-center font-medium', atm ? clsx('text-accent', ATM_SHADOW) : 'text-fg')}>
                    {formatCell(row.strike, 'price')}
                  </td>
                  {showPuts && side(row.put, columns, 'put', putItm)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
