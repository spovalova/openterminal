import type { FC, ReactNode } from 'react'
import type { DescriptorParam } from '@terminal/core'

/** Columns whose values are tickers: upper-cased on input. */
const TICKER_FIELDS = new Set(['symbol', 'symbols', 'tickers'])

export const inputCls = 'w-full rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent'
export const labelCls = 'text-[11px] tracking-wide text-fg-2 uppercase'

export function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'col-span-2 flex flex-col gap-1' : 'flex flex-col gap-1'}>
      <label htmlFor={id} className={labelCls} title={hint}>
        {label}
      </label>
      {children}
    </div>
  )
}

/** The text an input shows for a param's value. */
export function paramText(p: DescriptorParam, v: unknown): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

/** What a typed string means for a param: arrays split on commas, numbers parsed when valid, blanks cleared. */
export function paramValue(p: DescriptorParam, raw: string | boolean): unknown {
  if (p.type === 'boolean') return raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : undefined
  const text = typeof raw === 'string' ? raw : String(raw)
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (p.type === 'string[]') {
    const items = trimmed.split(/[,\s]+/).map((s) => (TICKER_FIELDS.has(p.name) ? s.toUpperCase() : s)).filter(Boolean)
    return items.length ? items : undefined
  }
  if (p.type === 'number' || p.type === 'integer') {
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : trimmed
  }
  return TICKER_FIELDS.has(p.name) ? trimmed.toUpperCase() : trimmed
}

export type ParamsFormProps = {
  id: string
  params: DescriptorParam[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  /** Providers the route offers; a `provider` select is added when non-empty. */
  providers?: string[]
}

/** A form generated from descriptor params (routes and recipes both describe themselves this way). */
export const ParamsForm: FC<ParamsFormProps> = ({ id, params, values, onChange, providers }) => {
  const set = (name: string, v: unknown) => {
    const next = { ...values }
    if (v === undefined) delete next[name]
    else next[name] = v
    onChange(next)
  }
  const fid = (name: string) => `${id}-${name}`
  const labelOf = (p: DescriptorParam) => `${p.name.replace(/_/g, ' ')}${p.required || p.default !== undefined ? '' : ' (optional)'}`
  return (
    <div data-params="" className="grid grid-cols-2 gap-3">
      {params.map((p) => {
        const text = paramText(p, values[p.name])
        if (p.type === 'boolean') {
          return (
            <label key={p.name} className="flex items-center gap-2 self-end text-fg" title={p.description}>
              <input id={fid(p.name)} type="checkbox" checked={values[p.name] === true} onChange={(e) => set(p.name, e.target.checked ? true : undefined)} />
              {p.name.replace(/_/g, ' ')}
            </label>
          )
        }
        if (p.enum) {
          return (
            <Field key={p.name} id={fid(p.name)} label={labelOf(p)} hint={p.description}>
              <select id={fid(p.name)} className={inputCls} value={text} onChange={(e) => set(p.name, paramValue(p, e.target.value))}>
                {!p.required && <option value="">—</option>}
                {p.enum.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          )
        }
        if (p.type === 'number' || p.type === 'integer') {
          return (
            <Field key={p.name} id={fid(p.name)} label={labelOf(p)} hint={p.description}>
              <input id={fid(p.name)} className={inputCls} type="number" step={p.type === 'integer' ? 1 : 'any'} value={text} placeholder={p.default !== undefined ? String(p.default) : undefined} onChange={(e) => set(p.name, paramValue(p, e.target.value))} />
            </Field>
          )
        }
        if (p.type === 'date') {
          return (
            <Field key={p.name} id={fid(p.name)} label={labelOf(p)} hint={p.description}>
              <input id={fid(p.name)} className={inputCls} type="date" value={text} onChange={(e) => set(p.name, paramValue(p, e.target.value))} />
            </Field>
          )
        }
        const wide = p.type === 'string[]' || !TICKER_FIELDS.has(p.name)
        return (
          <Field key={p.name} id={fid(p.name)} label={`${labelOf(p)}${p.type === 'string[]' ? ' (comma separated)' : ''}`} hint={p.description} wide={wide}>
            <input
              id={fid(p.name)}
              className={inputCls}
              value={text}
              placeholder={p.type === 'string[]' && TICKER_FIELDS.has(p.name) ? 'NVDA, AMD' : p.name === 'symbol' ? 'NVDA' : p.default !== undefined ? String(p.default) : undefined}
              onChange={(e) => set(p.name, paramValue(p, e.target.value))}
            />
          </Field>
        )
      })}
      {providers && providers.length > 0 && (
        <Field id={fid('provider')} label="provider (optional)" hint="Which of the route's providers answers; the Data page sets a default per route.">
          <select id={fid('provider')} className={inputCls} value={typeof values.provider === 'string' ? values.provider : ''} onChange={(e) => set('provider', e.target.value || undefined)}>
            <option value="">default</option>
            {providers.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  )
}
