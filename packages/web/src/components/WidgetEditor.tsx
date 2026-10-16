import { useEffect, useState, type ReactNode } from 'react'
import { Button, Dialog } from '@terminal/ui'
import {
  IntervalSchema,
  KINDS,
  KIND_NAMES,
  RangeSchema,
  SizeSchema,
  parseWidget,
  type Interval,
  type Kind,
  type Range,
  type Size,
  type Widget,
  type WidgetInput,
} from '@terminal/core'
import { useActions } from '../actions'

type Draft = {
  title: string
  size: Size
  kind: Kind
  symbols: string
  q: string
  interval: Interval
  range: Range
  limit: string
  from: string
  to: string
  viewType: 'series' | 'table'
  candle: boolean
  normalize: boolean
}

const todayIso = () => new Date().toISOString().slice(0, 10)
const plusDaysIso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

function emptyDraft(): Draft {
  return {
    title: '',
    size: 'md',
    kind: 'quote',
    symbols: '',
    q: '',
    interval: '1d',
    range: '3mo',
    limit: '20',
    from: todayIso(),
    to: plusDaysIso(60),
    viewType: 'table',
    candle: false,
    normalize: false,
  }
}

function fromWidget(w: Widget): Draft {
  const d = emptyDraft()
  d.title = w.title
  d.size = w.size
  d.kind = w.query.kind
  const p = w.query.params as Record<string, unknown>
  if (Array.isArray(p.symbols)) d.symbols = (p.symbols as string[]).join(', ')
  if (Array.isArray(p.q)) d.q = (p.q as string[]).join(', ')
  if (typeof p.interval === 'string') d.interval = p.interval as Interval
  if (typeof p.range === 'string') d.range = p.range as Range
  if (typeof p.limit === 'number') d.limit = String(p.limit)
  if (typeof p.from === 'string') d.from = p.from
  if (typeof p.to === 'string') d.to = p.to
  d.viewType = w.view.type
  if (w.view.type === 'series') {
    d.candle = !!w.view.candle
    d.normalize = !!w.view.normalize
  }
  return d
}

const list = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)

function toWidgetInput(d: Draft, id: string): WidgetInput {
  const symbols = list(d.symbols)
  const params: Record<string, unknown> =
    d.kind === 'search'
      ? { q: d.q.split(',').map((x) => x.trim()).filter(Boolean) }
      : d.kind === 'quote'
        ? { symbols }
        : d.kind === 'ohlcv'
          ? { symbols, interval: d.interval, range: d.range }
          : d.kind === 'news'
            ? { symbols, limit: Number(d.limit) }
            : { symbols, from: d.from, to: d.to }
  const view = d.viewType === 'series' ? { type: 'series' as const, candle: d.candle || undefined, normalize: d.normalize || undefined } : { type: 'table' as const }
  return { id, title: d.title.trim(), size: d.size, query: { kind: d.kind, params } as WidgetInput['query'], view }
}

function newId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `w_${rnd}`
}

/** Edit (or add) a widget: the query as a form generated from the kind, and the view. Validated with parseWidget. */
export function WidgetEditor({ open, onClose, workspaceId, widget }: { open: boolean; onClose: () => void; workspaceId: string; widget?: Widget }) {
  const { saveWidget, removeWidget } = useActions()
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
  const seriesAllowed = draft.kind === 'ohlcv'

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
      <form onSubmit={submit} className="flex w-[min(90vw,520px)] flex-col gap-3">
        <Field label="Title">
          <input className={inputCls} value={draft.title} onChange={(e) => set('title', e.target.value)} maxLength={80} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <select
              className={inputCls}
              value={draft.kind}
              onChange={(e) => {
                const kind = e.target.value as Kind
                set('kind', kind)
                if (kind !== 'ohlcv') set('viewType', 'table')
              }}
            >
              {KIND_NAMES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <div className="mt-1 text-fg-2">{KINDS[draft.kind].description}</div>
          </Field>
          <Field label="Size">
            <select className={inputCls} value={draft.size} onChange={(e) => set('size', e.target.value as Size)}>
              {SizeSchema.options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {draft.kind === 'search' ? (
          <Field label="Queries (comma separated)">
            <input className={inputCls} value={draft.q} onChange={(e) => set('q', e.target.value)} placeholder="Micron, SanDisk" />
          </Field>
        ) : (
          <Field label="Symbols (comma separated)">
            <input className={inputCls} value={draft.symbols} onChange={(e) => set('symbols', e.target.value)} placeholder="MU, SNDK, WDC, STX" />
          </Field>
        )}
        {draft.kind === 'ohlcv' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Interval">
              <select className={inputCls} value={draft.interval} onChange={(e) => set('interval', e.target.value as Interval)}>
                {IntervalSchema.options.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Range">
              <select className={inputCls} value={draft.range} onChange={(e) => set('range', e.target.value as Range)}>
                {RangeSchema.options.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {draft.kind === 'news' && (
          <Field label="Limit">
            <input className={inputCls} type="number" min={1} max={100} value={draft.limit} onChange={(e) => set('limit', e.target.value)} />
          </Field>
        )}
        {draft.kind === 'earnings' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <input className={inputCls} type="date" value={draft.from} onChange={(e) => set('from', e.target.value)} />
            </Field>
            <Field label="To">
              <input className={inputCls} type="date" value={draft.to} onChange={(e) => set('to', e.target.value)} />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="View">
            <select className={inputCls} value={draft.viewType} onChange={(e) => set('viewType', e.target.value as Draft['viewType'])}>
              <option value="table">table</option>
              <option value="series" disabled={!seriesAllowed}>
                series{seriesAllowed ? '' : ' (ohlcv only)'}
              </option>
            </select>
          </Field>
          {draft.viewType === 'series' && (
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

const inputCls = 'w-full rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-fg-2">{label}</span>
      {children}
    </label>
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
