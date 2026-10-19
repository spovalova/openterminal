/**
 * Shaded ranges on a lightweight-charts series (the `band` mark): an x range (an earnings window, the stretch
 * where a spread is negative), a y range between two constants, or the area between two curves (Bollinger
 * bands). Drawn on the bottom layer so lines stay on top. Attached with `series.attachPrimitive`.
 */
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitivePaneViewZOrder, SeriesAttachedParameter, SeriesType } from 'lightweight-charts'
import { bandColor } from '@terminal/ui'
import type { BandSpec, HorzItem, Point } from './data'

type Attached = SeriesAttachedParameter<HorzItem, SeriesType>

export class BandPrimitive implements ISeriesPrimitive<HorzItem> {
  private param: Attached | undefined
  private readonly views: readonly IPrimitivePaneView[]

  constructor(private readonly bands: readonly BandSpec[]) {
    this.views = [new BandPaneView(this)]
  }

  attached(param: Attached): void {
    this.param = param
  }
  detached(): void {
    this.param = undefined
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this.views
  }
  updateAllViews(): void {}

  /** Rectangles and polygons in media pixels for the current viewport; null entries are off-screen. */
  shapes(): Shape[] {
    const p = this.param
    if (!p) return []
    const ts = p.chart.timeScale()
    const x = (t: HorzItem) => ts.timeToCoordinate(t)
    const y = (v: number) => p.series.priceToCoordinate(v)
    const width = ts.width()
    const height = p.chart.paneSize(paneIndexOf(p)).height
    const out: Shape[] = []
    for (const b of this.bands) {
      const color = b.color ?? bandColor
      if (b.kind === 'x') {
        const x1 = x(b.from)
        const x2 = x(b.to)
        if (x1 == null && x2 == null) continue
        const left = Math.min(x1 ?? 0, x2 ?? width)
        const right = Math.max(x1 ?? 0, x2 ?? width)
        out.push({ kind: 'rect', x: left, y: 0, w: Math.max(2, right - left), h: height, color })
      } else if (b.kind === 'y') {
        const y1 = y(b.lo)
        const y2 = y(b.hi)
        if (y1 == null || y2 == null) continue
        out.push({ kind: 'rect', x: 0, y: Math.min(y1, y2), w: width, h: Math.max(1, Math.abs(y1 - y2)), color })
      } else {
        const top = toPath(b.hi, x, y)
        const bottom = toPath(b.lo, x, y).reverse()
        if (top.length < 2 || bottom.length < 2) continue
        out.push({ kind: 'poly', points: [...top, ...bottom], color })
      }
    }
    return out
  }
}

function paneIndexOf(p: Attached): number {
  const panes = p.chart.panes()
  const i = panes.findIndex((pane) => pane.getSeries().includes(p.series))
  return i < 0 ? 0 : i
}

function toPath(points: Point[], x: (t: HorzItem) => number | null, y: (v: number) => number | null): [number, number][] {
  const out: [number, number][] = []
  for (const pt of points) {
    const px = x(pt.time)
    const py = y(pt.value)
    if (px == null || py == null) continue
    out.push([px, py])
  }
  return out
}

type Shape = { kind: 'rect'; x: number; y: number; w: number; h: number; color: string } | { kind: 'poly'; points: [number, number][]; color: string }

class BandPaneView implements IPrimitivePaneView {
  constructor(private readonly owner: BandPrimitive) {}
  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom'
  }
  renderer(): IPrimitivePaneRenderer | null {
    const shapes = this.owner.shapes()
    if (shapes.length === 0) return null
    return {
      draw: (target) => {
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          for (const s of shapes) {
            ctx.fillStyle = s.color
            if (s.kind === 'rect') {
              ctx.fillRect(Math.round(s.x * hr), Math.round(s.y * vr), Math.round(s.w * hr), Math.round(s.h * vr))
            } else {
              ctx.beginPath()
              s.points.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px * hr, py * vr) : ctx.lineTo(px * hr, py * vr)))
              ctx.closePath()
              ctx.fill()
            }
          }
        })
      },
    }
  }
}
