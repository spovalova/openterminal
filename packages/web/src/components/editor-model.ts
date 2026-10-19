// The editor's draft (PLAN.md section 17, "Editor with three tabs"): a v2 widget under construction. Pure helpers,
// tested without React: the data graph (datasets as queries), the preset and its options from `ViewV2Schema`,
// per-field overrides, and the conversions from and to `AnyWidget`.
import { z } from 'zod'
import {
  DATASET_NAME_RE,
  DEFAULT_DATASET,
  PRESET_NAMES,
  TRANSFORM_EXAMPLE,
  ViewV2Schema,
  WidgetV2Schema,
  datasetFieldsFrom,
  detectShape,
  isRecipeQuery,
  isRouteQuery,
  isTransformQuery,
  presetsFor,
  type AnyQuery,
  type AnyWidget,
  type DatasetsFieldConfig,
  type FieldOverrides,
  type Frame,
  type PresetName,
  type Size,
  type TransformQuery,
  type ViewV2,
  type WidgetV2,
} from '@terminal/core'

export type DatasetKind = 'recipe' | 'route' | 'transform'

export type EditorDraft = {
  id: string
  title: string
  size: Size
  /** The data graph, in display order. */
  data: Record<string, AnyQuery>
  view: ViewV2
  fields?: FieldOverrides
}

export const TABS = ['data', 'transform', 'view'] as const
export type EditorTab = (typeof TABS)[number]

export function datasetKind(q: AnyQuery): DatasetKind {
  if (isTransformQuery(q)) return 'transform'
  if (isRecipeQuery(q)) return 'recipe'
  if (isRouteQuery(q)) return 'route'
  throw new Error('unrecognised query shape')
}

export function newWidgetId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `w_${rnd}`
}

/** The draft for a new widget: one `main` dataset on the quote recipe, the stat preset. */
export function emptyDraft(): EditorDraft {
  return { id: newWidgetId(), title: '', size: 'md', data: { [DEFAULT_DATASET]: { recipe: 'quote', params: { symbols: ['NVDA'] } } }, view: { preset: 'stat' } }
}

/** The draft for an existing widget: its data graph, preset and field overrides as they are. */
export function draftFrom(widget: AnyWidget): EditorDraft {
  const d: EditorDraft = { id: widget.id, title: widget.title, size: widget.size, data: { ...widget.data }, view: widget.view }
  if (widget.fields) d.fields = widget.fields
  return d
}

/** The widget to save, validated by `WidgetV2Schema`. Throws ZodError. */
export function toWidget(draft: EditorDraft): WidgetV2 {
  const input: Record<string, unknown> = { id: draft.id, title: draft.title.trim(), size: draft.size, data: syncTransformInputs(draft.data), view: draft.view }
  if (draft.fields && Object.keys(draft.fields).length > 0) input.fields = draft.fields
  return WidgetV2Schema.parse(input)
}

/** A transform input named after a dataset of the graph follows that dataset's query. */
export function syncTransformInputs(data: Record<string, AnyQuery>): Record<string, AnyQuery> {
  const out: Record<string, AnyQuery> = {}
  for (const [name, q] of Object.entries(data)) {
    if (!isTransformQuery(q)) {
      out[name] = q
      continue
    }
    const inputs: Record<string, AnyQuery> = {}
    for (const [input, sub] of Object.entries(q.inputs)) inputs[input] = input !== name && data[input] && !isTransformQuery(data[input]!) ? data[input]! : sub
    out[name] = { ...q, inputs }
  }
  return out
}

/** Dataset names a transform draws on: its inputs that are datasets of the graph. */
export function transformEdges(name: string, data: Record<string, AnyQuery>): string[] {
  const q = data[name]
  if (!q || !isTransformQuery(q)) return []
  return Object.keys(q.inputs).filter((i) => i !== name && i in data)
}

