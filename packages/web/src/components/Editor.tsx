import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Dialog } from '@openterminal/ui'
import { SizeSchema, type AnyWidget, type Descriptor, type Frame, type Recipe, type Size } from '@openterminal/core'
import { useActions } from '../actions'
import { api } from '../api'
import { EditorData } from './EditorData'
import { EditorTransform } from './EditorTransform'
import { EditorView } from './EditorView'
import { TABS, draftFrom, emptyDraft, toWidget, type EditorDraft, type EditorTab } from './editor-model'
import { idlePreview, type PreviewState } from './FramePreview'
import { Field, inputCls } from './ParamsForm'

export type EditorProps = { open: boolean; onClose: () => void; workspaceId: string; widget?: AnyWidget; initialTab?: EditorTab }

const TAB_LABEL: Record<EditorTab, string> = { data: 'Data', transform: 'Transform', view: 'View' }

/**
 * The widget editor (PLAN.md section 17, "Editor with three tabs"): data (the graph with a preview per dataset;
 * add a dataset as a route, a recipe, a transform or a v1 kind), transform (CodeMirror with the traceback inline),
 * view (the preset and its options from `ViewV2Schema`, the expanded panes read-only). Saves a v2 widget.
 */
export function Editor({ open, onClose, workspaceId, widget, initialTab = 'data' }: EditorProps) {
  const { saveWidget, removeWidget } = useActions()
  const uid = useId()
  const [draft, setDraft] = useState<EditorDraft>(() => (widget ? draftFrom(widget) : emptyDraft()))
  const [tab, setTab] = useState<EditorTab>(initialTab)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [connectors, setConnectors] = useState<string[]>([])
  const descriptorCache = useRef(new Map<string, Promise<Descriptor[]>>())

  useEffect(() => {
    if (!open) return
    setDraft(widget ? draftFrom(widget) : emptyDraft())
    setTab(initialTab)
    setErrors([])
    setPreviews({})
    api
      .recipes()
      .then((r) => setRecipes([...r.builtin, ...r.user]))
      .catch(() => setRecipes([]))
    api
      .catalog()
      .then((c) => setConnectors(c.connectors))
      .catch(() => setConnectors([]))
  }, [open, widget, initialTab])

  const runPreview = useCallback(
    async (name: string, refresh = false) => {
      const q = draft.data[name]
      if (!q) return
      setPreviews((p) => ({ ...p, [name]: { status: 'loading' } }))
      const t0 = performance.now()
      try {
        const frame = await api.query(q, { refresh })
        setPreviews((p) => ({ ...p, [name]: { status: 'ok', frame, ms: Math.round(performance.now() - t0) } }))
      } catch (err) {
        const e = err as { message?: string; detail?: { traceback?: string } }
        setPreviews((p) => ({ ...p, [name]: { status: 'error', error: e.message ?? String(err), ...(e.detail?.traceback ? { traceback: e.detail.traceback } : {}) } }))
      }
    },
    [draft.data],
  )

  const loadDescriptors = useCallback((connector: string): Promise<Descriptor[]> => {
    let p = descriptorCache.current.get(connector)
    if (!p) {
      p = api
        .connectorCatalog(connector)
        .then((c) => c.descriptors)
        .catch(() => [])
      descriptorCache.current.set(connector, p)
    }
    return p
  }, [])

  const frames = useMemo(() => {
    const out: Record<string, Frame> = {}
    for (const [name, p] of Object.entries(previews)) if (p.status === 'ok' && name in draft.data) out[name] = p.frame
    return out
  }, [previews, draft.data])

  /** Previews of datasets that changed are stale: drop them when the query changes. */
  const update = (next: EditorDraft) => {
    setDraft((prev) => {
      setPreviews((p) => {
        const kept: Record<string, PreviewState> = {}
        for (const [name, pv] of Object.entries(p)) if (next.data[name] && next.data[name] === prev.data[name]) kept[name] = pv
        return kept
      })
      return next
    })
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    let parsed
    try {
      parsed = toWidget(draft)
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
    <Dialog open={open} onClose={onClose} title={widget ? 'Edit widget' : 'Add widget'} size="wide">
      <form data-editor="" onSubmit={submit} className="flex h-[min(78vh,760px)] w-full flex-col gap-3">
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field id={`${uid}-title`} label="Title">
            <input id={`${uid}-title`} className={inputCls} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={80} required />
          </Field>
          <Field id={`${uid}-size`} label="Size">
            <select id={`${uid}-size`} className={inputCls} value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value as Size })}>
              {SizeSchema.options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div role="tablist" aria-label="Editor tabs" className="flex items-stretch border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${uid}-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`${uid}-panel-${t}`}
              onClick={() => setTab(t)}
              className={clsx('relative px-3 py-1.5 text-sm select-none', tab === t ? 'text-fg' : 'text-fg-2 hover:text-fg')}
            >
              {TAB_LABEL[t]}
              {t === 'data' && <span className="num ml-1.5 text-[10px] text-fg-3">{Object.keys(draft.data).length}</span>}
              {tab === t && <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-accent" />}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} data-tab={tab} className="min-h-0 flex-1 overflow-y-auto pr-1">
          {tab === 'data' && <EditorData draft={draft} onChange={update} previews={previews} runPreview={runPreview} recipes={recipes} connectors={connectors} loadDescriptors={loadDescriptors} />}
          {tab === 'transform' && <EditorTransform draft={draft} onChange={update} previews={previews} runPreview={runPreview} />}
          {tab === 'view' && <EditorView draft={draft} onChange={update} frames={frames} onPreview={runPreview} />}
        </div>

        {errors.length > 0 && (
          <ul role="alert" className="rounded border border-down/40 bg-down/10 px-3 py-2 text-down">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border pt-2">
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

export function zodMessages(err: unknown): string[] {
  const issues = (err as { issues?: { path?: PropertyKey[]; message: string }[] } | null)?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((i) => {
      const path = (i.path ?? []).map(String).join('.')
      return path ? `${path}: ${i.message}` : i.message
    })
  }
  return [err instanceof Error ? err.message : String(err)]
}

export { idlePreview }
