import { useMemo, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, controlFor, enumLabel, type FactsControl, type Frame } from '@openterminal/core'
import { EMPTY_CELL, EmptyState, direction, formatCell, type CellFormat } from '@openterminal/ui'
import type { ViewProps } from './types'
import { ONE_SIGNED, cellFormat } from './TableView'
import { datasetsFor, primaryFrame, viewOf } from './fields'
import { columnLabel } from './labels'
import { FieldGrid } from './FieldGrid'

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
    // A string that reads as an enum (`after-hours`, `buy`, `not-supplied`) gets its display reading (change 11).
    const text = format === 'text' && typeof raw === 'string' ? enumLabel(formatCell(raw, format)) : formatCell(raw, format)
    out.push({ column, label: control.labels[column] ?? columnLabel(column), text, format, dir: format === 'change' && !ONE_SIGNED.test(column) ? direction(raw) : null, raw })
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

const NUMERIC: ReadonlySet<CellFormat> = new Set<CellFormat>(['price', 'percent', 'change', 'integer', 'compact'])

/**
 * The one fact a card sets large (change 3): the field marked `key`, else the first numeric fact. Dates, enums and
 * strings are never the hero; a card of only strings has none.
 */
export function heroFact(facts: readonly Fact[], fields: Record<string, { key?: boolean }> = {}): Fact | undefined {
  return facts.find((f) => fields[f.column]?.key && NUMERIC.has(f.format)) ?? facts.find((f) => NUMERIC.has(f.format))
}

/**
 * `facts` preset, and what a `table` renders over one row (product rule 8): one hero number, then every other field
 * as label : value at body size in a two- or three-column grid, the same formats and mono numbers as the table,
 * signed changes coloured, long text truncated with the full value on hover. The card's height is its content: it
 * centres when it fits and scrolls when it does not, so nothing renders under the header or clips at the foot.
 */
export const FactsCard: FC<ViewProps> = ({ widget, frames }) => {
  const control = useMemo(() => factsControlOf(widget, frames), [widget, frames])
  const frame = control ? frames[control.data] : primaryFrame(widget, frames)
  const facts = useMemo(() => (frame && control ? factsOf(frame, control) : []), [frame, control])
  const fields = useMemo(() => (control ? (datasetsFor(widget, frames)[control.data]?.fields ?? {}) : {}), [widget, frames, control])
  if (!frame || frame.rows.length === 0) return <EmptyState title="No data" hint="The query returned no rows." />
  if (facts.length === 0) return <EmptyState title="No facts" hint="The frame has no columns to show." />
  const hero = heroFact(facts, fields)
  const rest = facts.filter((f) => f !== hero)
  return (
    <div data-view="facts" data-count={facts.length} className="facts-card flex w-full flex-col overflow-x-hidden p-3">
      {/* Round 2: hero, 8px, the fields, and the card ends there; the grid sizes the track to this content. */}
      <div className="flex flex-col gap-2">
        {hero && (
          <div data-fact={hero.column} data-hero="" className="flex min-w-0 flex-col">
            <div className="truncate text-xs leading-4 text-fg-3" title={hero.label}>
              {hero.label}
            </div>
            <div data-field="value" className={clsx('facts-hero num truncate font-semibold', hero.text === EMPTY_CELL ? 'text-fg-3' : hero.dir === 'up' ? 'text-up' : hero.dir === 'down' ? 'text-down' : 'text-fg')}>
              {hero.text}
            </div>
          </div>
        )}
        {rest.length > 0 && (
          <FieldGrid
            rule={!!hero}
            fields={rest.map((f) => ({
              key: f.column,
              label: f.label,
              text: f.text,
              mono: f.format !== 'text' && f.format !== 'link',
              tone: f.text === EMPTY_CELL ? 'text-fg-3' : f.dir === 'up' ? 'text-up' : f.dir === 'down' ? 'text-down' : 'text-fg',
              ...(typeof f.raw === 'string' && f.raw.length > 24 ? { title: f.raw } : {}),
            }))}
          />
        )}
      </div>
    </div>
  )
}
