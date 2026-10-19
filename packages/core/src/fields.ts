import { z } from 'zod'
import type { Shape } from './shape.js'

/**
 * Field config (PLAN.md section 17, "the widget model"): every column of a frame carries a config that
 * views, previews and the table control read instead of a kind. It comes from three layers, later ones
 * overriding: shape detection (roles), annotations by route and field (units, labels, formats), and
 * per-widget overrides. `mergeFieldConfig` folds the three.
 */

/** What a column is for in a view. `x` is a numeric x-axis (maturity, strike); `level` a horizontal line value. */
export const FIELD_ROLES = ['time', 'group', 'measure', 'label', 'level', 'x'] as const
export const FieldRoleSchema = z.enum(FIELD_ROLES)
export type FieldRole = z.infer<typeof FieldRoleSchema>

/**
 * Units a field may carry. `fraction` is what providers send (0.0563) and is converted to `percent` (5.63) by
 * `applyAnnotations`; everything the views and the agent see is in product conventions, so a frame never
 * carries `fraction` after the runner. `ratio` is a multiple (P/E 42.1), `usd` dollars, `shares` a share count,
 * `count` a plain count, `days` and `years` durations, `bps` basis points.
 */
export const UNITS = ['fraction', 'percent', 'ratio', 'usd', 'shares', 'count', 'days', 'years', 'bps'] as const
export const UnitSchema = z.enum(UNITS)
export type Unit = z.infer<typeof UnitSchema>

/** Display formats; the names match the web's cell formats. */
export const FORMATS = ['text', 'price', 'percent', 'change', 'integer', 'compact', 'ratio', 'time', 'date', 'link'] as const
export const FormatSchema = z.enum(FORMATS)
export type Format = z.infer<typeof FormatSchema>

export const FieldConfigSchema = z.object({
  role: FieldRoleSchema.optional(),
  unit: UnitSchema.optional(),
  /** Human label ("Chg %", "IV30 high"); the column name when absent. */
  label: z.string().trim().min(1).max(40).optional(),
  format: FormatSchema.optional(),
  /** CSS colour for the series drawn from this field. */
  color: z.string().min(1).optional(),
  /** 1 is shown first and survives the narrowest widget; higher numbers are shed first. */
  priority: z.number().int().min(1).max(9).optional(),
  /** The stat view's headline column. */
  key: z.boolean().optional(),
  /** One line from the descriptor; shown in tooltips and the preview. */
  description: z.string().optional(),
  hidden: z.boolean().optional(),
})
export type FieldConfig = z.infer<typeof FieldConfigSchema>

/** Per-field overrides as a widget or a transform's `columns` block carries them. */
export const FieldOverridesSchema = z.record(z.string().min(1), FieldConfigSchema)
export type FieldOverrides = z.infer<typeof FieldOverridesSchema>

/** The roles a shape implies, one per column that has one. */
export function rolesFromShape(shape: Shape): Record<string, FieldRole> {
  const roles: Record<string, FieldRole> = {}
  for (const c of shape.columns) {
    if (c.name === shape.time) roles[c.name] = 'time'
    else if (c.name === shape.group) roles[c.name] = 'group'
    else if (c.name === shape.x) roles[c.name] = 'x'
    else if (c.type === 'number') roles[c.name] = 'measure'
    else if (c.type === 'string') roles[c.name] = 'label'
  }
  return roles
}

/**
 * Fold the three layers into one config per column. Every column of the shape gets an entry; columns named only
 * in annotations or overrides are kept too, so a transform can declare a column before it exists.
 * Later layers override field by field, not key by key: `{ label }` from an override keeps the unit from the annotation.
 */
export function mergeFieldConfig(shape: Shape, annotations: FieldOverrides = {}, overrides: FieldOverrides = {}): Record<string, FieldConfig> {
  const roles = rolesFromShape(shape)
  const out: Record<string, FieldConfig> = {}
  const names = new Set<string>([...shape.columns.map((c) => c.name), ...Object.keys(annotations), ...Object.keys(overrides)])
  for (const name of names) {
    const base: FieldConfig = {}
    if (roles[name]) base.role = roles[name]
    out[name] = { ...base, ...compact(annotations[name]), ...compact(overrides[name]) }
  }
  return out
}

/** The unit a measure displays in after the runner's conversion: fractions become percent. */
export function displayUnit(unit: Unit | undefined): Unit | undefined {
  return unit === 'fraction' ? 'percent' : unit
}

/** The default format for a field from its unit and type, when no annotation set one. */
export function defaultFormat(config: FieldConfig, type: 'string' | 'number' | 'time' | 'boolean'): Format {
  if (config.format) return config.format
  if (type === 'time') return 'time'
  if (type !== 'number') return 'text'
  switch (config.unit) {
    case 'percent':
    case 'fraction':
      return 'percent'
    case 'usd':
      return 'price'
    case 'shares':
    case 'count':
      return 'compact'
    case 'ratio':
      return 'ratio'
    case 'days':
    case 'years':
    case 'bps':
      return 'integer'
    default:
      // A number nobody annotated (a transform's rsi, a pivot's cells) still reads as a number: two decimals with
      // separators, never the raw float (phase 2b: "37.765730145489876" in a stat).
      return 'ratio'
  }
}

/** Columns in display order: by priority (1 first), then the frame's own order. Hidden columns are left out. */
export function orderByPriority(names: readonly string[], fields: Record<string, FieldConfig>): string[] {
  return names
    .filter((n) => !fields[n]?.hidden)
    .map((n, i) => ({ n, i, p: fields[n]?.priority ?? 5 }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.n)
}

/** The headline column for a stat: the one marked `key`, else the first measure. */
export function keyField(fields: Record<string, FieldConfig>, order: readonly string[] = Object.keys(fields)): string | undefined {
  return order.find((n) => fields[n]?.key) ?? order.find((n) => fields[n]?.role === 'measure')
}

function compact(c: FieldConfig | undefined): FieldConfig {
  if (!c) return {}
  const out: FieldConfig = {}
  for (const [k, v] of Object.entries(c)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}