/** A fresh dataset name: `main` when free, else `data2`, `data3`, … */
export function nextDatasetName(data: Record<string, AnyQuery>, base = 'data'): string {
  if (!(DEFAULT_DATASET in data)) return DEFAULT_DATASET
  if (base !== 'data' && !(base in data)) return base
  for (let i = 2; ; i++) {
    const n = `${base}${i}`
    if (!(n in data)) return n
  }
}

export function validDatasetName(name: string): boolean {
  return DATASET_NAME_RE.test(name)
}

/** Rename a dataset, keeping order, and follow the rename in transform inputs and view references. */
export function renameDataset(draft: EditorDraft, from: string, to: string): EditorDraft {
  if (from === to || !validDatasetName(to) || to in draft.data) return draft
  const data: Record<string, AnyQuery> = {}
  for (const [name, q] of Object.entries(draft.data)) {
    const key = name === from ? to : name
    if (isTransformQuery(q)) {
      const inputs: Record<string, AnyQuery> = {}
      for (const [i, sub] of Object.entries(q.inputs)) inputs[i === from ? to : i] = sub
      data[key] = { ...q, inputs }
    } else data[key] = q
  }
  const view = { ...draft.view } as Record<string, unknown>
  for (const k of ['data', 'events', 'levels']) if (view[k] === from) view[k] = to
  if (view.band && typeof view.band === 'object' && !Array.isArray(view.band) && (view.band as { data?: string }).data === from) view.band = { ...(view.band as object), data: to }
  return { ...draft, data, view: view as ViewV2 }
}

export function removeDataset(draft: EditorDraft, name: string): EditorDraft {
  const data = { ...draft.data }
  delete data[name]
  for (const [n, q] of Object.entries(data)) {
    if (!isTransformQuery(q) || !(name in q.inputs)) continue
    const inputs = { ...q.inputs }
    delete inputs[name]
    data[n] = { ...q, inputs }
  }
  const view = { ...draft.view } as Record<string, unknown>
  for (const k of ['data', 'events', 'levels']) if (view[k] === name) delete view[k]
  return { ...draft, data, view: view as ViewV2 }
}

/** A new transform dataset over the given inputs (copies of their queries), the example as code. */
export function newTransform(data: Record<string, AnyQuery>, inputs: string[], code = TRANSFORM_EXAMPLE.code): TransformQuery {
  const q: TransformQuery = { inputs: {}, code }
  for (const i of inputs) if (data[i] && !isTransformQuery(data[i]!)) q.inputs[i] = data[i]!
  return q
}

/** The dataset the view draws: `view.data`, else `main`, else the first. */
export function primaryDatasetName(draft: Pick<EditorDraft, 'data' | 'view'>): string | undefined {
  if (draft.view.data && draft.view.data in draft.data) return draft.view.data
  if (DEFAULT_DATASET in draft.data) return DEFAULT_DATASET
  return Object.keys(draft.data)[0]
}

/** Presets the loaded frames allow for the primary dataset; every preset when its frame has not landed. */
export function presetsAvailable(draft: Pick<EditorDraft, 'data' | 'view'>, frames: Record<string, Frame>): PresetName[] {
  const name = primaryDatasetName(draft)
  const frame = name ? frames[name] : undefined
  if (!frame) return [...PRESET_NAMES]
  const list = presetsFor(detectShape(frame.columns, frame.rows.slice(0, 500)))
  return list.includes(draft.view.preset) ? list : [draft.view.preset, ...list]
}

export function datasetsConfigFrom(frames: Record<string, Frame>): DatasetsFieldConfig {
  const out: DatasetsFieldConfig = {}
  for (const [name, f] of Object.entries(frames)) out[name] = datasetFieldsFrom(f)
  return out
}

// ---- preset options from ViewV2Schema ----

