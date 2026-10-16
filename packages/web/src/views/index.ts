// Stub seam. Replaced by the views workstream (PLAN.md section 11). Keep the exported names.
import type { FC } from 'react'
import type { Frame, View, Widget } from '@terminal/core'

export type ViewProps = { widget: Widget; frame: Frame }

export const SeriesView: FC<ViewProps> = () => null
export const TableView: FC<ViewProps> = () => null

export function viewFor(view: View): FC<ViewProps> {
  return view.type === 'series' ? SeriesView : TableView
}
