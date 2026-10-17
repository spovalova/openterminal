import type { FC, PropsWithChildren, ReactNode } from 'react'
import clsx from 'clsx'
import type { Size } from '@terminal/core'
import { IconButton } from './IconButton.js'
import { Skeleton } from './Skeleton.js'
import { EmptyState } from './EmptyState.js'
import { AlertIcon, ExpandIcon, PencilIcon, RefreshIcon } from './icons.js'

export type WidgetFrameProps = PropsWithChildren<{
  title: string
  size: Size
  loading?: boolean
  error?: string
  empty?: boolean
  onEdit?: () => void
  onRefresh?: () => void
  onExpand?: () => void
  /** Extra content on the right of the title (e.g. a legend or a range label). */
  meta?: ReactNode
  className?: string
  id?: string
}>

/** Grid spans per size: lg 2x2, md 2x1, sm 1x1 (mirrors SIZE_SPANS in core). */
export const sizeClass: Record<Size, string> = {
  lg: 'col-span-2 row-span-2',
  md: 'col-span-2 row-span-1',
  sm: 'col-span-1 row-span-1',
}

/**
 * The chrome around a view: title bar with edit / refresh / expand (only when
 * the handler is given) and loading, error, and empty states in place of children.
 */
export const WidgetFrame: FC<WidgetFrameProps> = ({
  title,
  size,
  loading,
  error,
  empty,
  onEdit,
  onRefresh,
  onExpand,
  meta,
  className,
  id,
  children,
}) => {
  let body: ReactNode
  if (loading) {
    body = (
      <div className="flex h-full flex-col gap-2 p-3" aria-busy="true">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="min-h-0 flex-1 w-full" />
      </div>
    )
  } else if (error) {
    body = (
      <EmptyState
        icon={<AlertIcon size={16} className="text-down" />}
        title="Could not load"
        hint={<span className="font-mono break-words text-fg-3">{error}</span>}
      />
    )
  } else if (empty) {
    body = <EmptyState title="No data" hint="The query returned no rows." />
  } else {
    body = children
  }

  return (
    <section
      id={id}
      data-size={size}
      className={clsx(
        'group/widget flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface',
        sizeClass[size],
        className,
      )}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={title}>
          {title}
        </h3>
        {meta && <div className="flex min-w-0 shrink items-center gap-2 text-xs text-fg-2">{meta}</div>}
        {(onEdit || onRefresh || onExpand) && (
          <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover/widget:opacity-100 focus-within:opacity-100">
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
      <div className="relative min-h-0 min-w-0 flex-1">{body}</div>
    </section>
  )
}
