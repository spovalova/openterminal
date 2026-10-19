import { useId, useMemo, type FC } from 'react'
import { Button } from '@terminal/ui'
import { FieldOverridesSchema, controlFor, type FieldOverrides, type PresetName } from '@terminal/core'
import { datasetsConfigFrom, optionText, optionValue, presetOptions, presetsAvailable, primaryDatasetName, setViewOption, switchPreset, type EditorDraft, type OptionSpec } from './editor-model'
import { firstIssue } from './EditorTransform'
import { Field, inputCls, labelCls } from './ParamsForm'
import type { Frame } from '@terminal/core'
import { useState } from 'react'

export type EditorViewProps = {
  draft: EditorDraft
  onChange: (next: EditorDraft) => void
  /** Frames previewed on the Data tab, by dataset: they gate the preset list and feed the expanded panes. */
  frames: Record<string, Frame>
  onPreview: (name: string) => Promise<void>
}

const PRESET_HINT: Record<PresetName, string> = {
  price: 'One symbol over time: line or candles, optional volume pane, event markers, levels and bands.',
  compare: 'Several lines over time (symbols or datasets), indexed to 100 by default.',
  curve: 'A line over a numeric x axis: a yield curve by maturity, an IV term structure by strike.',
  indicator: 'Price with RSI and MACD panes from transform columns.',
  table: 'Rows and columns; pick, order, sort, highlight and colour columns.',
  stat: 'One headline number per group with its change.',
  facts: 'A one-row snapshot as labels over values.',
  chain: 'The option chain: calls, strike, puts.',
  heatmap: 'A matrix as coloured cells, diverging or sequential.',
}

/** The view tab: the preset (gated by the primary dataset's shape when its frame has landed), its options from `ViewV2Schema`, the expanded panes read-only. */
export const EditorView: FC<EditorViewProps> = ({ draft, onChange, frames, onPreview }) => {
  const uid = useId()
  const presets = presetsAvailable(draft, frames)
  const options = presetOptions(draft.view.preset)
  const datasets = Object.keys(draft.data)
  const primary = primaryDatasetName(draft)
  const frame = primary ? frames[primary] : undefined
  const columns = frame?.columns.map((c) => c.name) ?? []
  const config = useMemo(() => datasetsConfigFrom(frames), [frames])
  const control = useMemo(() => (Object.keys(config).length ? controlFor(draft.view, config) : undefined), [draft.view, config])
  const [fieldsText, setFieldsText] = useState(draft.fields ? JSON.stringify(draft.fields) : '')
  const [fieldsError, setFieldsError] = useState<string | null>(null)

  const setOption = (spec: OptionSpec, raw: string | boolean) => onChange({ ...draft, view: setViewOption(draft.view, spec.name, optionValue(spec, raw)) })

  const applyFields = (text: string) => {
    setFieldsText(text)
    if (!text.trim()) {
      setFieldsError(null)
      const next = { ...draft }
      delete next.fields
      onChange(next)
      return
    }
    try {
      const fields: FieldOverrides = FieldOverridesSchema.parse(JSON.parse(text))
      setFieldsError(null)
      onChange({ ...draft, fields })
    } catch (err) {
      setFieldsError(firstIssue(err))
    }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
      <div className="flex flex-col gap-3">
        <Field id={`${uid}-preset`} label="Preset" hint={frame ? `Presets the ${primary} frame's shape allows` : 'Every preset; preview a dataset to narrow the list to its shape'}>
          <select id={`${uid}-preset`} className={inputCls} value={draft.view.preset} onChange={(e) => onChange({ ...draft, view: switchPreset(draft.view, e.target.value as PresetName) })}>
            {presets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-fg-2">{PRESET_HINT[draft.view.preset]}</p>
        {!frame && primary && (
          <div className="flex items-center gap-2 text-xs text-fg-3">
            No frame for <span className="num">{primary}</span> yet, so every preset is offered.
            <Button type="button" size="sm" variant="ghost" onClick={() => void onPreview(primary)}>
              Preview it
            </Button>
          </div>
        )}

        <div data-options="" className="grid grid-cols-2 gap-3">
          {options.map((spec) => {
            const id = `${uid}-opt-${spec.name}`
            const value = (draft.view as Record<string, unknown>)[spec.name]
            const label = spec.name.replace(/_/g, ' ')
            if (spec.input === 'boolean') {
              return (
                <label key={spec.name} className="flex items-center gap-2 self-end text-fg" title={spec.description}>
                  <input id={id} type="checkbox" checked={value === true} onChange={(e) => setOption(spec, e.target.checked ? true : '')} />
                  {label}
                </label>
              )
            }
            if (spec.input === 'select') {
              return (
                <Field key={spec.name} id={id} label={label} hint={spec.description}>
                  <select id={id} className={inputCls} value={optionText(spec, value)} onChange={(e) => setOption(spec, e.target.value)}>
                    <option value="">—</option>
                    {spec.options!.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            }
            if (spec.input === 'dataset') {
              return (
                <Field key={spec.name} id={id} label={label} hint={spec.description}>
                  <select id={id} className={inputCls} value={optionText(spec, value)} onChange={(e) => setOption(spec, e.target.value)}>
                    <option value="">{spec.name === 'data' ? `default (${primary ?? '—'})` : '—'}</option>
                    {datasets.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            }
            if (spec.input === 'number') {
              return (
                <Field key={spec.name} id={id} label={label} hint={spec.description}>
                  <input id={id} type="number" className={inputCls} step={spec.integer ? 1 : 'any'} min={spec.min} max={spec.max} value={optionText(spec, value)} onChange={(e) => setOption(spec, e.target.value)} />
                </Field>
              )
            }
            const wide = spec.input === 'list' || spec.input === 'json'
            return (
              <Field key={spec.name} id={id} label={`${label}${spec.input === 'list' ? ' (comma separated)' : spec.input === 'json' ? ' (JSON)' : ''}`} hint={spec.description} wide={wide}>
                <input id={id} className={`${inputCls} ${spec.input === 'json' ? 'num' : ''}`} list={spec.input === 'column' && columns.length ? `${id}-columns` : undefined} value={optionText(spec, value)} onChange={(e) => setOption(spec, e.target.value)} />
                {spec.input === 'column' && columns.length > 0 && (
                  <datalist id={`${id}-columns`}>
                    {columns.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                )}
              </Field>
            )
          })}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-fields`} className={labelCls}>
            Field overrides (optional JSON: label, unit, format, priority per column)
          </label>
          <input id={`${uid}-fields`} className={`${inputCls} num`} value={fieldsText} placeholder='{"pe": {"label": "P/E (TTM)", "unit": "ratio"}}' onChange={(e) => applyFields(e.target.value)} />
          {fieldsError && <div className="text-xs text-down">{fieldsError}</div>}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <span className={labelCls}>Expanded (read-only)</span>
        <pre data-expanded="" className="num min-h-40 flex-1 overflow-auto rounded border border-border bg-bg p-2 text-xs text-fg-2">
          {JSON.stringify({ view: draft.view }, null, 2)}
          {'\n'}
          {control ? JSON.stringify(control, null, 2) : `// Preview a dataset on the Data tab to expand the preset into ${draft.view.preset === 'table' || draft.view.preset === 'stat' || draft.view.preset === 'facts' || draft.view.preset === 'chain' ? 'its control' : 'panes and layers'}.`}
        </pre>
      </div>
    </div>
  )
}
