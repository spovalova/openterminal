import { z } from 'zod'
import { defaultFormat, keyField, orderByPriority, type FieldConfig, type Format } from './fields.js'
import type { Layer, Pane, Scale } from './layers.js'
import { detectShape, type PresetName, type Shape } from './shape.js'
import { LegendLabelsSchema } from './view-options.js'

/**
 * Presets (PLAN.md section 17): the agent and the editor name a preset with options; `expandPreset` is the pure
 * function from (options, field config of the datasets) to panes and layers. Presets bind by role, so `compare`
 * works on any dataset with time, group and a measure, whether it came from a route or a transform.
 * The non-chart presets (table, stat, facts, chain) expand to no panes; `controlFor` gives their spec.
 */

const field = z.string().min(1)
const datasetOpt = z.string().min(1).optional().describe('Which dataset to draw when the widget has several; the first one otherwise')

export const PricePresetSchema = z.object({
  preset: z.literal('price'),
  data: datasetOpt,
  candle: z.boolean().optional(),
  volume: z.boolean().optional(),
  /** A dataset with a time column drawn as markers (earnings, dividends, news, insiders, or hand-typed events). */
  events: field.optional(),
  /** Horizontal lines: constants, or a dataset whose key measure is drawn per row (strikes, targets). */
  levels: z.union([z.array(z.number()), field]).optional(),
  /** Shade where this dataset's boolean field is true, or a fixed [from, to] range in epoch ms. */
  band: z.union([z.object({ data: field, when: field }), z.tuple([z.number(), z.number()])]).optional(),
  labels: LegendLabelsSchema.optional(),
})
export const ComparePresetSchema = z.object({
  preset: z.literal('compare'),
  data: datasetOpt,
  /** Index every line to 100 at its first value; on by default. */
  normalize: z.boolean().optional(),
  labels: LegendLabelsSchema.optional(),
})
export const CurvePresetSchema = z.object({
  preset: z.literal('curve'),
  data: datasetOpt,
  x: field.optional(),
  y: z.union([field, z.array(field).min(1)]).optional(),
  group: field.optional(),
  labels: LegendLabelsSchema.optional(),
})
export const IndicatorPresetSchema = z.object({
  preset: z.literal('indicator'),
  data: datasetOpt,
  candle: z.boolean().optional(),
  volume: z.boolean().optional(),
  /** RSI period; the dataset must carry `rsi` (or `rsi_<n>`), from the ot.rsi helper in a transform. */
  rsi: z.number().int().min(2).max(100).optional(),
  /** MACD pane from `macd`, `macd_signal`, `macd_hist` columns. */
  macd: z.boolean().optional(),
  /** Overlay columns on the price pane: `sma_<n>`, `ema_<n>`, `bb_upper`/`bb_lower`. */
  overlays: z.array(field).optional(),
})
export const TablePresetSchema = z.object({
  preset: z.literal('table'),
  data: datasetOpt,
  columns: z.array(field).min(1).optional(),
  sort: z.object({ column: field, dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
  /** Value of the group column (or first column) of the row to highlight. */
  highlight: z.union([z.string(), z.number()]).optional(),
  /** Columns with conditional colour (green up, red down); percent and change columns by default. */
  colorize: z.array(field).optional(),
  /** Mark the best and worst value in each numeric column (compare tables). */
  extremes: z.boolean().optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
})
export const StatPresetSchema = z.object({
  preset: z.literal('stat'),
  data: datasetOpt,
  /** The numeric column to show; the key field, else the first measure. */
  column: field.optional(),
  /** A column shown as the change line under the number (`change_pct` when present). */
  change: field.optional(),
  labels: LegendLabelsSchema.optional(),
})
export const FactsPresetSchema = z.object({
  preset: z.literal('facts'),
  data: datasetOpt,
  columns: z.array(field).min(1).optional(),
})
export const ChainPresetSchema = z.object({ preset: z.literal('chain'), data: datasetOpt })
export const HeatmapPresetSchema = z.object({
  preset: z.literal('heatmap'),
  data: datasetOpt,
  /** Long form: x, y and value columns. Wide form (the default): the group column by every numeric column. */
  x: field.optional(),
  y: field.optional(),
  value: field.optional(),
  palette: z.enum(['diverging', 'sequential']).optional(),
  text: z.boolean().optional(),
})

export const ViewV2Schema = z.discriminatedUnion('preset', [
  PricePresetSchema,
  ComparePresetSchema,
  CurvePresetSchema,
  IndicatorPresetSchema,
  TablePresetSchema,
  StatPresetSchema,
  FactsPresetSchema,
  ChainPresetSchema,
  HeatmapPresetSchema,
])
export type ViewV2 = z.output<typeof ViewV2Schema>
export type ViewV2Input = z.input<typeof ViewV2Schema>

export const CHART_PRESETS: ReadonlySet<PresetName> = new Set<PresetName>(['price', 'compare', 'curve', 'indicator', 'heatmap'])
export function isChartPreset(preset: PresetName): boolean {
  return CHART_PRESETS.has(preset)
}

/** What `expandPreset` needs per dataset: its shape and the merged field config. */
export type DatasetFields = { shape: Shape; fields: Record<string, FieldConfig> }
export type DatasetsFieldConfig = Record<string, DatasetFields>

/** `DatasetFields` from a frame's columns and rows (field config from `meta.fields` when stamped). */
export function datasetFieldsFrom(frame: { columns: Shape['columns']; rows: unknown[][]; meta?: { fields?: Record<string, FieldConfig> } }): DatasetFields {
  const shape = detectShape(frame.columns, frame.rows.slice(0, 500))
  const fields: Record<string, FieldConfig> = {}
  for (const c of frame.columns) fields[c.name] = { ...(frame.meta?.fields?.[c.name] ?? {}) }
  return { shape, fields }
}

/** Wide-form heatmap: `y` names every numeric column and `value` their cells. The renderer melts the frame. */
export const WIDE_COLUMNS = '$columns'
export const WIDE_VALUE = '$value'

/** The dataset a preset draws: the named one, else `main`, else the first. */
export function primaryDataset(view: { data?: string }, datasets: DatasetsFieldConfig): string | undefined {
  if (view.data && datasets[view.data]) return view.data
  if (datasets.main) return 'main'
  return Object.keys(datasets)[0]
}

/** The y field of a dataset for a price-like chart: close, else the key field, else the first measure. */
export function measureOf(ds: DatasetFields, prefer: readonly string[] = ['close', 'price', 'value', 'rate']): string | undefined {
  const measures = ds.shape.numeric.filter((n) => n !== ds.shape.x && !ds.fields[n]?.hidden)
  return prefer.find((p) => measures.includes(p)) ?? keyField(ds.fields, measures) ?? measures[0]
}

function scaleFor(ds: DatasetFields, y: string | undefined): Scale | undefined {
  const unit = y ? ds.fields[y]?.unit : undefined
  const format: Scale['format'] | undefined = unit === 'percent' || unit === 'fraction' ? 'percent' : unit === 'usd' ? 'price' : unit === 'shares' || unit === 'count' ? 'compact' : unit === 'ratio' ? 'ratio' : undefined
  return format ? { format } : undefined
}

const EVENT_LABELS = ['label', 'headline', 'event', 'title', 'name', 'action', 'holder'] as const
const EVENT_KINDS = ['kind', 'type', 'action', 'source'] as const

/** A marker layer over an events dataset: its time column, the first label-like string column, a kind column when there is one. */
export function markerLayer(name: string, ds: DatasetFields): Layer | undefined {
  const x = ds.shape.time ?? ds.shape.columns.find((c) => /^(date|ex_date|report_date|time)$/.test(c.name))?.name
  if (!x) return undefined
  const strings = ds.shape.columns.filter((c) => c.type === 'string').map((c) => c.name)
  const label = EVENT_LABELS.find((l) => strings.includes(l)) ?? strings.find((s) => s !== ds.shape.group)
  const kind = EVENT_KINDS.find((k) => strings.includes(k) && k !== label)
  const detail = ['reaction_pct', 'surprise_pct', 'eps_actual', 'amount', 'value', 'actual'].find((d) => ds.shape.numeric.includes(d) || strings.includes(d))
  const layer: Layer = { mark: 'marker', data: name, x }
  if (label) layer.label = label
  if (kind) layer.kind = kind
  if (detail) layer.detail = detail
  return layer
}

export function expandPreset(view: ViewV2, datasets: DatasetsFieldConfig): Pane[] {
  const name = primaryDataset(view, datasets)
  const ds = name ? datasets[name] : undefined
  if (!name || !ds) return []
  switch (view.preset) {
    case 'price':
      return pricePanes(view, name, ds, datasets)
    case 'compare': {
      // One line per time-series dataset when the widget has several and none was named (a migrated multi-series
      // macro widget is one `macro` dataset per series); otherwise one line per group of the primary dataset.
      const series = view.data ? [name] : Object.keys(datasets).filter((n) => datasets[n]!.shape.time && measureOf(datasets[n]!))
      const layers: Layer[] = []
      for (const n of series.length > 1 ? series : [name]) {
        const d = datasets[n]!
        const y = measureOf(d)
        if (!d.shape.time || !y) continue
        const layer: Layer = { mark: 'line', data: n, x: d.shape.time, y }
        if (d.shape.group) layer.group = d.shape.group
        if (series.length > 1) layer.label = d.fields[y]?.label ?? n
        layers.push(layer)
      }
      if (layers.length === 0) return []
      const indexed = view.normalize !== false
      const left: Scale = indexed ? { indexed: true } : { ...(scaleFor(ds, measureOf(ds)) ?? {}) }
      return [{ height: 1, x: 'time', layers, scales: { left }, legend: true, lastValue: true }]
    }
    case 'curve': {
      const x = view.x ?? ds.shape.x
      if (!x) return []
      const ys = Array.isArray(view.y) ? view.y : view.y ? [view.y] : [measureOf(ds, ['rate', 'yield', 'iv', 'implied_volatility', 'open_interest', 'value'])].filter((v): v is string => !!v && v !== x)
      if (ys.length === 0) return []
      const group = view.group ?? ds.shape.group
      const layers: Layer[] = ys.map((y) => {
        const l: Layer = { mark: 'line', data: name, x, y }
        if (group) l.group = group
        return l
      })
      const scale = scaleFor(ds, ys[0])
      const xType = ds.fields[x]?.role === 'time' || ds.shape.time === x ? 'time' : ds.shape.numeric.includes(x) ? 'number' : 'category'
      // The last-value badge stays on a numeric axis too: it marks the curve's long end, and every chart carries one (section 17 checklist).
      return [{ height: 1, x: xType, layers, ...(scale ? { scales: { left: scale } } : {}), legend: true, lastValue: true }]
    }
    case 'indicator':
      return indicatorPanes(view, name, ds)
    case 'heatmap': {
      const palette = view.palette ?? 'diverging'
      const layer: Layer =
        view.x && view.y && view.value
          ? { mark: 'cell', data: name, x: view.x, y: view.y, value: view.value, palette, text: view.text ?? true }
          : { mark: 'cell', data: name, x: view.x ?? ds.shape.group ?? ds.shape.columns[0]?.name ?? WIDE_COLUMNS, y: WIDE_COLUMNS, value: WIDE_VALUE, palette, text: view.text ?? true }
      return [{ height: 1, x: 'category', layers: [layer] }]
    }
    case 'table':
    case 'stat':
    case 'facts':
    case 'chain':
      return []
  }
}

function pricePanes(view: z.output<typeof PricePresetSchema>, name: string, ds: DatasetFields, datasets: DatasetsFieldConfig): Pane[] {
  const x = ds.shape.time
  if (!x) return []
  const layers: Layer[] = []
  const y = measureOf(ds)
  if (view.candle && ds.shape.ohlc) {
    const l: Layer = { mark: 'candle', data: name, x, open: 'open', high: 'high', low: 'low', close: 'close' }
    if (ds.shape.group) l.group = ds.shape.group
    layers.push(l)
  } else if (y) {
    const l: Layer = { mark: 'line', data: name, x, y }
    if (ds.shape.group) l.group = ds.shape.group
    layers.push(l)
  } else return []
  if (Array.isArray(view.levels)) for (const v of view.levels) layers.push({ mark: 'level', value: v, style: 'dashed' })
  else if (typeof view.levels === 'string' && datasets[view.levels]) {
    const lds = datasets[view.levels]!
    const ly = measureOf(lds, ['strike', 'target_consensus', 'price', 'value', 'level'])
    if (ly) layers.push({ mark: 'level', data: view.levels, y: ly, style: 'dashed' })
  }
  if (view.band) {
    if (Array.isArray(view.band)) layers.push({ mark: 'band', from: view.band[0], to: view.band[1] })
    else if (datasets[view.band.data]) layers.push({ mark: 'band', data: view.band.data, x: datasets[view.band.data]!.shape.time ?? x, when: view.band.when })
  }
  if (view.events && datasets[view.events]) {
    const m = markerLayer(view.events, datasets[view.events]!)
    if (m) layers.push(m)
  }
  const scale = scaleFor(ds, y ?? 'close')
  const panes: Pane[] = [{ height: 3, x: 'time', layers, ...(scale ? { scales: { left: scale } } : {}), legend: true, lastValue: true }]
  if (view.volume && ds.shape.numeric.includes('volume')) {
    const v: Layer = { mark: 'histogram', data: name, x, y: 'volume', colorBy: ds.shape.ohlc ? 'close' : 'volume' }
    if (ds.shape.group) v.group = ds.shape.group
    panes.push({ height: 1, x: 'time', layers: [v], scales: { left: { format: 'compact' } } })
  }
  return panes
}

function indicatorPanes(view: z.output<typeof IndicatorPresetSchema>, name: string, ds: DatasetFields): Pane[] {
  const x = ds.shape.time
  if (!x) return []
  const has = (c: string) => ds.shape.numeric.includes(c)
  const price: Layer[] = []
  if (view.candle && ds.shape.ohlc) price.push({ mark: 'candle', data: name, x, open: 'open', high: 'high', low: 'low', close: 'close' })
  else if (has('close')) price.push({ mark: 'line', data: name, x, y: 'close' })
  else return []
  const overlays = view.overlays ?? ds.shape.numeric.filter((c) => /^(sma|ema)_\d+$|^bb_(upper|lower|mid)$|^vwap$/.test(c))
  for (const o of overlays) if (has(o)) price.push({ mark: 'line', data: name, x, y: o, width: 1, label: o.replace('_', ' ').toUpperCase() })
  const panes: Pane[] = [{ height: 3, x: 'time', layers: price, legend: true, lastValue: true }]
  if (view.volume && has('volume')) panes.push({ height: 1, x: 'time', layers: [{ mark: 'histogram', data: name, x, y: 'volume', colorBy: ds.shape.ohlc ? 'close' : 'volume' }], scales: { left: { format: 'compact' } } })
  if (view.rsi !== undefined) {
    const col = has('rsi') ? 'rsi' : has(`rsi_${view.rsi}`) ? `rsi_${view.rsi}` : undefined
    if (col) {
      panes.push({
        height: 1,
        x: 'time',
        title: `RSI ${view.rsi}`,
        layers: [
          { mark: 'line', data: name, x, y: col, label: `RSI ${view.rsi}` },
          { mark: 'level', value: 70, style: 'dotted' },
          { mark: 'level', value: 30, style: 'dotted' },
        ],
        scales: { left: { min: 0, max: 100 } },
        lastValue: true,
      })
    }
  }
  if (view.macd && has('macd')) {
    const layers: Layer[] = [{ mark: 'line', data: name, x, y: 'macd', label: 'MACD' }]
    if (has('macd_signal')) layers.push({ mark: 'line', data: name, x, y: 'macd_signal', label: 'Signal', width: 1 })
    if (has('macd_hist')) layers.unshift({ mark: 'histogram', data: name, x, y: 'macd_hist', signed: true })
    layers.push({ mark: 'level', value: 0, style: 'dotted' })
    panes.push({ height: 1, x: 'time', title: 'MACD', layers, lastValue: true })
  }
  return panes
}

// ---- non-chart presets ----

export type TableControl = {
  kind: 'table'
  data: string
  /** Visible columns in display order. */
  columns: string[]
  formats: Record<string, Format>
  labels: Record<string, string>
  sort?: { column: string; dir: 'asc' | 'desc' }
  highlight?: { column: string; value: string | number }
  colorize: string[]
  extremes: boolean
  limit?: number
}
export type StatControl = { kind: 'stat'; data: string; column: string; group?: string; change?: string; format: Format; unit?: FieldConfig['unit']; label: string }
export type FactsControl = { kind: 'facts'; data: string; columns: string[]; formats: Record<string, Format>; labels: Record<string, string> }
export type ChainControl = { kind: 'chain'; data: string }
export type ChartControl = { kind: 'chart'; panes: Pane[] }
export type Control = TableControl | StatControl | FactsControl | ChainControl | ChartControl

/** The renderer's spec for a view: panes for chart presets, the table/stat/facts/chain control otherwise. */
export function controlFor(view: ViewV2, datasets: DatasetsFieldConfig): Control | undefined {
  const name = primaryDataset(view, datasets)
  const ds = name ? datasets[name] : undefined
  if (!name || !ds) return undefined
  const names = ds.shape.columns.map((c) => c.name)
  const typeOf = (n: string) => ds.shape.columns.find((c) => c.name === n)?.type ?? 'string'
  const formats = (cols: string[]) => Object.fromEntries(cols.map((c) => [c, defaultFormat(ds.fields[c] ?? {}, typeOf(c))]))
  const labels = (cols: string[]) => Object.fromEntries(cols.flatMap((c) => (ds.fields[c]?.label ? [[c, ds.fields[c]!.label!]] : [])))
  switch (view.preset) {
    case 'table': {
      // A column list that names nothing in the frame (a recipe's list written for another connector's fields, a
      // fallback route) falls back to the priority order rather than an empty table (phase 2 integration).
      const picked = view.columns?.filter((c) => names.includes(c)) ?? []
      const columns = picked.length > 0 ? picked : orderByPriority(names, ds.fields)
      const colorize = view.colorize ?? columns.filter((c) => /percent|change/.test(defaultFormat(ds.fields[c] ?? {}, typeOf(c))) || /_pct$|^change/.test(c))
      const control: TableControl = { kind: 'table', data: name, columns, formats: formats(columns), labels: labels(columns), colorize, extremes: view.extremes ?? false }
      // A sort on a date column the frame names differently (ex_dividend_date vs date) falls back to the time column.
      const sortColumn = view.sort ? (names.includes(view.sort.column) ? view.sort.column : /date|time/i.test(view.sort.column) ? ds.shape.time : undefined) : undefined
      if (view.sort && sortColumn) control.sort = { column: sortColumn, dir: view.sort.dir }
      if (view.highlight !== undefined) control.highlight = { column: ds.shape.group ?? names[0] ?? '', value: view.highlight }
      if (view.limit) control.limit = view.limit
      return control
    }
    case 'stat': {
      const column = view.column && names.includes(view.column) ? view.column : keyField(ds.fields, ds.shape.numeric) ?? ds.shape.numeric[0]
      if (!column) return undefined
      // The change line: the named column, the conventional names, else the annotated day change (a percent column
      // with the `change` format: yahoo's regularMarketChangePercent, finnhub's dp), so the stat works on every quote route.
      // The bare day-change columns belong to a price headline; under IV30 or a P/E the stock's day move would mislead.
      const priceLike = /price|close|last|value|rate|nav$/i.test(column) || ds.fields[column]?.unit === 'usd'
      const change =
        (view.change && names.includes(view.change) ? view.change : undefined) ??
        [`${column}_change_pct`, `${column}_change_percent`].find((c) => names.includes(c)) ??
        (priceLike ? ['change_pct', 'change_percent'].find((c) => c !== column && names.includes(c)) : undefined) ??
        (priceLike ? names.find((c) => c !== column && ds.fields[c]?.format === 'change' && (ds.fields[c]?.unit === 'percent' || ds.fields[c]?.unit === 'fraction') && !/^(pre|post)/i.test(c)) : undefined)
      const c: StatControl = { kind: 'stat', data: name, column, format: defaultFormat(ds.fields[column] ?? {}, typeOf(column)), label: ds.fields[column]?.label ?? column }
      if (ds.shape.group) c.group = ds.shape.group
      if (change) c.change = change
      if (ds.fields[column]?.unit) c.unit = ds.fields[column]!.unit
      return c
    }
    case 'facts': {
      const columns = (view.columns ?? orderByPriority(names, ds.fields)).filter((c) => names.includes(c))
      return { kind: 'facts', data: name, columns, formats: formats(columns), labels: labels(columns) }
    }
    case 'chain':
      return { kind: 'chain', data: name }
    default:
      return { kind: 'chart', panes: expandPreset(view, datasets) }
  }
}
