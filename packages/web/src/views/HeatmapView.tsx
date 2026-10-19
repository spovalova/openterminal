import { useMemo, type FC } from 'react'
import clsx from 'clsx'
import { WIDE_COLUMNS, WIDE_VALUE, columnIndex, type Frame, type Layer } from '@terminal/core'
import { EmptyState, divergingColor, divergingScale, sequentialColor, sequentialScale } from '@terminal/ui'
import type { ViewProps } from './types'
import { datasetsFor, expandView, primaryFrame } from './fields'
import { formatValue } from './chart/data'
import { displayName } from './series-data'

type CellLayer = Extract<Layer, { mark: 'cell' }>

export type HeatmapCell = { x: string; y: string; value: number | null }
export type Heatmap = {
  xs: string[]
  ys: string[]
  cells: Map<string, number | null>
  min: number
  max: number
  /** Symmetric bound for the diverging scale: the layer's domain or the largest magnitude. */
  bound: number
  palette: 'diverging' | 'sequential'
  format: 'percent' | 'price' | 'auto'
  text: boolean
}

const key = (x: string, y: string) => `${x}\u0000${y}`

/**
 * Melt a frame for a `cell` layer. Wide form (`y: $columns`, `value: $value`): one row per x (the group column),
 * one y per numeric column. Long form: x, y and value columns, the last value wins for a repeated pair.
 */
