import type { FC } from 'react'
import type { AnyWidget, PresetName, ViewV2 } from '@openterminal/core'
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

/**
 * The component that renders a widget's view, by preset (a widget or a bare `ViewV2`). A `table` renders the facts
 * card itself when its frame has one row (product rule 8), so that decision needs the frame and lives in TableView.
 */
export function viewFor(target: AnyWidget | ViewV2): FC<ViewProps> {
  if ('preset' in target) return BY_PRESET[target.preset]
  return BY_PRESET[viewOf(target).preset]
}
