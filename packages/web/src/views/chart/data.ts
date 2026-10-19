/**
 * Panes and layers → what lightweight-charts draws. Pure: `buildChart(panes, frames, datasets, opts)` turns the
 * preset's `Pane[]` into series specs (one per layer, or per group of a grouped layer), price lines, markers
 * and bands, with the legend rows and the x-axis kind. The renderer (ChartView) only walks the result; it
 * never knows what the data means (PLAN.md section 17, "layers").
 */
import { columnIndex, fieldLabel, type DatasetsFieldConfig, type Frame, type Layer, type Pane, type Scale } from '@openterminal/core'
import { DOWN_COLOR, UP_COLOR, markerStyle, seriesPalette } from '@openterminal/ui'
import type { BusinessDay, Time, UTCTimestamp } from 'lightweight-charts'
import { withAlpha } from '../format'

export type XKind = 'time' | 'months' | 'number'
export type SeriesKind = 'line' | 'area' | 'candle' | 'histogram'
export type AxisSide = 'right' | 'left'
export type PriceFormatKind = NonNullable<Scale['format']> | 'auto'

/** A point on any horizontal scale: chart `Time` for time axes, a number for numeric axes. */
export type HorzItem = Time | number

export type Point = { time: HorzItem; value: number }
export type Candle = { time: HorzItem; open: number; high: number; low: number; close: number }
export type Bar = { time: HorzItem; value: number; color?: string }

export type MarkerSpec = {
  time: HorzItem
  /** Epoch ms (or the numeric x) the marker was placed at, before snapping to a bar. */
  at: number
  kind: string
  letter: string
  color: string
  label: string
  detail: string | null
  position: 'aboveBar' | 'belowBar' | 'inBar'
}
export type PriceLineSpec = { price: number; label: string | undefined; style: 'solid' | 'dashed' | 'dotted'; color: string | undefined }
export type BandSpec =
  | { kind: 'x'; from: HorzItem; to: HorzItem; color: string | undefined; label: string | undefined }
  | { kind: 'y'; lo: number; hi: number; color: string | undefined; label: string | undefined }
  | { kind: 'poly'; lo: Point[]; hi: Point[]; color: string | undefined; label: string | undefined }

export type SeriesSpec = {
  id: string
  pane: number
  kind: SeriesKind
  color: string
  /** Legend label. */
  label: string
  /** The group value (symbol, series) for `data-symbol`; the label otherwise. */
  group: string
  data: Point[] | Candle[] | Bar[]
  side: AxisSide
  format: PriceFormatKind
  /** Decimal places the values need on the axis (sub-dollar prices get four). */
  precision: number
  width: number
  legend: boolean
  lastValue: boolean
  /** Fixed scale bounds (RSI 0..100). */
  range: [number, number] | undefined
  markers: MarkerSpec[]
  priceLines: PriceLineSpec[]
  bands: BandSpec[]
  /** Legend numbers: first and last finite value and the change between them, in the series' own units. */
  first: number | null
  last: number | null
  changePct: number | null
  /** Per-time lookup of the value for the hover legend. */
  byTime: Map<number, number>
}

export type PaneSpec = { index: number; height: number; title: string | undefined; legend: boolean; side: Record<AxisSide, { indexed: boolean; visible: boolean } | undefined> }

export type ChartSpec = {
  x: XKind
  intraday: boolean
  panes: PaneSpec[]
  series: SeriesSpec[]
  /** Marker kinds present, in first-seen order, for the legend chips. */
  markerKinds: { kind: string; letter: string; color: string }[]
  /** Numeric x values in data order, for axis formatting of a yield curve (months → label). */
  xLabels: Map<number, string>
  /** Paired bars on a strike axis are drawn at offsets around each strike; the axis rounds back to this step (change 14). */
  xStep?: number
  /** A strike axis: the underlying's price when a frame carries it (the legend reads a by-strike line at the money). */
  underlying?: number
}