export function buildHeatmap(frame: Frame, layer: CellLayer, format: Heatmap['format'] = 'auto'): Heatmap {
  const xs: string[] = []
  const ys: string[] = []
  const cells = new Map<string, number | null>()
  const seenX = new Set<string>()
  const seenY = new Set<string>()
  const addX = (x: string) => {
    if (!seenX.has(x)) {
      seenX.add(x)
      xs.push(x)
    }
  }
  const addY = (y: string) => {
    if (!seenY.has(y)) {
      seenY.add(y)
      ys.push(y)
    }
  }
  if (layer.y === WIDE_COLUMNS || layer.value === WIDE_VALUE) {
    const ix = columnIndex(frame, layer.x)
    const numeric = frame.columns.map((c, i) => ({ c, i })).filter(({ c, i }) => c.type === 'number' && i !== ix)
    frame.rows.forEach((row, ri) => {
      const x = ix >= 0 ? String(row[ix] ?? '') : String(ri + 1)
      addX(x)
      for (const { c, i } of numeric) {
        addY(c.name)
        const v = row[i]
        cells.set(key(x, c.name), typeof v === 'number' && Number.isFinite(v) ? v : null)
      }
    })
  } else {
    const ix = columnIndex(frame, layer.x)
    const iy = columnIndex(frame, layer.y)
    const iv = columnIndex(frame, layer.value)
    if (ix >= 0 && iy >= 0 && iv >= 0) {
      for (const row of frame.rows) {
        const x = String(row[ix] ?? '')
        const y = String(row[iy] ?? '')
        addX(x)
        addY(y)
        const v = row[iv]
        cells.set(key(x, y), typeof v === 'number' && Number.isFinite(v) ? v : null)
      }
    }
  }
  let min = Infinity
  let max = -Infinity
  for (const v of cells.values()) {
    if (v == null) continue
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  if (!Number.isFinite(min)) min = max = 0
  const palette = layer.palette ?? 'diverging'
  const bound = layer.domain ? Math.max(Math.abs(layer.domain[0]), Math.abs(layer.domain[1])) : Math.max(Math.abs(min), Math.abs(max)) || 1
  return { xs, ys, cells, min, max, bound, palette, format, text: layer.text ?? true }
}

/** Cell colour on the chosen scale. */
export function cellColor(h: Heatmap, v: number | null): string | undefined {
  if (v == null) return undefined
  if (h.palette === 'sequential') return sequentialColor(h.max === h.min ? 1 : (v - h.min) / (h.max - h.min))
  return divergingColor(v / h.bound)
}

export function cellText(h: Heatmap, v: number | null): string {
  if (v == null) return '—'
  if (h.format === 'percent') return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
  if (Math.abs(v) <= 1 && h.format === 'auto') return v.toFixed(2)
  return formatValue(v, h.format === 'price' ? 'price' : 'auto', Math.abs(v) < 10 ? 2 : 1)
}

/**
 * `heatmap` preset: a matrix frame (correlations, sector × week returns, holdings by weight) as a coloured grid
 * from a `cell` layer, with a diverging (red, neutral, blue) or sequential scale and a legend bar under it.
 * Wide frames are melted (one y per numeric column); the value is shown in each cell, so the sign and
 * magnitude never ride on colour alone.
 */
export const HeatmapView: FC<ViewProps> = ({ widget, frames }) => {
  const panes = useMemo(() => expandView(widget, frames), [widget, frames])
  const layer = panes[0]?.layers.find((l): l is CellLayer => l.mark === 'cell')
  const frame = layer ? frames[layer.data] : primaryFrame(widget, frames)
  const heat = useMemo(() => {
    if (!frame || !layer) return undefined
    const ds = datasetsFor(widget, frames)[layer.data]
    const unit = layer.value !== WIDE_VALUE ? ds?.fields[layer.value]?.unit : [...Object.values(ds?.fields ?? {})].find((f) => f.unit === 'percent') ? 'percent' : undefined
    const format: Heatmap['format'] = unit === 'percent' || unit === 'fraction' ? 'percent' : unit === 'usd' ? 'price' : 'auto'
    return buildHeatmap(frame, layer, format)
  }, [frame, layer, widget, frames])

  if (!frame || frame.rows.length === 0) return <EmptyState title="No data" hint="The query returned no rows." />
  if (!heat || heat.xs.length === 0 || heat.ys.length === 0) return <EmptyState title="Nothing to colour" hint="The frame has no group column with numeric columns beside it." />

  const dense = heat.ys.length > 8 || heat.xs.length > 12
  const gradient = heat.palette === 'sequential' ? `linear-gradient(90deg, ${sequentialScale.low}, ${sequentialScale.high})` : `linear-gradient(90deg, ${divergingScale.negative}, ${divergingScale.neutral}, ${divergingScale.positive})`
  const lo = heat.palette === 'sequential' ? heat.min : -heat.bound
  const hi = heat.palette === 'sequential' ? heat.max : heat.bound

  return (
    <div data-view="heatmap" data-palette={heat.palette} data-x={heat.xs.length} data-y={heat.ys.length} className="flex h-full w-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
        {/* `h-full`: a 7x7 matrix shares the cell's height between its rows instead of sitting in the top third (section 17 fill rule). */}
        <table className="h-full w-full table-fixed border-separate border-spacing-px text-xs">
          <thead>
            <tr>
              <th className="w-[72px]" />
              {heat.ys.map((y) => (
                <th key={y} scope="col" className={clsx('h-6 truncate px-1 text-center font-medium text-fg-3', dense && 'text-[10px]')} title={y}>
                  {displayName(y)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heat.xs.map((x) => (
              <tr key={x}>
                <th scope="row" className="num h-7 truncate pr-2 text-right font-medium text-fg-2" title={x}>
                  {displayName(x)}
                </th>
                {heat.ys.map((y) => {
                  const v = heat.cells.get(key(x, y)) ?? null
                  const bg = cellColor(heat, v)
                  return (
                    <td
                      key={y}
                      data-cell={`${x}:${y}`}
                      data-value={v ?? undefined}
                      title={`${x} · ${y} · ${cellText(heat, v)}`}
                      className={clsx('num h-7 truncate rounded-xs px-1 text-center', dense && 'text-[10px]', v == null ? 'text-fg-3' : 'text-fg')}
                      style={bg ? { background: bg } : undefined}
                    >
                      {heat.text ? cellText(heat, v) : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div data-legend="" className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-[11px] leading-4 text-fg-3">
        <span className="num">{cellText(heat, lo)}</span>
        <span aria-hidden="true" className="h-2 min-w-0 flex-1 rounded-xs" style={{ background: gradient, maxWidth: 220 }} />
        <span className="num">{cellText(heat, hi)}</span>
        <span className="ml-auto truncate">{heat.palette === 'diverging' ? 'red negative · blue positive' : 'light low · dark high'}</span>
      </div>
    </div>
  )
}
