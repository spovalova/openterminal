import type { FC } from 'react'
import clsx from 'clsx'
import { WidgetFrame, sizeClass } from '@terminal/ui'
import { subtitleFor } from '../subtitle'
import { FETCHED_AT, FIXTURES, type Fixture } from './fixtures'
import { viewFor } from './view-for'

/**
 * Every fixture rendered through `viewFor`, on the app's own widget grid (three columns, 280px rows,
 * spans by size) so each view is seen at the size it gets in a workspace. Served at `/#gallery` by the
 * web dev server; `?only=a,b` keeps the fixtures whose id or kind matches.
 */
export const ViewsGallery: FC<{ fixtures?: Fixture[] }> = ({ fixtures = FIXTURES }) => {
  const only = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('only') : null
  const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null
  const shown = wanted ? fixtures.filter((f) => wanted.has(f.id) || wanted.has(f.widget.query.kind)) : fixtures
  return (
    <div data-views-gallery="" className="widget-grid p-2">
      {shown.map((f) => {
        const View = viewFor(f.widget.view)
        return (
          <div key={f.id} data-fixture={f.id} className={clsx(sizeClass[f.widget.size], 'flex min-h-0 min-w-0 flex-col gap-1')}>
            <div className="truncate text-[11px] text-fg-3" title={f.note}>
              {f.id} · {f.note}
            </div>
            <WidgetFrame
              title={f.widget.title}
              subtitle={subtitleFor(f.widget, f.frame, FETCHED_AT + 30 * 60_000)}
              size={f.widget.size}
              empty={f.frame.rows.length === 0}
              onEdit={() => {}}
              onRefresh={() => {}}
              onExpand={() => {}}
              className="min-h-0 flex-1"
            >
              <View widget={f.widget} frame={f.frame} />
            </WidgetFrame>
          </div>
        )
      })}
    </div>
  )
}
