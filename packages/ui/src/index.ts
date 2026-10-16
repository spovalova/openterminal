// @terminal/ui: design system for the terminal web app. See docs/notes/phase1-contracts.md ("ui → web, views").

export { Button, type ButtonProps } from './components/Button.js'
export { IconButton, type IconButtonProps } from './components/IconButton.js'
export { Kbd } from './components/Kbd.js'
export { Chip, type ChipProps } from './components/Chip.js'
export { Tabs, type TabsProps } from './components/Tabs.js'
export { PromptBox, type PromptBoxProps } from './components/PromptBox.js'
export { WidgetFrame, sizeClass, type WidgetFrameProps } from './components/WidgetFrame.js'
export { DataTable, type DataTableProps } from './components/DataTable.js'
export { Steps, type StepsProps } from './components/Steps.js'
export { Skeleton } from './components/Skeleton.js'
export { Spinner } from './components/Spinner.js'
export { EmptyState } from './components/EmptyState.js'
export { Dialog, type DialogProps } from './components/Dialog.js'
export * as Icons from './components/icons.js'

export {
  formatCell,
  formatPercent,
  formatTime,
  formatDuration,
  inferFormats,
  isNumericFormat,
  direction,
  linkLabel,
  sortRows,
  EMPTY_CELL,
  type CellFormat,
  type SortDir,
} from './format.js'

export { tokens, seriesPalette, seriesColor, UP_COLOR, DOWN_COLOR, type Tokens } from './tokens.js'
export { chartTheme, lineSeriesDefaults, candleSeriesDefaults } from './chart-theme.js'
