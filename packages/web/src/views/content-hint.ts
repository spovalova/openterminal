import { isChartPreset, type AnyWidget, type ContentHint, type Frame } from '@terminal/core'
import { primaryFrame, viewOf } from './fields'

/**
 * What a widget will show, for the packer's size-by-content rule (PLAN.md section 17): the view kind from the
 * preset, and the primary frame's row count once it has landed. A table over one row is reported as `facts`,
 * since that is what it renders (product rule 8).
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
  return { kind, ...(rows === undefined ? {} : { rows }), ...(columns === undefined ? {} : { columns }) }
}
