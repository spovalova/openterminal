import type { FC } from 'react'
import clsx from 'clsx'
import { WidgetFrame, sizeClass } from '@terminal/ui'
import { isWidgetV2 } from '@terminal/core'
import { subtitleForWidget } from '../subtitle'
import { FETCHED_AT, FIXTURES, type Fixture } from './fixtures'
import { viewFor } from './view-for'
import { viewOf } from './fields'

/**
 * Every fixture rendered through `viewFor`, on the app's own widget grid (three columns, 280px rows,
 * spans by size) so each view is seen at the size it gets in a workspace. Served at `/#gallery` by the
 * web dev server; `?only=a,b` keeps the fixtures whose id, kind or preset matches.
 */
export const ViewsGallery: FC<{ fixtures?: Fixture[] }> = ({ fixtures = FIXTURES }) => {
  const only = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('only') : null
  const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null
  const shown = wanted ? fixtures.filter((f) => wanted.has(f.id) || (f.widget.query && wanted.has(f.widget.query.kind)) || wanted.has(viewOf(f.widget).preset)) : fixtures
  return (
    <div data-views-gallery="" className="widget-grid p-2">
      {shown.map((f) => {
        const View = viewFor(f.widget)
        const primary = f.frames.main ?? Object.values(f.frames)[0]
        return (
          <div key={f.id} data-fixture={f.id} data-preset={viewOf(f.widget).preset} className={clsx(sizeClass[f.widget.size], 'flex min-h-0 min-w-0 flex-col gap-1')}>
            <div className="truncate text-[11px] text-fg-3" title={f.note}>
              {f.id} · {f.note}
            </div>
            <WidgetFrame
              title={f.widget.title}
              subtitle={subtitleForWidget(f.widget, f.frames, FETCHED_AT + 30 * 60_000)}
              size={f.widget.size}
              empty={!primary || primary.rows.length === 0}
              onEdit={() => {}}
              onRefresh={() => {}}
              onExpand={() => {}}
              className="min-h-0 flex-1"
              meta={isWidgetV2(f.widget) ? <span className="num text-fg-3">v2</span> : undefined}
            >
              <View widget={f.widget} frames={f.frames} />
            </WidgetFrame>
          </div>
        )
      })}
    </div>
  )
}
