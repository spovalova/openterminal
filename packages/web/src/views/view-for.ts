import type { FC } from 'react'
import type { View } from '@terminal/core'
import type { ViewProps } from './types'
import { SeriesView } from './SeriesView'
import { TableView } from './TableView'

/** The component that renders a widget's view. */
export function viewFor(view: View): FC<ViewProps> {
  return view.type === 'series' ? SeriesView : TableView
}
