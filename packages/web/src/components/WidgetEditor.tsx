import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Button, Dialog } from '@terminal/ui'
import { KINDS, KIND_NAMES, SERIES_KINDS, SizeSchema, parseWidget, type Kind, type Size, type Widget, type WidgetInput } from '@terminal/core'
import { useActions } from '../actions'
import { legendGroups, legendLabel } from '../views/series-data'

type ViewType = Widget['view']['type']

/** What the editor knows about one param of a kind, read off the kind's zod schema as JSON schema. */
export type FieldSpec = {
  name: string
  required: boolean
  description?: string
  default?: unknown
} & (
  | { input: 'list'; upper: boolean; min?: number; max?: number }
  | { input: 'multi'; options: string[]; min?: number; max?: number }
  | { input: 'select'; options: string[] }
  | { input: 'number'; integer: boolean; min?: number; max?: number }
  | { input: 'date' }
  | { input: 'text' }
)

type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  items?: JsonSchema
  format?: string
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  default?: unknown
  description?: string
}

/** Columns whose values are tickers: upper-cased on input. */
const TICKER_FIELDS = new Set(['symbol', 'symbols'])

function fieldSpec(name: string, p: JsonSchema, required: boolean): FieldSpec {
  const base = { name, required, ...(p.description ? { description: p.description } : {}), ...(p.default !== undefined ? { default: p.default } : {}) }
  const bounds = (min: number | undefined, max: number | undefined) => ({ ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) })
  if (p.type === 'array') {
    const items = p.items ?? {}
    if (Array.isArray(items.enum)) return { ...base, input: 'multi', options: items.enum.map(String), ...bounds(p.minItems, p.maxItems) }
    return { ...base, input: 'list', upper: TICKER_FIELDS.has(name), ...bounds(p.minItems, p.maxItems) }
  }
  if (Array.isArray(p.enum)) return { ...base, input: 'select', options: p.enum.map(String) }
  if (p.type === 'integer' || p.type === 'number') return { ...base, input: 'number', integer: p.type === 'integer', ...bounds(p.minimum, p.maximum) }
  if (p.format === 'date') return { ...base, input: 'date' }
  return { ...base, input: 'text' }
}

const fieldCache = new Map<Kind, FieldSpec[]>()

/** The form fields for a kind, in the order its param schema declares them. */
export function fieldsFor(kind: Kind): FieldSpec[] {
  let fields = fieldCache.get(kind)
  if (!fields) {
    const json = z.toJSONSchema(KINDS[kind].params, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as JsonSchema
    const required = new Set(json.required ?? [])
    fields = Object.entries(json.properties ?? {}).map(([name, p]) => fieldSpec(name, p, required.has(name)))
    fieldCache.set(kind, fields)
  }
  return fields
}

/** Views a kind can be rendered with; the first is the natural default. */
export function viewTypesFor(kind: Kind): ViewType[] {
  if (kind === 'options') return ['chain', 'table']
  if (SERIES_KINDS.has(kind)) return ['series', 'table']
  return ['table']
}

type ParamDraft = Record<string, string | string[]>

type Draft = {
  title: string
  size: Size
  kind: Kind
  params: ParamDraft
  viewType: ViewType
  candle: boolean
  normalize: boolean
  /** Legend label per symbol (or macro series); blank means the default. */
  labels: Record<string, string>
}

const todayIso = () => new Date().toISOString().slice(0, 10)
const plusDaysIso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** Starting values for params the schema leaves without a default: a daily 3-month chart, a 60-day window. */
function fallbackDefault(field: FieldSpec): string {
  switch (field.name) {
    case 'interval':
      return '1d'
    case 'range':
      return '3mo'
    case 'from':
      return todayIso()
    case 'to':
      return plusDaysIso(60)
    default:
      return ''
  }
}

/** Draft values for every field of a kind: the widget's current params, else the schema default, else a fallback. */
export function paramDraft(kind: Kind, current?: Record<string, unknown>): ParamDraft {
  const out: ParamDraft = {}
  for (const f of fieldsFor(kind)) {
    const v = current?.[f.name]
    if (f.input === 'multi') {
      out[f.name] = Array.isArray(v) ? v.map(String) : Array.isArray(f.default) ? f.default.map(String) : []
    } else if (f.input === 'list') {
      out[f.name] = Array.isArray(v) ? v.map(String).join(', ') : ''
    } else if (v !== undefined && v !== null) {
      out[f.name] = String(v)
    } else if (f.default !== undefined) {
      out[f.name] = String(f.default)
    } else {
      out[f.name] = fallbackDefault(f)
    }
  }
  return out
}

/** Draft values back to a params object: blank optional fields are omitted, lists split on commas. */
export function paramsFrom(kind: Kind, draft: ParamDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fieldsFor(kind)) {
    const v = draft[f.name]
    if (f.input === 'multi') {
      const arr = Array.isArray(v) ? v : []
      if (arr.length || f.required) out[f.name] = arr
      continue
    }
    const text = Array.isArray(v) ? v.join(', ') : (v ?? '')
    const trimmed = text.trim()
    if (f.input === 'list') {
      const items = trimmed
        .split(/[,\s]+/)
        .map((x) => (f.upper ? x.trim().toUpperCase() : x.trim()))
        .filter(Boolean)
      if (items.length || f.required) out[f.name] = items
      continue
    }
    if (trimmed === '') {
      if (f.required && f.input === 'number') out[f.name] = undefined
      continue
    }
    if (f.input === 'number') out[f.name] = Number(trimmed)
    else out[f.name] = TICKER_FIELDS.has(f.name) ? trimmed.toUpperCase() : trimmed
  }
  return out
}