export type OptionSpec = {
  name: string
  description?: string
  input: 'boolean' | 'select' | 'text' | 'number' | 'list' | 'dataset' | 'column' | 'json'
  options?: string[]
  integer?: boolean
  min?: number
  max?: number
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; enum?: unknown[]; items?: JsonSchema; description?: string; minimum?: number; maximum?: number; anyOf?: JsonSchema[]; const?: unknown }

/** Options that name a dataset of the widget, and options that name a column of the primary dataset. */
const DATASET_OPTIONS = new Set(['data', 'events'])
const COLUMN_OPTIONS = new Set(['column', 'change', 'x', 'y', 'value', 'group', 'highlight'])

const optionCache = new Map<PresetName, OptionSpec[]>()

/** The option fields of a preset, read off its Zod schema (every field but `preset`). */
export function presetOptions(preset: PresetName): OptionSpec[] {
  const cached = optionCache.get(preset)
  if (cached) return cached
  const schema = ViewV2Schema.options.find((o) => (o.shape.preset as z.ZodLiteral<string>).value === preset)
  const out: OptionSpec[] = []
  if (schema) {
    const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as JsonSchema
    for (const [name, p] of Object.entries(json.properties ?? {})) {
      if (name === 'preset') continue
      out.push(optionSpec(name, p))
    }
  }
  optionCache.set(preset, out)
  return out
}

function optionSpec(name: string, p: JsonSchema): OptionSpec {
  const base: OptionSpec = { name, input: 'text', ...(p.description ? { description: p.description } : {}) }
  if (DATASET_OPTIONS.has(name)) return { ...base, input: 'dataset' }
  if (COLUMN_OPTIONS.has(name)) return { ...base, input: 'column' }
  if (p.type === 'boolean') return { ...base, input: 'boolean' }
  if (Array.isArray(p.enum)) return { ...base, input: 'select', options: p.enum.map(String) }
  if (p.type === 'integer' || p.type === 'number') return { ...base, input: 'number', integer: p.type === 'integer', ...(p.minimum !== undefined ? { min: p.minimum } : {}), ...(p.maximum !== undefined ? { max: p.maximum } : {}) }
  if (p.type === 'array' && (p.items?.type === 'string' || !p.items)) return { ...base, input: 'list' }
  if (p.type === 'string') return base
  return { ...base, input: 'json' }
}

/** Parse what the user typed for an option into the value the schema wants; `undefined` clears it. */
export function optionValue(spec: OptionSpec, raw: string | boolean): unknown {
  if (spec.input === 'boolean') return raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : undefined
  const text = typeof raw === 'string' ? raw.trim() : String(raw)
  if (text === '') return undefined
  switch (spec.input) {
    case 'number': {
      const n = Number(text)
      return Number.isFinite(n) ? n : undefined
    }
    case 'list':
      return text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    case 'json':
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    default:
      return text
  }
}

/** The text shown for an option's current value. */
export function optionText(spec: OptionSpec, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (spec.input === 'list' && Array.isArray(value)) return value.join(', ')
  if (spec.input === 'json') return JSON.stringify(value)
  return String(value)
}

/** The view with one option set (or cleared), validated against the preset's schema; invalid values leave the view unchanged. */
export function setViewOption(view: ViewV2, name: string, value: unknown): ViewV2 {
  const next = { ...view } as Record<string, unknown>
  if (value === undefined) delete next[name]
  else next[name] = value
  const parsed = ViewV2Schema.safeParse(next)
  return parsed.success ? parsed.data : view
}

/** Switch preset, keeping the options the new preset also has. */
export function switchPreset(view: ViewV2, preset: PresetName): ViewV2 {
  const keep = new Set(presetOptions(preset).map((o) => o.name))
  const next: Record<string, unknown> = { preset }
  for (const [k, v] of Object.entries(view)) if (k !== 'preset' && keep.has(k)) next[k] = v
  const parsed = ViewV2Schema.safeParse(next)
  return parsed.success ? parsed.data : ({ preset } as ViewV2)
}

export { TABS as EDITOR_TABS }