export type BuildOptions = {
  /** Legend label per group (the view's `labels`), applied before the field label. */
  labels?: Record<string, string> | undefined
  /** Label for a group value when the frame has no label column (the macro short names). */
  groupLabel?: ((group: string) => string) | undefined
}

/** Field names whose numeric x is a maturity: drawn on the yield-curve chart with months as the unit. */
const MATURITY_X = /^(maturity_years|years|maturity|tenor)$/i

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Epoch ms from a time cell: a number as is, a date string parsed as UTC. */
export function cellMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v) {
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * Epoch ms → lightweight-charts time. Intraday bars keep the timestamp (seconds); daily and weekly bars become
 * business days (UTC date) so every symbol's bar for one session lands on the same x position and weekends leave no gaps.
 */
export function toChartTime(ms: number, intraday: boolean): Time {
  if (intraday) return Math.floor(ms / 1000) as UTCTimestamp
  const d = new Date(ms)
  const bd: BusinessDay = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
  return bd
}

/** A sortable number for any horizontal item (epoch ms for business days and timestamps, the value for numbers). */
export function horzKey(t: HorzItem): number {
  if (typeof t === 'number') return t
  if (typeof t === 'string') return Date.parse(t)
  return Date.UTC(t.year, t.month - 1, t.day)
}

/** The key `toChartTime(ms, intraday)` lands on, so markers and bands snap to the same positions as bars. */
export function timeKeyOf(ms: number, intraday: boolean): number {
  return horzKey(toChartTime(ms, intraday))
}

/** True when any series has two consecutive points on the same UTC day: the frame is intraday. */
export function detectIntraday(frames: Record<string, Frame>, panes: readonly Pane[]): boolean {
  for (const p of panes) {
    if (p.x !== 'time') continue
    for (const l of p.layers) {
      if (!('data' in l) || !l.data || !('x' in l) || !l.x || l.mark === 'marker' || l.mark === 'band') continue
      const f = frames[l.data]
      if (!f) continue
      const ix = columnIndex(f, l.x)
      const ig = 'group' in l && l.group ? columnIndex(f, l.group) : -1
      if (ix < 0) continue
      const lastDay = new Map<string, number>()
      for (const row of f.rows) {
        const ms = cellMs(row[ix])
        if (ms == null) continue
        const g = ig >= 0 ? String(row[ig] ?? '') : '*'
        const day = Math.floor(ms / 86_400_000)
        const prev = lastDay.get(g)
        if (prev !== undefined && prev === day) return true
        lastDay.set(g, day)
      }
    }
  }
  return false
}

function priceFormatOf(scale: Scale | undefined): PriceFormatKind {
  return scale?.format ?? 'auto'
}

/** `scale: 'left'` (or none) is the pane's primary scale, drawn on the right-hand axis as every terminal does; `scale: 'right'` is the secondary, drawn on the left. */
export function sideOf(layer: { scale?: 'left' | 'right' | undefined }): AxisSide {
  return layer.scale === 'right' ? 'left' : 'right'
}
function scaleOf(pane: Pane, side: AxisSide): Scale | undefined {
  return side === 'right' ? pane.scales?.left : pane.scales?.right
}

function precisionFor(values: number[]): number {
  let max = 0
  for (const v of values) max = Math.max(max, Math.abs(v))
  return max > 0 && max < 1 ? 4 : 2
}

type Rows = { frame: Frame; ix: number; iy: number; ig: number; /** True when the group column was inferred (one symbol, no `group` on the layer). */ inferred: boolean }

/** Columns that name a single symbol's frame when the layer has no group (one symbol never makes a shape group). */
const NAME_COLUMNS = ['symbol', 'series', 'ticker']

function columns(frame: Frame | undefined, x: string, y: string | undefined, group: string | undefined): Rows | null {
  if (!frame) return null
  const ix = columnIndex(frame, x)
  const iy = y ? columnIndex(frame, y) : -1
  if (ix < 0 || (y && iy < 0)) return null
  if (group) return { frame, ix, iy, ig: columnIndex(frame, group), inferred: false }
  const named = NAME_COLUMNS.map((c) => columnIndex(frame, c)).find((i) => i >= 0)
  return { frame, ix, iy, ig: named ?? -1, inferred: named !== undefined }
}

/** The legend label of one series: the group's label when the layer groups, else the layer's own label, else the frame's single name, else the field. */
function labelOf(group: string, r: Rows, layerLabel: string | undefined, fieldLabel: string | undefined, fallback: string, opts: BuildOptions): string {
  const named = group === '*' ? undefined : opts.labels?.[group]?.trim() || opts.groupLabel?.(group) || group
  if (named && !r.inferred) return named
  return layerLabel ?? named ?? fieldLabel ?? fallback
}

/** Split rows by the group column (first-seen order); `*` without one. */
function groupsOf(r: Rows): Map<string, unknown[][]> {
  const out = new Map<string, unknown[][]>()
  for (const row of r.frame.rows) {
    const g = r.ig >= 0 ? String(row[r.ig] ?? '') : '*'
    let list = out.get(g)
    if (!list) out.set(g, (list = []))
    list.push(row)
  }
  return out
}

function xOf(v: unknown, x: XKind, intraday: boolean): HorzItem | null {
  if (x === 'time') {
    const ms = cellMs(v)
    return ms == null ? null : toChartTime(ms, intraday)
  }
  const n = num(v)
  if (n == null) return null
  return x === 'months' ? Math.round(n * 12) : n
}

/** Points of one group, de-duplicated on x (last wins) and sorted ascending; rows with a null value dropped. */
function points(rows: unknown[][], r: Rows, x: XKind, intraday: boolean): Point[] {
  const byKey = new Map<number, Point>()
  for (const row of rows) {
    const t = xOf(row[r.ix], x, intraday)
    const value = num(row[r.iy])
    if (t == null || value == null) continue
    byKey.set(horzKey(t), { time: t, value })
  }
  return [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p)
}

function stats(values: number[]): { first: number | null; last: number | null; changePct: number | null } {
  if (values.length === 0) return { first: null, last: null, changePct: null }
  const first = values[0]!
  const last = values[values.length - 1]!
  return { first, last, changePct: first === 0 ? null : Math.round(((last - first) / first) * 10000) / 100 }
}

/** Nearest x position of a series to `key` (markers and band edges snap to a bar), or null when the series is empty. */
export function nearest(keys: readonly number[], key: number): number | null {
  if (keys.length === 0) return null
  let lo = 0
  let hi = keys.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid]! < key) lo = mid + 1
    else hi = mid
  }
  const a = keys[lo]!
  const b = lo > 0 ? keys[lo - 1]! : a
  return Math.abs(a - key) <= Math.abs(key - b) ? a : b
}