function emptyDraft(): Draft {
  return { title: '', size: 'md', kind: 'quote', params: paramDraft('quote'), viewType: 'table', candle: false, normalize: false, labels: {} }
}

function fromWidget(w: Widget): Draft {
  return {
    title: w.title,
    size: w.size,
    kind: w.query.kind,
    params: paramDraft(w.query.kind, w.query.params as Record<string, unknown>),
    viewType: w.view.type,
    candle: w.view.type === 'series' ? !!w.view.candle : false,
    normalize: w.view.type === 'series' ? !!w.view.normalize : false,
    labels: w.view.type === 'series' && w.view.labels ? { ...w.view.labels } : {},
  }
}

/** The legend labels to save: trimmed, non-blank, and only for lines the query still draws. */
export function labelsFor(groups: string[], labels: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const g of groups) {
    const v = labels[g]?.trim()
    if (v) out[g] = v
  }
  return Object.keys(out).length ? out : undefined
}

export function toWidgetInput(d: Draft, id: string): WidgetInput {
  const params = paramsFrom(d.kind, d.params)
  const labels = d.viewType === 'series' ? labelsFor(legendGroups(d.kind, params), d.labels) : undefined
  const view =
    d.viewType === 'series'
      ? {
          type: 'series' as const,
          ...(d.kind === 'ohlcv' && d.candle ? { candle: true } : {}),
          ...(d.kind === 'ohlcv' && d.normalize ? { normalize: true } : {}),
          ...(labels ? { labels } : {}),
        }
      : d.viewType === 'chain'
        ? { type: 'chain' as const }
        : { type: 'table' as const }
  return { id, title: d.title.trim(), size: d.size, query: { kind: d.kind, params } as WidgetInput['query'], view }
}

function newId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `w_${rnd}`
}

const labelOf = (name: string) => name.replace(/_/g, ' ')

