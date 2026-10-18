import { z } from 'zod'
import type { DescriptorRef } from './descriptor.js'
import { FieldConfigSchema, type FieldConfig } from './fields.js'
import type { Frame } from './frame.js'

/**
 * Annotations (PLAN.md section 17): hand-written facts about one field of one route: unit, label, format,
 * priority, key. The residue of kinds, grown by the bench. `packages/core/annotations.yml` is the seed;
 * `~/.terminal/annotations.yml` may add to it. Matching is by connector, route glob and field; a more specific
 * rule wins field by field, so `*:*:volume` sets the format and `openbb:equity/price/quote:volume` can add a label.
 *
 * `applyAnnotations` converts units to the product's conventions (fractions become percent) and stamps the frame's
 * `meta.fields`, so previews and views agree. A field without an annotation is shown as-is and carries no unit.
 */

export type AnnotationRule = {
  /** Connector name or '*'. */
  connector: string
  /** Route glob: exact, with `*` wildcards (matching across `/`), or '*'. */
  route: string
  /** Field name or glob. */
  field: string
  config: FieldConfig
  specificity: number
  /** Position in the source; later rules win ties. */
  order: number
}

const KEY_RE = /^([a-z0-9*_-]+):([^:\s]+):([^:\s]+)$/i

/** Parse `"connector:route-glob:field": { unit, label, … }` entries (a map, or `{ annotations: map }`, or a list of `{ match, …config }`). */
export function parseAnnotations(doc: unknown, opts: { orderFrom?: number } = {}): AnnotationRule[] {
  const body = (doc as { annotations?: unknown } | null)?.annotations ?? doc
  const entries: [string, unknown][] = Array.isArray(body)
    ? body.map((e) => {
        const { match, ...config } = (e ?? {}) as { match?: string } & Record<string, unknown>
        return [String(match ?? ''), config]
      })
    : Object.entries((body ?? {}) as Record<string, unknown>)
  const rules: AnnotationRule[] = []
  let order = opts.orderFrom ?? 0
  for (const [key, raw] of entries) {
    const m = KEY_RE.exec(key.trim())
    if (!m) throw new Error(`annotation key "${key}" is not connector:route:field`)
    const config = FieldConfigSchema.parse(raw ?? {})
    const [, connector, route, field] = m as unknown as [string, string, string, string]
    rules.push({ connector, route, field, config, specificity: specificityOf(connector, route, field), order: order++ })
  }
  return rules
}

export const AnnotationsDocSchema = z.record(z.string(), FieldConfigSchema)

function specificityOf(connector: string, route: string, field: string): number {
  let s = 0
  if (connector !== '*') s += 4
  if (route !== '*') s += route.includes('*') ? 4 : 8
  if (field !== '*') s += field.includes('*') ? 1 : 2
  return s
}

const globCache = new Map<string, RegExp>()
/** `*` matches any run of characters (including `/`), `?` one character; anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob)
  if (!re) {
    const src = glob
      .split('*')
      .map((part) => part.split('?').map(escape).join('.'))
      .join('.*')
    re = new RegExp(`^${src}$`)
    globCache.set(glob, re)
  }
  return re
}
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

export function ruleMatches(rule: AnnotationRule, ref: DescriptorRef, field: string): boolean {
  if (rule.connector !== '*' && rule.connector !== ref.connector) return false
  if (rule.route !== '*' && !(rule.route === ref.route || globToRegExp(rule.route).test(ref.route))) return false
  if (rule.field !== '*' && !(rule.field === field || globToRegExp(rule.field).test(field))) return false
  return true
}

/** The merged config for one field of one route: matching rules folded in ascending specificity, later rules winning ties. */
export function annotationsFor(rules: readonly AnnotationRule[], ref: DescriptorRef, field: string): FieldConfig {
  const matching = rules.filter((r) => ruleMatches(r, ref, field)).sort((a, b) => a.specificity - b.specificity || a.order - b.order)
  const out: FieldConfig = {}
  for (const r of matching) Object.assign(out, r.config)
  return out
}

/** Configs for every named column that has at least one annotation. */
export function annotationsForColumns(rules: readonly AnnotationRule[], ref: DescriptorRef, columns: readonly string[]): Record<string, FieldConfig> {
  const out: Record<string, FieldConfig> = {}
  for (const c of columns) {
    const cfg = annotationsFor(rules, ref, c)
    if (Object.keys(cfg).length > 0) out[c] = cfg
  }
  return out
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4

/**
 * Apply annotations to a frame from `ref`: fraction columns are multiplied by 100 (rounded to 4 dp) and stamped
 * `percent`; every annotated column's config lands in `meta.fields`, merged over what the frame already carries.
 * Idempotent: a column already stamped `percent` is not converted again. Returns a new frame; the input is untouched.
 */
export function applyAnnotations(frame: Frame, ref: DescriptorRef, rules: readonly AnnotationRule[]): Frame {
  const names = frame.columns.map((c) => c.name)
  const annotated = annotationsForColumns(rules, ref, names)
  if (Object.keys(annotated).length === 0 && !frame.meta.fields) return frame
  const fields: Record<string, FieldConfig> = { ...(frame.meta.fields ?? {}) }
  const convert: number[] = []
  names.forEach((name, i) => {
    const cfg = annotated[name]
    if (!cfg) return
    const prior = fields[name] ?? {}
    const merged: FieldConfig = { ...prior, ...cfg }
    if (cfg.unit === 'fraction') {
      if (prior.unit !== 'percent' && frame.columns[i]!.type === 'number') convert.push(i)
      merged.unit = 'percent'
    }
    fields[name] = merged
  })
  const rows = convert.length === 0 ? frame.rows : frame.rows.map((row) => {
    const r = [...row]
    for (const i of convert) {
      const v = r[i]
      if (typeof v === 'number' && Number.isFinite(v)) r[i] = round4(v * 100)
    }
    return r
  })
  return { ...frame, rows, meta: { ...frame.meta, fields } }
}

/** One line per rule, for the Data page and debugging. */
export function describeRule(r: AnnotationRule): string {
  const parts = Object.entries(r.config).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  return `${r.connector}:${r.route}:${r.field} → ${parts.join(' ')}`
}