const MONTH_LABEL = (months: number): string => (months < 12 ? `${months}M` : months % 12 === 0 ? `${months / 12}Y` : `${(months / 12).toFixed(1)}Y`)

/** Build the chart spec. `frames` holds the frames that have landed; layers over missing datasets are skipped. */
export function buildChart(panes: readonly Pane[], frames: Record<string, Frame>, datasets: DatasetsFieldConfig, opts: BuildOptions = {}): ChartSpec {
  const xType = panes[0]?.x ?? 'time'
  let x: XKind = 'number'
  if (xType === 'time') x = 'time'
  else {
    const first = panes.flatMap((p) => p.layers).find((l): l is Extract<Layer, { x: string }> => 'x' in l && typeof l.x === 'string' && l.mark !== 'marker' && l.mark !== 'band')
    if (first && MATURITY_X.test(first.x)) x = 'months'
  }
  const intraday = x === 'time' ? detectIntraday(frames, panes) : false
  const series: SeriesSpec[] = []
  const paneSpecs: PaneSpec[] = []
  const markerKinds = new Map<string, { kind: string; letter: string; color: string }>()
  const xLabels = new Map<number, string>()

  panes.forEach((pane, pi) => {
    const indexed = (side: AxisSide) => !!scaleOf(pane, side)?.indexed
    const visible = (side: AxisSide) => scaleOf(pane, side)?.visible !== false
    paneSpecs.push({
      index: pi,
      height: pane.height,
      title: pane.title,
      legend: pane.legend ?? false,
      side: { right: { indexed: indexed('right'), visible: visible('right') }, left: { indexed: indexed('left'), visible: visible('left') } },
    })
    let slot = 0
    const paneSeries: SeriesSpec[] = []
    const deferred: Layer[] = []
    for (const layer of pane.layers) {
      switch (layer.mark) {
        case 'line':
        case 'area':
        case 'bar':
        case 'histogram': {
          const r = columns(frames[layer.data], layer.x, layer.y, layer.group)
          if (!r) break
          const ds = datasets[layer.data]
          const side = sideOf(layer)
          const scale = scaleOf(pane, side)
          const fieldLabel = ds?.fields[layer.y]?.label
          for (const [group, rows] of groupsOf(r)) {
            const pts = points(rows, r, x, intraday)
            if (pts.length === 0) continue
            const values = pts.map((p) => p.value)
            const own = layer.color && !layer.color.includes('.') ? layer.color : undefined
            const color = own ?? seriesPalette[Math.min(slot, seriesPalette.length - 1)] ?? UP_COLOR
            slot++
            const label = labelOf(group, r, layer.label, fieldLabel, layer.y, opts)
            let data: Point[] | Bar[] = pts
            let kind: SeriesKind = layer.mark === 'area' ? 'area' : layer.mark === 'line' ? 'line' : 'histogram'
            if (layer.mark === 'histogram' || layer.mark === 'bar') {
              kind = 'histogram'
              const signed = layer.signed || (layer.mark === 'bar' && values.some((v) => v < 0))
              const colorBy = layer.mark === 'histogram' ? layer.colorBy : undefined
              const ic = colorBy && colorBy !== layer.y ? columnIndex(r.frame, colorBy) : -1
              const io = ic >= 0 ? columnIndex(r.frame, 'open') : -1
              if (signed) data = pts.map((p) => ({ ...p, color: p.value < 0 ? DOWN_COLOR : UP_COLOR }))
              else if (ic >= 0) {
                // Colour by the direction of another column (close vs open for volume), muted so the bars sit under the price.
                const dir = new Map<number, boolean>()
                let prev: number | null = null
                for (const row of rows) {
                  const t = xOf(row[r.ix], x, intraday)
                  const c = num(row[ic])
                  if (t == null || c == null) continue
                  const o = io >= 0 ? num(row[io]) : null
                  dir.set(horzKey(t), o != null ? c >= o : prev == null || c >= prev)
                  prev = c
                }
                data = pts.map((p) => ({ ...p, color: dir.get(horzKey(p.time)) === false ? withAlpha(DOWN_COLOR, 0.45) : withAlpha(UP_COLOR, 0.45) }))
              } else data = pts.map((p) => ({ ...p, color: withAlpha(color, 0.6) }))
            }
            const st = stats(values)
            if (x === 'months') for (const p of pts) xLabels.set(p.time as number, MONTH_LABEL(p.time as number))
            paneSeries.push({
              id: `${pi}:${layer.mark}:${layer.data}:${layer.y}:${group}`,
              pane: pi,
              kind,
              color,
              label,
              group: group === '*' || r.inferred ? label : group,
              data,
              side,
              format: priceFormatOf(scale),
              precision: precisionFor(values),
              width: layer.mark === 'line' && layer.width ? layer.width : 2,
              legend: pane.legend ?? false,
              lastValue: pane.lastValue ?? false,
              range: scale?.min !== undefined && scale?.max !== undefined ? [scale.min, scale.max] : undefined,
              markers: [],
              priceLines: [],
              bands: [],
              ...st,
              byTime: new Map(pts.map((p) => [horzKey(p.time), p.value])),
            })
          }
          break
        }
        case 'candle': {
          const r = columns(frames[layer.data], layer.x, layer.close, layer.group)
          if (!r) break
          const f = r.frame
          const io = columnIndex(f, layer.open)
          const ih = columnIndex(f, layer.high)
          const il = columnIndex(f, layer.low)
          if (io < 0 || ih < 0 || il < 0) break
          const side = sideOf(layer)
          const scale = scaleOf(pane, side)
          // Candles need one symbol: the first group only.
          const [group, rows] = [...groupsOf(r).entries()][0] ?? ['*', []]
          const byKey = new Map<number, Candle>()
          for (const row of rows) {
            const t = xOf(row[r.ix], x, intraday)
            const close = num(row[r.iy])
            if (t == null || close == null) continue
            const open = num(row[io]) ?? close
            const high = num(row[ih]) ?? Math.max(open, close)
            const low = num(row[il]) ?? Math.min(open, close)
            byKey.set(horzKey(t), { time: t, open, high, low, close })
          }
          const data = [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
          if (data.length === 0) break
          const closes = data.map((c) => c.close)
          const label = labelOf(group, r, undefined, undefined, layer.close, opts)
          paneSeries.push({
            id: `${pi}:candle:${layer.data}:${group}`,
            pane: pi,
            kind: 'candle',
            color: UP_COLOR,
            label,
            group: group === '*' ? label : group,
            data,
            side,
            format: priceFormatOf(scale),
            precision: precisionFor(closes),
            width: 2,
            legend: pane.legend ?? false,
            lastValue: pane.lastValue ?? false,
            range: undefined,
            markers: [],
            priceLines: [],
            bands: [],
            ...stats(closes),
            byTime: new Map(data.map((c) => [horzKey(c.time), c.close])),
          })
          slot++
          break
        }
        case 'marker':
        case 'level':
        case 'band':
          deferred.push(layer)
          break
        case 'cell':
        case 'profile':
          break
      }
    }
    // Markers, levels and bands attach to the pane's first series on their scale.
    const host = (side: AxisSide) => paneSeries.find((s) => s.side === side) ?? paneSeries[0]
    for (const layer of deferred) {
      if (layer.mark === 'level') {
        const h = host(sideOf(layer))
        if (!h) continue
        const style = layer.style ?? 'dashed'
        if (layer.value !== undefined) h.priceLines.push({ price: layer.value, label: layer.label, style, color: layer.color })
        else if (layer.data && layer.y) {
          const f = frames[layer.data]
          const iy = f ? columnIndex(f, layer.y) : -1
          if (!f || iy < 0) continue
          const ds = datasets[layer.data]
          const labelCol = ds?.shape.group ?? ds?.shape.columns.find((c) => c.type === 'string')?.name
          const il = labelCol ? columnIndex(f, labelCol) : -1
          const seen = new Set<number>()
          for (const row of f.rows) {
            const v = num(row[iy])
            if (v == null || seen.has(v)) continue
            seen.add(v)
            const text = il >= 0 && row[il] != null ? String(row[il]) : layer.label
            h.priceLines.push({ price: v, label: text, style, color: layer.color })
          }
        }
      } else if (layer.mark === 'marker') {
        const h = host(sideOf(layer))
        const f = frames[layer.data]
        if (!h || !f) continue
        const ix = columnIndex(f, layer.x)
        if (ix < 0) continue
        const il = layer.label ? columnIndex(f, layer.label) : -1
        const ik = layer.kind ? columnIndex(f, layer.kind) : -1
        const idt = layer.detail ? columnIndex(f, layer.detail) : -1
        const detailFormat = layer.detail ? datasets[layer.data]?.fields[layer.detail]?.format : undefined
        const keys = [...h.byTime.keys()]
        // The kind when the frame has no kind column: the dataset's recipe or route tail (news → N, earnings → E,
        // insiders → I), then the dataset name, so an `events` dataset of news is not a column of E's.
        const lineage = f.meta.lineage
        const fallbackKind = lineage?.recipe ?? lineage?.route?.split('/').pop() ?? layer.data ?? 'custom'
        const added: typeof h.markers = []
        for (const row of f.rows) {
          const ms = x === 'time' ? cellMs(row[ix]) : num(row[ix])
          if (ms == null) continue
          const want = x === 'time' ? timeKeyOf(ms, intraday) : x === 'months' ? Math.round(ms * 12) : ms
          const key = nearest(keys, want)
          if (key == null) continue
          // Only markers inside the drawn range; farther than a week from any bar means the event is off the chart.
          if (x === 'time' && Math.abs(key - want) > 7 * 86_400_000) continue
          const kindValue = ik >= 0 && row[ik] != null ? String(row[ik]) : fallbackKind
          const kindKey = kindValue.toLowerCase()
          const style = markerStyle(kindKey)
          const detailRaw = idt >= 0 ? row[idt] : null
          const detail = detailRaw == null ? null : typeof detailRaw === 'number' && (detailFormat === 'change' || detailFormat === 'percent' || /pct|percent/.test(layer.detail ?? '')) ? `${detailRaw > 0 ? '+' : ''}${detailRaw.toFixed(2)}%` : String(detailRaw)
          const time: HorzItem = x === 'time' ? toChartTime(key, intraday) : key
          const position = layer.position === 'below' ? 'belowBar' : layer.position === 'inline' ? 'inBar' : 'aboveBar'
          added.push({ time, at: ms, kind: kindKey, letter: style.letter, color: style.color, label: il >= 0 && row[il] != null ? String(row[il]) : kindValue, detail, position })
          if (!markerKinds.has(kindKey)) markerKinds.set(kindKey, { kind: kindKey, letter: style.letter, color: style.color })
        }
        // Several events of one kind on one bar (a day of headlines) are one marker whose detail counts the rest; the
        // tooltip lists them. Otherwise lightweight-charts stacks a column of letters over the bar.
        const merged = new Map<string, (typeof added)[number] & { more: string[] }>()
        for (const m of added) {
          const id = `${horzKey(m.time)}|${m.kind}|${m.position}`
          const prev = merged.get(id)
          if (!prev) merged.set(id, { ...m, more: [] })
          else prev.more.push(m.label)
        }
        for (const m of merged.values()) {
          const { more, ...rest } = m
          h.markers.push(more.length === 0 ? rest : { ...rest, detail: rest.detail ? `${rest.detail} · +${more.length} more` : `+${more.length} more`, label: rest.label })
        }
        h.markers.sort((a, b) => horzKey(a.time) - horzKey(b.time))
      } else if (layer.mark === 'band') {
        const h = host('right')
        if (!h) continue
        if (layer.from !== undefined && layer.to !== undefined) {
          let from: HorzItem = x === 'time' ? toChartTime(layer.from, intraday) : layer.from
          let to: HorzItem = x === 'time' ? toChartTime(layer.to, intraday) : layer.to
          // Snap to the first and last bars inside the range, so "last week" ends on Friday's bar rather than running
          // off the plot when the range's end is a weekend (change 14).
          const inside = (h.data as { time: HorzItem }[]).map((d) => d.time).filter((t) => horzKey(t) >= horzKey(from) && horzKey(t) <= horzKey(to))
          if (inside.length > 0) {
            from = inside[0]!
            to = inside[inside.length - 1]!
          }
          h.bands.push({ kind: 'x', from, to, color: layer.color, label: layer.label })
        } else if (layer.when && layer.data) {
          const f = frames[layer.data]
          const ix = f && layer.x ? columnIndex(f, layer.x) : -1
          const iw = f ? columnIndex(f, layer.when) : -1
          if (!f || ix < 0 || iw < 0) continue
          // Contiguous runs where the condition holds, in x order.
          const rows = f.rows.map((row) => ({ ms: x === 'time' ? cellMs(row[ix]) : num(row[ix]), on: !!row[iw] && row[iw] !== 'false' && row[iw] !== 0 })).filter((r): r is { ms: number; on: boolean } => r.ms != null).sort((a, b) => a.ms - b.ms)
          let start: number | null = null
          let last: number | null = null
          const flush = () => {
            if (start == null || last == null) return
            const from: HorzItem = x === 'time' ? toChartTime(start, intraday) : start
            const to: HorzItem = x === 'time' ? toChartTime(last, intraday) : last
            h.bands.push({ kind: 'x', from, to, color: layer.color, label: layer.label })
            start = last = null
          }
          for (const r of rows) {
            if (r.on) {
              if (start == null) start = r.ms
              last = r.ms
            } else flush()
          }
          flush()
        } else if (layer.lo !== undefined && layer.hi !== undefined) {
          if (typeof layer.lo === 'number' && typeof layer.hi === 'number') h.bands.push({ kind: 'y', lo: layer.lo, hi: layer.hi, color: layer.color, label: layer.label })
          else if (layer.data && layer.x) {
            const lo = typeof layer.lo === 'string' ? columns(frames[layer.data], layer.x, layer.lo, undefined) : null
            const hi = typeof layer.hi === 'string' ? columns(frames[layer.data], layer.x, layer.hi, undefined) : null
            if (lo && hi) h.bands.push({ kind: 'poly', lo: points(lo.frame.rows, lo, x, intraday), hi: points(hi.frame.rows, hi, x, intraday), color: layer.color, label: layer.label })
          }
        }
      }
    }
    series.push(...paneSeries)
  })

  // Paired bars on a strike axis (change 14): two or more bar series over the same strikes are drawn side by side,
  // each offset around its strike, with an empty slot after each pair so the pairs read as groups.
  let xStep: number | undefined
  const paired = x === 'number' ? series.filter((s) => s.pane === 0 && s.kind === 'histogram') : []
  if (paired.length >= 2) {
    const xs = [...new Set(paired.flatMap((s) => (s.data as { time: HorzItem }[]).map((d) => d.time as number)))].sort((a, b) => a - b)
    const step = xs.slice(1).reduce((m, v, i) => Math.min(m, v - xs[i]!), Infinity)
    if (Number.isFinite(step) && step > 0) {
      xStep = step
      const n = paired.length
      const d = step / (n + 2)
      paired.forEach((s, i) => {
        const shift = (i - (n - 1) / 2) * d
        const data = (s.data as Bar[]).map((b) => ({ ...b, time: ((b.time as number) + shift) as HorzItem }))
        s.data = data
        s.byTime = new Map(data.map((b) => [horzKey(b.time), b.value]))
      })
      // The gap slot after each strike (whitespace on the last series) and, on it, the underlying's rule.
      const last = paired[n - 1]!
      const gap = ((n - 1) / 2 + 1) * d
      last.data = [...(last.data as Bar[]), ...xs.map((v) => ({ time: (v + gap) as HorzItem }) as unknown as Bar)].sort((a, b) => (a.time as number) - (b.time as number))
      const frame = Object.values(frames).find((f) => f && UNDERLYING.some((c) => columnIndex(f, c) >= 0))
      if (frame) {
        const iu = UNDERLYING.map((c) => columnIndex(frame, c)).find((i) => i >= 0)!
        const u = frame.rows.map((r) => num(r[iu])).find((v): v is number => v != null)
        const below = u == null ? undefined : [...xs].reverse().find((v) => v <= u)
        if (below != null) paired[0]!.bands.push({ kind: 'x', from: (below + gap) as HorzItem, to: (below + gap) as HorzItem, color: undefined, label: 'Underlying' })
      }
    }
  }

  // A strike axis (change 14): the underlying as a 1px vertical rule at the nearest strike, when the frame carries it.
  if (x === 'number' && xStep === undefined) {
    const host = series.find((s) => s.pane === 0)
    const frame = Object.values(frames).find((f) => f && UNDERLYING.some((c) => columnIndex(f, c) >= 0))
    if (host && frame) {
      const iu = UNDERLYING.map((c) => columnIndex(frame, c)).find((i) => i >= 0)!
      const u = frame.rows.map((r) => num(r[iu])).find((v): v is number => v != null)
      const xs = (host.data as { time: HorzItem }[]).map((d) => d.time as number)
      if (u != null && xs.length > 0) {
        const nearest = xs.reduce((a, b) => (Math.abs(b - u) < Math.abs(a - u) ? b : a))
        host.bands.push({ kind: 'x', from: nearest, to: nearest, color: undefined, label: 'Underlying' })
      }
    }
  }

  let underlying: number | undefined
  if (x === 'number') {
    const frame = Object.values(frames).find((f) => f && UNDERLYING.some((c) => columnIndex(f, c) >= 0))
    if (frame) {
      const iu = UNDERLYING.map((c) => columnIndex(frame, c)).find((i) => i >= 0)!
      underlying = frame.rows.map((r) => num(r[iu])).find((v): v is number => v != null)
    }
  }
  return { x, intraday, panes: paneSpecs, series, markerKinds: [...markerKinds.values()], xLabels, ...(xStep ? { xStep } : {}), ...(underlying !== undefined ? { underlying } : {}) }
}

const UNDERLYING = ['underlying_price', 'underlyingPrice', 'underlying']

/** Legend text for a series: last value and change in the series' own format (percent units move in basis points). */
export function legendValues(s: SeriesSpec, unitPercent: boolean, hover?: number | null): { last: string; change: string; changeValue: number | null } {
  const last = hover ?? s.last
  if (last == null) return { last: '–', change: '–', changeValue: null }
  if (unitPercent) {
    const bp = s.first != null ? Math.round((last - s.first) * 100) : null
    return { last: `${last.toFixed(2)}%`, change: bp == null ? '–' : `${bp > 0 ? '+' : ''}${bp} bp`, changeValue: bp }
  }
  const pct = s.first != null && s.first !== 0 ? Math.round(((last - s.first) / s.first) * 10000) / 100 : null
  return { last: formatValue(last, s.format, s.precision), change: pct == null ? '–' : `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(2)}%`, changeValue: pct }
}

const grouped = (digits: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** One value in a scale format, for legends and tooltips. */
export function formatValue(v: number, format: PriceFormatKind, precision = 2): string {
  switch (format) {
    case 'percent':
      return `${v.toFixed(2)}%`
    case 'compact': {
      const abs = Math.abs(v)
      const sign = v < 0 ? '-' : ''
      if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`
      if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`
      // Below a million a level reads in full (change 13): an index at 7,659.44, never "7.7K"; 95,394 shares as written.
      return grouped(Number.isInteger(v) ? 0 : Math.min(precision, 2)).format(v)
    }
    case 'integer':
      return grouped(0).format(v)
    case 'ratio':
      return `${v.toFixed(1)}x`
    case 'price':
    case 'auto':
    default:
      return grouped(precision).format(v)
  }
}

/** Display names for marker kinds in the legend chip and the tooltip (change 11): a recipe id never shows as typed. */
const MARKER_KIND_LABELS: Record<string, string> = {
  earnings: 'Earnings',
  eps_history: 'Earnings',
  news: 'News',
  dividend: 'Dividends',
  dividends: 'Dividends',
  insider: 'Insiders',
  insiders: 'Insiders',
  macro: 'Macro',
  calendar: 'Releases',
  events: 'Events',
  split: 'Splits',
  buy: 'Buy',
  sell: 'Sell',
  custom: 'Events',
}
export function markerKindLabel(kind: string): string {
  return MARKER_KIND_LABELS[kind.toLowerCase()] ?? fieldLabel(kind)
}
