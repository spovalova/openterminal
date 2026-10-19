import type { FC } from 'react'
import type { AnyWidget, PresetName, View, ViewV2 } from '@terminal/core'
import type { ViewProps } from './types'
import { ChainView } from './ChainView'
import { ChartView } from './ChartView'
import { FactsCard } from './FactsCard'
import { HeatmapView } from './HeatmapView'
import { StatView } from './StatView'
import { TableView } from './TableView'
import { viewOf } from './fields'

export { expandView } from './fields'

const BY_PRESET: Record<PresetName, FC<ViewProps>> = {
  price: ChartView,
  compare: ChartView,
  curve: ChartView,
  indicator: ChartView,
  heatmap: HeatmapView,
  table: TableView,
  facts: FactsCard,
  stat: StatView,
  chain: ChainView,
}

const BY_V1: Record<View['type'], FC<ViewProps>> = { series: ChartView, table: TableView, chain: ChainView, stat: StatView }

/**
 * The component that renders a widget's view: by preset for a v2 widget (or a bare `ViewV2`), by the migrated
 * preset for a v1 widget, by type for a bare v1 `View`. A `table` renders the facts card itself when its frame
 * has one row (product rule 8), so that decision needs the frame and lives in TableView.
 */
export function viewFor(target: AnyWidget | View | ViewV2): FC<ViewProps> {
  if ('preset' in target) return BY_PRESET[target.preset]
  if ('type' in target && !('view' in target)) return BY_V1[target.type]
  return BY_PRESET[viewOf(target as AnyWidget).preset]
}
