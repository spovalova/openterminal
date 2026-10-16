import type { FC } from 'react'
import { WidgetFrame } from '@terminal/ui'
import { FIXTURES, type Fixture } from './fixtures'
import { viewFor } from './view-for'

/**
 * Every fixture rendered through `viewFor`, for a dev route in Phase 2.
 * Each card is a WidgetFrame with the fixture's view filling a fixed-height body.
 */
export const ViewsGallery: FC<{ fixtures?: Fixture[] }> = ({ fixtures = FIXTURES }) => (
  <div data-views-gallery="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16, padding: 16 }}>
    {fixtures.map((f) => {
      const View = viewFor(f.widget.view)
      return (
        <section key={f.id} data-fixture={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            {f.id} · {f.note}
          </div>
          <WidgetFrame title={f.widget.title} size={f.widget.size} empty={f.frame.rows.length === 0}>
            <div style={{ height: 280 }}>
              <View widget={f.widget} frame={f.frame} />
            </div>
          </WidgetFrame>
        </section>
      )
    })}
  </div>
)
