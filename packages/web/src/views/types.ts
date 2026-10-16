import type { Frame, Widget } from '@terminal/core'

/** Props every view receives: the widget (query + view options) and the frame its query produced. */
export type ViewProps = { widget: Widget; frame: Frame }