/** Edit (or add) a widget: the query as a form generated from the kind's param schema, and the view. Validated with parseWidget. */
export function WidgetEditor({ open, onClose, workspaceId, widget }: { open: boolean; onClose: () => void; workspaceId: string; widget?: Widget }) {
  const { saveWidget, removeWidget } = useActions()
  const uid = useId() // several editors can be mounted at once (one per widget cell), so ids are per instance
  const fid = (name: string) => `${uid}-${name}`
  const [draft, setDraft] = useState<Draft>(() => (widget ? fromWidget(widget) : emptyDraft()))
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft(widget ? fromWidget(widget) : emptyDraft())
      setErrors([])
    }
  }, [open, widget])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const setParam = (name: string, value: string | string[]) => setDraft((d) => ({ ...d, params: { ...d.params, [name]: value } }))
  const setLabel = (group: string, value: string) => setDraft((d) => ({ ...d, labels: { ...d.labels, [group]: value } }))
  const fields = useMemo(() => fieldsFor(draft.kind), [draft.kind])
  const viewTypes = viewTypesFor(draft.kind)
  // the lines the series view will draw, from the params as typed so far: one legend label input each
  const groups = useMemo(() => (draft.viewType === 'series' ? legendGroups(draft.kind, paramsFrom(draft.kind, draft.params)) : []), [draft.viewType, draft.kind, draft.params])

  /** A new kind resets the params to its defaults and picks its natural view (series, chain, or table). */
  const changeKind = (kind: Kind) => {
    setDraft((d) => ({ ...d, kind, params: paramDraft(kind), viewType: viewTypesFor(kind)[0]! }))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    let parsed: Widget
    try {
      parsed = parseWidget(toWidgetInput(draft, widget?.id ?? newId()))
    } catch (err) {
      setErrors(zodMessages(err))
      return
    }
    setSaving(true)
    try {
      await saveWidget(workspaceId, parsed)
      onClose()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)])
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={widget ? 'Edit widget' : 'Add widget'}>
      <form onSubmit={submit} className="flex w-full flex-col gap-3">
        <Field id={fid('title')} label="Title">
          <input id={fid('title')} className={inputCls} value={draft.title} onChange={(e) => set('title', e.target.value)} maxLength={80} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id={fid('kind')} label="Kind">
            <select id={fid('kind')} className={inputCls} value={draft.kind} onChange={(e) => changeKind(e.target.value as Kind)}>
              {KIND_NAMES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field id={fid('size')} label="Size">
            <select id={fid('size')} className={inputCls} value={draft.size} onChange={(e) => set('size', e.target.value as Size)}>
              {SizeSchema.options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-xs text-fg-2">{KINDS[draft.kind].description}</p>

        <div data-params="" className="grid grid-cols-2 gap-3">
          {fields.map((f) => (
            <ParamField key={f.name} id={fid(f.name)} field={f} value={draft.params[f.name] ?? (f.input === 'multi' ? [] : '')} onChange={(v) => setParam(f.name, v)} />
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field id={fid('view')} label="View">
            <select id={fid('view')} className={inputCls} value={draft.viewType} onChange={(e) => set('viewType', e.target.value as ViewType)}>
              {viewTypes.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {draft.viewType === 'series' && draft.kind === 'ohlcv' && (
            <div className="flex flex-col justify-end gap-1">
              <label className="flex items-center gap-2 text-fg">
                <input type="checkbox" checked={draft.candle} onChange={(e) => set('candle', e.target.checked)} /> candle (one symbol)
              </label>
              <label className="flex items-center gap-2 text-fg">
                <input type="checkbox" checked={draft.normalize} onChange={(e) => set('normalize', e.target.checked)} /> normalize (rebased to 100)
              </label>
            </div>
          )}
        </div>
        {groups.length > 0 && (
          <fieldset data-field="labels" className="flex flex-col gap-1">
            <legend className="text-[11px] tracking-wide text-fg-2 uppercase">Legend labels (optional)</legend>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1">
              {groups.map((g) => {
                const fallback = legendLabel(g, draft.kind)
                return (
                  <label key={g} className="flex items-center gap-2 text-fg-2">
                    <span className="w-16 shrink-0 truncate text-xs" title={g}>
                      {fallback}
                    </span>
                    <input
                      className={inputCls}
                      name={`label:${g}`}
                      aria-label={`Legend label for ${g}`}
                      value={draft.labels[g] ?? ''}
                      placeholder={fallback}
                      maxLength={32}
                      onChange={(e) => setLabel(g, e.target.value)}
                    />
                  </label>
                )
              })}
            </div>
          </fieldset>
        )}

        {errors.length > 0 && (
          <ul role="alert" className="rounded border border-down/40 bg-down/10 px-3 py-2 text-down">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <div>
            {widget && (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Remove widget "${widget.title}"?`)) void removeWidget(workspaceId, widget.id).then(onClose)
                }}
              >
                Remove
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

/** One generated param input. Lists and multi-selects span the full width; the rest share a two-column row. */
function ParamField({ id, field, value, onChange }: { id: string; field: FieldSpec; value: string | string[]; onChange: (v: string | string[]) => void }) {
  const text = Array.isArray(value) ? value.join(', ') : value
  const hint = field.description
  // a field with a schema default is prefilled, so only fields that may stay blank say so
  const optional = field.required || field.default !== undefined ? '' : ' (optional)'
  switch (field.input) {
    case 'list':
      return (
        <Field id={id} label={`${labelOf(field.name)} (comma separated)${optional}`} hint={hint} wide>
          <input id={id} className={inputCls} value={text} onChange={(e) => onChange(e.target.value)} placeholder={field.upper ? 'MU, SNDK, WDC, STX' : 'Micron, SanDisk'} />
        </Field>
      )
    case 'multi':
      return (
        <fieldset data-field={field.name} className="col-span-2 flex flex-col gap-1">
          <legend className="text-[11px] tracking-wide text-fg-2 uppercase">
            {labelOf(field.name)}
            {field.max !== undefined ? ` (up to ${field.max})` : ''}
          </legend>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1">
            {field.options.map((opt) => {
              const checked = Array.isArray(value) && value.includes(opt)
              return (
                <label key={opt} className="flex items-center gap-2 text-fg">
                  <input
                    type="checkbox"
                    name={field.name}
                    value={opt}
                    checked={checked}
                    onChange={(e) => {
                      const cur = Array.isArray(value) ? value : []
                      onChange(e.target.checked ? [...cur, opt] : cur.filter((x) => x !== opt))
                    }}
                  />
                  {opt}
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    case 'select':
      return (
        <Field id={id} label={`${labelOf(field.name)}${optional}`} hint={hint}>
          <select id={id} className={inputCls} value={text} onChange={(e) => onChange(e.target.value)}>
            {!field.required && <option value="">—</option>}
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>
      )
    case 'number':
      return (
        <Field id={id} label={`${labelOf(field.name)}${optional}`} hint={hint}>
          <input
            id={id}
            className={inputCls}
            type="number"
            inputMode={field.integer ? 'numeric' : 'decimal'}
            step={field.integer ? 1 : 'any'}
            min={field.min}
            max={field.max}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      )
    case 'date':
      return (
        <Field id={id} label={`${labelOf(field.name)}${optional}`} hint={hint}>
          <input id={id} className={inputCls} type="date" value={text} onChange={(e) => onChange(e.target.value)} />
        </Field>
      )
    default:
      return (
        <Field id={id} label={`${labelOf(field.name)}${optional}`} hint={hint} wide={!TICKER_FIELDS.has(field.name)}>
          <input id={id} className={inputCls} value={text} onChange={(e) => onChange(e.target.value)} placeholder={field.name === 'symbol' ? 'NVDA' : undefined} />
        </Field>
      )
  }
}

const inputCls = 'w-full rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent'

function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'col-span-2 flex flex-col gap-1' : 'flex flex-col gap-1'}>
      <label htmlFor={id} className="text-[11px] tracking-wide text-fg-2 uppercase" title={hint}>
        {label}
      </label>
      {children}
    </div>
  )
}

function zodMessages(err: unknown): string[] {
  const issues = (err as { issues?: { path?: PropertyKey[]; message: string }[] } | null)?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((i) => {
      const path = (i.path ?? []).map(String).join('.')
      return path ? `${path}: ${i.message}` : i.message
    })
  }
  return [err instanceof Error ? err.message : String(err)]
}
