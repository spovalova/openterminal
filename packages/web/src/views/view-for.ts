import type { FC } from 'react'
import type { View } from '@terminal/core'
import type { ViewProps } from './types'
import { ChainView } from './ChainView'
import { SeriesView } from './SeriesView'
import { TableView } from './TableView'

/** The component that renders a widget's view. */
export function viewFor(view: View): FC<ViewProps> {
  switch (view.type) {
    case 'series':
      return SeriesView
    case 'chain':
      return ChainView
    default:
      return TableView
  }
}
