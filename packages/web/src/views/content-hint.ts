import { columnIndex, isChartPreset, type AnyWidget, type ContentHint, type Frame } from '@openterminal/core'
import { tableContentWidth } from '@openterminal/ui'
import { controlOf, primaryFrame, viewOf } from './fields'
import { factsControlOf, factsOf, heroFact } from './FactsCard'
import { orderStats, statRows, symbolOrder, seriesDetails, detailRows } from './StatView'
import { cellFormat, formatsOf, pivotMetricColumn, projectFrame, ranksFor, tableControlOf } from './TableView'

/**
 * What a widget will show, for the packer's size-by-content rule (PLAN.md section 17, taste round 2): the view kind
 * from the preset, the primary frame's row count once it has landed, and what the round 2 rules size by: a table's
 * content width (a narrow table takes one column), a stat's card count, a card's field count (its height) and whether
 * a chart compares series or carries indicator panes (its plot needs room). A table over one row is reported as
 * `facts`, since that is what it renders (product rule 8).
 */
export function contentHintFor(widget: AnyWidget, frames: Record<string, Frame>): ContentHint {
  const view = viewOf(widget)
  const frame = primaryFrame(widget, frames)
  const rows = frame?.rows.length
  let kind: ContentHint['kind']
  if (isChartPreset(view.preset)) kind = 'chart'
  else if (view.preset === 'table') kind = rows === 1 ? 'facts' : 'table'
  else if (view.preset === 'stat') kind = 'stat'
  else if (view.preset === 'facts') kind = 'facts'
  else kind = 'chain'
  const columns = kind === 'table' ? frame?.columns.length : undefined
  const hint: ContentHint = { kind, ...(rows === undefined ? {} : { rows }), ...(columns === undefined ? {} : { columns }) }
  if (!frame) {
    if (kind === 'chart' && (view.preset === 'compare' || view.preset === 'indicator')) hint.dense = true
    return hint
  }
  try {
    if (kind === 'table') Object.assign(hint, tableHint(widget, frames))
    else if (kind === 'facts') {
      const control = factsControlOf(widget, frames)
      if (control) {
        const facts = factsOf(frames[control.data] ?? frame, control)
        hint.fields = Math.max(0, facts.length - (heroFact(facts) ? 1 : 0))
      }
    } else if (kind === 'stat') Object.assign(hint, statHint(widget, frames))
    else if (kind === 'chart') {
      const groups = new Set<unknown>()
      const ig = columnIndex(frame, 'symbol')
      if (ig >= 0) for (const r of frame.rows) groups.add(r[ig])
      if (view.preset === 'compare' || view.preset === 'indicator' || groups.size > 3 || Object.keys(widget.data).length > 3) hint.dense = true
    }
  } catch {
    // A hint is an optimisation: the packer falls back to the size and the kind.
  }
  return hint
}

/** A table's content width and the width of the columns it never sheds. */
function tableHint(widget: AnyWidget, frames: Record<string, Frame>): Partial<ContentHint> {
  const control = tableControlOf(widget, frames)
  const frame = control ? frames[control.data] : undefined
  if (!control || !frame) return {}
  const projected = projectFrame(frame, control.columns)
  const formats = formatsOf(control)
  const limited = control.limit ? projected.rows.slice(0, control.limit) : projected.rows
  const { width, minWidth } = tableContentWidth(projected.columns, limited, formats, control.labels, ranksFor(control.columns, control.sort?.column, formats))
  // Two or three rows are cards side by side where they fit (about 210px each), else the table's own widths.
  if (limited.length <= 3) return { width: Math.min(width, limited.length * 208 + 24), minWidth: Math.min(minWidth, limited.length * 208 + 24), rows: limited.length, fields: Math.max(0, projected.columns.length - 1) }
  // A pivoted compare table (metrics as rows, a column per symbol) sheds nothing: every symbol is the comparison.
  if (pivotMetricColumn(projected)) return { width, minWidth: width, rows: limited.length }
  return { width, minWidth, rows: limited.length }
}

/** A stat's card count, and for a one-symbol card the companions under its hero. */
function statHint(widget: AnyWidget, frames: Record<string, Frame>): Partial<ContentHint> {
  const control = controlOf(widget, frames)
  if (control?.kind !== 'stat') return {}
  const frame = frames[control.data]
  if (!frame) return {}
  const stats = orderStats(statRows(frame, control.column, control), symbolOrder(widget))
  if (stats.length !== 1) return { items: stats.length }
  const format = cellFormat(control.format)
  const details = [...seriesDetails(frame, control.column, format), ...detailRows(frame, control.column, control.change, frame.meta.fields ?? {}, 6, format)].filter((d, i, all) => all.findIndex((x) => x.label === d.label) === i)
  return { items: 1, fields: Math.min(6, details.length) }
}
