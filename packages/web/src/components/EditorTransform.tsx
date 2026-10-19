import { useId, useState, type FC } from 'react'
import { Button } from '@openterminal/ui'
import { FieldOverridesSchema, TRANSFORM_EXAMPLE, isTransformQuery, otHelpersDoc, type AnyQuery, type TransformQuery } from '@openterminal/core'
import { CodeEditor } from './CodeEditor'
import { newTransform, nextDatasetName, type EditorDraft } from './editor-model'
import { FramePreview, type PreviewState } from './FramePreview'
import { inputCls, labelCls } from './ParamsForm'

/** The first Zod issue, else the error's message. */
export function firstIssue(err: unknown): string {
  const issue = (err as { issues?: { path?: PropertyKey[]; message: string }[] } | null)?.issues?.[0]
  if (issue) return `${issue.path?.length ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`
  return err instanceof Error ? err.message : String(err)
}

export type EditorTransformProps = {
  draft: EditorDraft
  onChange: (next: EditorDraft) => void
  previews: Record<string, PreviewState>
  runPreview: (name: string, refresh?: boolean) => Promise<void>
}

/** The transform tab: which dataset is the transform, its inputs (other datasets), the Python in CodeMirror, Run with the traceback inline. */
export const EditorTransform: FC<EditorTransformProps> = ({ draft, onChange, previews, runPreview }) => {
  const uid = useId()
  const transforms = Object.keys(draft.data).filter((n) => isTransformQuery(draft.data[n]!))
  const [picked, setPicked] = useState<string>(transforms[0] ?? '')
  const name = transforms.includes(picked) ? picked : (transforms[0] ?? '')
  const q = name ? (draft.data[name] as TransformQuery) : undefined
  const others = Object.keys(draft.data).filter((n) => n !== name && !isTransformQuery(draft.data[n]!))
  const [columnsText, setColumnsText] = useState<string>(q?.columns ? JSON.stringify(q.columns) : '')
  const [columnsError, setColumnsError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const setQ = (next: TransformQuery) => onChange({ ...draft, data: { ...draft.data, [name]: next } })

  const create = () => {
    const n = nextDatasetName(draft.data, 'derived')
    onChange({ ...draft, data: { ...draft.data, [n]: newTransform(draft.data, others) } })
    setPicked(n)
  }

  if (!q) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-fg-2">
          A transform is Python over the widget's other datasets: each input is a DataFrame of that name, the script assigns <code className="num">result</code>. The result goes through the same inference, annotations and views as a route's frame.
        </p>
        <Button type="button" size="sm" variant="primary" onClick={create}>
          + Add a transform
        </Button>
        <pre className="num w-full overflow-auto rounded border border-border bg-bg p-2 text-xs text-fg-3">{TRANSFORM_EXAMPLE.code}</pre>
      </div>
    )
  }

  const toggleInput = (input: string, on: boolean) => {
    const inputs: Record<string, AnyQuery> = { ...q.inputs }
    if (on) inputs[input] = draft.data[input]!
    else delete inputs[input]
    setQ({ ...q, inputs })
  }

  const applyColumns = (text: string) => {
    setColumnsText(text)
    if (!text.trim()) {
      setColumnsError(null)
      const next = { ...q }
      delete next.columns
      setQ(next)
      return
    }
    try {
      const parsed = FieldOverridesSchema.parse(JSON.parse(text))
      setColumnsError(null)
      setQ({ ...q, columns: parsed })
    } catch (err) {
      setColumnsError(firstIssue(err))
    }
  }

  const preview = previews[name] ?? { status: 'idle' }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-which`} className={labelCls}>
            Transform dataset
          </label>
          <select id={`${uid}-which`} className={inputCls} value={name} onChange={(e) => setPicked(e.target.value)}>
            {transforms.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className={labelCls}>Inputs (DataFrames by name)</legend>
          <div className="flex flex-wrap gap-3">
            {others.length === 0 && <span className="text-fg-3">Add a route or recipe dataset on the Data tab first.</span>}
            {others.map((n) => (
              <label key={n} className="flex items-center gap-1.5 text-fg">
                <input type="checkbox" name="input" value={n} checked={n in q.inputs} onChange={(e) => toggleInput(n, e.target.checked)} />
                <span className="num">{n}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={create}>
            + another
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setHelpOpen((o) => !o)}>
            {helpOpen ? 'Hide ot helpers' : 'ot helpers'}
          </Button>
          <Button type="button" size="sm" variant="primary" onClick={() => void runPreview(name)} disabled={preview.status === 'loading'} title="Ctrl/⌘+Enter in the editor">
            Run
          </Button>
        </div>
      </div>

      {helpOpen && <pre className="num max-h-40 overflow-auto rounded border border-border bg-bg p-2 text-xs text-fg-2">{otHelpersDoc()}</pre>}

      <div className="flex flex-col gap-1">
        <span className={labelCls}>Python (pandas as pd, numpy as np, the ot helpers; assign `result`)</span>
        <CodeEditor value={q.code} onChange={(code) => setQ({ ...q, code })} onRun={() => void runPreview(name)} placeholder={TRANSFORM_EXAMPLE.code} label="Transform code" minHeight={200} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-columns`} className={labelCls}>
          Columns (optional JSON: unit and label per column you created)
        </label>
        <input id={`${uid}-columns`} className={`${inputCls} num`} value={columnsText} placeholder='{"pe": {"unit": "ratio", "label": "P/E (TTM)"}}' onChange={(e) => applyColumns(e.target.value)} />
        {columnsError && <div className="text-xs text-down">{columnsError}</div>}
      </div>

      <div className="flex flex-col gap-1">
        <span className={labelCls}>Result</span>
        <FramePreview preview={preview} query={q} height={200} />
      </div>
    </div>
  )
}
