// What the agent has seen this run: every preview keyed by its query, so set_workspace can size widgets by content
// (PLAN.md section 17, "size by content"), refuse a table over one row (product rule 8), check that a preset can draw
// the frame it is given, and so reply verification knows which numbers were on the table.
import {
  canonicalKey,
  datasetFieldsFrom,
  describeQuery,
  isChartPreset,
  preview,
  type AnyQuery,
  type ContentHint,
  type DatasetsFieldConfig,
  type FieldConfig,
  type Frame,
  type Preview,
  type WidgetV2,
} from '@terminal/core'
import type { PreviewRecord } from '../verify.js'

export type SeenPreview = PreviewRecord & {
  key: string
  query: AnyQuery
  frame: Frame
  rowCount: number
  label: string
}

export class PreviewMemory {
  private readonly byKey = new Map<string, SeenPreview>()

  /** Record a frame the agent just received; returns the preview the tool hands back. */
  remember(query: AnyQuery, frame: Frame): SeenPreview {
    const key = canonicalKey(query)
    const seen: SeenPreview = {
      key,
      query,
      frame,
      preview: preview(frame),
      rowCount: frame.rows.length,
      label: describeQuery(query),
      ...(frame.meta.fields ? { fields: frame.meta.fields } : {}),
    }
    this.byKey.set(key, seen)
    return seen
  }

  /**
   * Record a result that carries the preview, fields and lineage rather than the frame ((b)'s transform tool): the
   * preview rows stand in as the frame sample for the preset checks, and `rowCount` is the preview's.
   */
  rememberResult(query: AnyQuery, result: { preview: Preview; fields?: Record<string, FieldConfig>; lineage?: Frame['meta']['lineage'] }, fetchedAt = Date.now()): SeenPreview {
    const key = canonicalKey(query)
    const meta: Frame['meta'] = { connector: 'transform', fetchedAt, ttl: 0, ...(result.fields ? { fields: result.fields } : {}), ...(result.lineage ? { lineage: result.lineage } : {}) }
    const frame: Frame = { columns: result.preview.columns, rows: result.preview.rows, meta }
    const seen: SeenPreview = { key, query, frame, preview: result.preview, rowCount: result.preview.rowCount, label: describeQuery(query), ...(result.fields ? { fields: result.fields } : {}) }
    this.byKey.set(key, seen)
    return seen
  }

  get(query: AnyQuery): SeenPreview | undefined {
    return this.byKey.get(canonicalKey(query))
  }

  get size(): number {
    return this.byKey.size
  }

  /** Every preview, for reply verification. */
  records(): PreviewRecord[] {
    return [...this.byKey.values()].map((s) => ({ preview: s.preview, label: s.label, ...(s.fields ? { fields: s.fields } : {}) }))
  }

  /** The field config per dataset of a widget, for every dataset whose frame this run has seen. */
  datasetsOf(widget: WidgetV2): DatasetsFieldConfig {
    const out: DatasetsFieldConfig = {}
    for (const [name, q] of Object.entries(widget.data)) {
      const seen = this.get(q)
      if (seen) out[name] = datasetFieldsFrom(seen.frame)
    }
    return out
  }
}

/** The dataset a widget's view draws: the named one, else `main`, else the first. */
export function primaryDatasetOf(widget: WidgetV2): string {
  if (widget.view.data && widget.view.data in widget.data) return widget.view.data
  if ('main' in widget.data) return 'main'
  return Object.keys(widget.data)[0]!
}

/** What the packer needs to size the widget: the view kind and, when the frame was previewed, its row count. */
export function contentHintFor(widget: WidgetV2, memory: PreviewMemory): ContentHint {
  const preset = widget.view.preset
  const kind: ContentHint['kind'] = preset === 'table' || preset === 'stat' || preset === 'facts' || preset === 'chain' ? preset : isChartPreset(preset) ? 'chart' : 'chart'
  const seen = memory.get(widget.data[primaryDatasetOf(widget)]!)
  return seen ? { kind, rows: seen.rowCount } : { kind }
}

/** `close:number (usd, Close)`: one entry per column with its unit and label when the frame carries them. */
export function describeColumns(frame: Pick<Frame, 'columns' | 'meta'>): string {
  return frame.columns
    .map((c) => {
      const f: FieldConfig | undefined = frame.meta.fields?.[c.name]
      const tags = [f?.unit, f?.label && f.label !== c.name ? f.label : undefined].filter((x): x is string => !!x)
      return `${c.name}:${c.type}${tags.length ? ` (${tags.join(', ')})` : ''}`
    })
    .join(', ')
}

/** Unit per numeric column that carries one. Columns absent here carry no unit guarantee. */
export function unitsOf(frame: Pick<Frame, 'columns' | 'meta'>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of frame.columns) {
    const unit = frame.meta.fields?.[c.name]?.unit
    if (unit) out[c.name] = unit
  }
  return out
}

/** What a tool returns for a frame: the preview with its units line and lineage. */
export type PreviewResult = {
  ok: true
  query: AnyQuery
  connector: string
  /** One line: every column with its type, unit and label. */
  columns: string
  /** Column → unit for the columns that carry one; the rest carry no unit guarantee. */
  units: Record<string, string>
  lineage?: Frame['meta']['lineage']
  note: string
  preview: Preview
}

export function previewResult(seen: SeenPreview, note: string): PreviewResult {
  const { frame, query, preview: pv } = seen
  return {
    ok: true,
    query,
    connector: frame.meta.connector,
    columns: describeColumns(frame),
    units: unitsOf(frame),
    ...(frame.meta.lineage ? { lineage: frame.meta.lineage } : {}),
    note,
    preview: pv,
  }
}
