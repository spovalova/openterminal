import { useMemo, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, controlFor, type FactsControl, type Frame } from '@terminal/core'
import { EMPTY_CELL, EmptyState, direction, formatCell, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'
import { cellFormat } from './TableView'
import { datasetsFor, primaryFrame, viewOf } from './fields'
import { columnLabel } from './legacy'

export type Fact = { column: string; label: string; text: string; format: CellFormat; dir: 'up' | 'down' | null; raw: unknown }

/** The facts of a one-row frame (the first row when there are more), in the control's column order; nulls shown as a dash. */
export function factsOf(frame: Frame, control: FactsControl, row = 0): Fact[] {
  const r = frame.rows[row]
  if (!r) return []
  const out: Fact[] = []
  for (const column of control.columns) {
    const i = columnIndex(frame, column)
    if (i < 0) continue
    const format = cellFormat(control.formats[column] ?? 'text')
    const raw = r[i]
    const text = formatCell(raw, format)
    out.push({ column, label: control.labels[column] ?? columnLabel(column), text, format, dir: format === 'change' ? direction(raw) : null, raw })
  }
  return out
}

/** The facts control for a widget: its own when it is a facts view, else the table's columns as facts (the one-row rule). */
export function factsControlOf(widget: ViewProps['widget'], frames: Record<string, Frame>): FactsControl | undefined {
  const view = viewOf(widget)
  const datasets = datasetsFor(widget, frames)
  const facts = view.preset === 'facts' ? view : { preset: 'facts' as const, ...(view.data ? { data: view.data } : {}), ...(view.preset === 'table' && view.columns ? { columns: view.columns } : {}) }
  const control = controlFor(facts, datasets)
  return control?.kind === 'facts' ? control : undefined
}

/**
 * `facts` preset, and what a `table` renders over one row (product rule 8): label over value, wrapped to the
 * width, the same formats and mono numbers as the table, signed changes coloured, long text truncated with the
 * full value on hover. A frame with several rows shows the first row's facts.
 */
export const FactsCard: FC<ViewProps> = ({ widget, frames }) => {
  const control = useMemo(() => factsControlOf(widget, frames), [widget, frames])
  const frame = control ? frames[control.data] : primaryFrame(widget, frames)
  const facts = useMemo(() => (frame && control ? factsOf(frame, control) : []), [frame, control])
  if (!frame || frame.rows.length === 0) return <EmptyState title="No data" hint="The query returned no rows." />
  if (facts.length === 0) return <EmptyState title="No facts" hint="The frame has no columns to show." />
  return (
    <div data-view="facts" data-count={facts.length} data-few={facts.length <= 6 ? '' : undefined} className="facts-card h-full w-full overflow-x-hidden overflow-y-auto p-3">
      {facts.map((f) => {
        const long = f.format === 'text' && typeof f.raw === 'string' && f.raw.length > 40
        return (
          <div key={f.column} data-fact={f.column} className="flex min-w-0 flex-col gap-0.5 border-b border-border/60 pb-1.5">
            <div className="truncate text-xs leading-4 text-fg-3" title={f.label}>
              {f.label}
            </div>
            <div
              data-field="value"
              title={long ? String(f.raw) : undefined}
              className={clsx(
                'min-w-0 truncate text-sm leading-5',
                f.format !== 'text' && f.format !== 'link' && 'num',
                f.text === EMPTY_CELL ? 'text-fg-3' : f.dir === 'up' ? 'text-up' : f.dir === 'down' ? 'text-down' : 'text-fg',
              )}
            >
              {f.text}
            </div>
          </div>
        )
      })}
    </div>
  )
}
