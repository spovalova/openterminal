import type { FC, PropsWithChildren, ReactNode } from 'react'
import clsx from 'clsx'
import type { Size } from '@openterminal/core'
import { IconButton } from './IconButton.js'
import { Skeleton } from './Skeleton.js'
import { EmptyState } from './EmptyState.js'
import { AlertIcon, ExpandIcon, PencilIcon, RefreshIcon } from './icons.js'

export type WidgetFrameProps = PropsWithChildren<{
  /** The header: the widget's title. */
  title: string
  /** The sub-header: what the query is about, at a glance ("NVDA · 5m · today"). Derived, never typed. */
  subtitle?: string
  size: Size
  loading?: boolean
  error?: string
  empty?: boolean
  /** Replaces the default "No data" copy when `empty`. */
  emptyHint?: ReactNode
  onEdit?: () => void
  onRefresh?: () => void
  onExpand?: () => void
  /** Extra content on the right of the header, before the actions (a status, a range label). */
  meta?: ReactNode
  className?: string
  id?: string
  /**
   * `content` (round 2): the body is as tall as the view's content, not the cell, so the grid can measure a card's
   * natural height and end its track there; the frame still fills its cell. `fill` (default): the body takes the cell.
   */
  fit?: 'fill' | 'content'
}>

/** Grid spans per size: lg 2x2, md 2x1, sm 1x1 (mirrors SIZE_SPANS in core). */
export const sizeClass: Record<Size, string> = {
  lg: 'col-span-2 row-span-2',
  md: 'col-span-2 row-span-1',
  sm: 'col-span-1 row-span-1',
}

/**
 * The chrome around a view. A header with the title over a sub-header and the actions (edit, refresh,
 * expand, only when the handler is given) at the right, quiet until hovered; then the body, which is
 * the `widget` container the views and DataTable columns respond to. Loading, error and empty states
 * take the body's place on the same 12px grid as the header.
 */
export const WidgetFrame: FC<WidgetFrameProps> = ({
  title,
  subtitle,
  size,
  loading,
  error,
  empty,
  emptyHint,
  onEdit,
  onRefresh,
  onExpand,
  meta,
  className,
  id,
  fit = 'fill',
  children,
}) => {
  let body: ReactNode
  if (loading) {
    body = (
      <div className="flex h-full flex-col gap-2 p-3" aria-busy="true">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="min-h-0 w-full flex-1" />
      </div>
    )
  } else if (error) {
    body = (
      <EmptyState
        icon={<AlertIcon size={16} className="text-down" />}
        title="Could not load"
        hint={<span className="num break-words text-fg-3">{error}</span>}
      />
    )
  } else if (empty) {
    body = <EmptyState title="No data" hint={emptyHint ?? 'The query returned no rows.'} />
  } else {
    body = children
  }

  const actions = onEdit || onRefresh || onExpand

  return (
    <section
      id={id}
      data-size={size}
      aria-label={title}
      className={clsx(
        'widget-frame group/widget flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface',
        sizeClass[size],
        className,
      )}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border py-2 pr-2 pl-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-sm leading-4 font-medium text-fg" title={title}>
            {title}
          </h3>
          {/* Wraps to two lines at word boundaries in a narrow cell rather than cutting mid-word (section 17 checklist). */}
          <div className="line-clamp-2 text-xs leading-4 break-words text-fg-3" data-subtitle="" title={subtitle}>
            {subtitle ?? ' '}
          </div>
        </div>
        {meta && <div className="flex min-w-0 shrink items-center gap-2 pt-px text-xs text-fg-2">{meta}</div>}
        {actions && (
          <div className="widget-actions -mt-0.5 flex shrink-0 items-center gap-px">
            {onEdit && (
              <IconButton label="Edit" onClick={onEdit}>
                <PencilIcon />
              </IconButton>
            )}
            {onRefresh && (
              <IconButton label="Refresh" onClick={onRefresh} disabled={loading}>
                <RefreshIcon className={clsx(loading && 'animate-spin')} />
              </IconButton>
            )}
            {onExpand && (
              <IconButton label="Expand" onClick={onExpand}>
                <ExpandIcon />
              </IconButton>
            )}
          </div>
        )}
      </header>
      {/* The `widget` container: views and DataTable columns respond to this width, not the size enum. */}
      <div data-body="" data-fit={fit} className={clsx('@container/widget relative min-w-0 overflow-hidden', fit === 'content' && !loading && !error && !empty ? 'shrink-0' : 'min-h-0 flex-1')}>
        {body}
      </div>
    </section>
  )
}
