import type { FC } from 'react'
import { describeQuery, type AnyQuery, type Frame } from '@terminal/core'
import { Spinner } from '@terminal/ui'
import { VirtualTable } from './VirtualTable'

export type PreviewState = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; frame: Frame; ms: number } | { status: 'error'; error: string; traceback?: string }

export const idlePreview: PreviewState = { status: 'idle' }

/** One line about a frame: rows, columns, connector, route, TTL. */
export function frameSummary(frame: Frame): string {
  const l = frame.meta.lineage
  const via = l?.route ? `${l.connector} ${l.route}${l.provider ? ` (${l.provider})` : ''}` : frame.meta.connector
  const ttl = frame.meta.ttl >= 60_000 ? `${Math.round(frame.meta.ttl / 60_000)} min` : `${Math.round(frame.meta.ttl / 1000)} s`
  return `${frame.rows.length} rows · ${frame.columns.length} columns · ${via} · ttl ${ttl}`
}

/** The units stamped on a frame's columns, for the preview's header. */
export function unitLine(frame: Frame): string {
  const fields = frame.meta.fields ?? {}
  const parts = frame.columns.flatMap((c) => (fields[c.name]?.unit ? [`${c.name}: ${fields[c.name]!.unit}`] : []))
  return parts.join(' · ')
}

/** A dataset's preview: the frame as a (virtualised) table, or the error with its traceback inline. */
export const FramePreview: FC<{ preview: PreviewState; query?: AnyQuery; height?: number }> = ({ preview, query, height = 220 }) => {
  if (preview.status === 'idle') return <div className="text-fg-3">{query ? `Preview runs ${describeQuery(query)}.` : 'No preview yet.'}</div>
  if (preview.status === 'loading')
    return (
      <div className="flex items-center gap-2 text-fg-2">
        <Spinner /> Running…
      </div>
    )
  if (preview.status === 'error')
    return (
      <div data-preview="error" className="flex flex-col gap-1">
        <div className="text-down">{preview.error}</div>
        {preview.traceback && <pre className="num max-h-48 overflow-auto rounded border border-down/40 bg-bg px-2 py-1 text-xs whitespace-pre-wrap text-fg-2">{preview.traceback}</pre>}
      </div>
    )
  const units = unitLine(preview.frame)
  return (
    <div data-preview="ok" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-fg-2">
        <span>{frameSummary(preview.frame)}</span>
        <span className="num text-fg-3">{preview.ms} ms</span>
      </div>
      {units && <div className="truncate text-[11px] text-fg-3" title={units}>{units}</div>}
      <div className="@container/widget rounded border border-border" style={{ height }}>
        {preview.frame.rows.length === 0 ? <div className="p-3 text-fg-3">The query returned no rows.</div> : <VirtualTable columns={preview.frame.columns} rows={preview.frame.rows} />}
      </div>
    </div>
  )
}
