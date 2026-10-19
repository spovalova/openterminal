import type { AnyWidget, Frame } from '@terminal/core'

/**
 * Props every view receives: the widget (v1 `{ query, view }` or v2 `{ data, view: { preset } }`) and one frame
 * per dataset that has landed. A v1 widget's frame arrives as `{ main }`.
 */
export type ViewProps = { widget: AnyWidget; frames: Record<string, Frame> }
