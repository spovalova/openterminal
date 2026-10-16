import { useMemo } from 'react'
import { Chip } from '@terminal/ui'
import type { Widget } from '@terminal/core'
import { highlightWidget, parseReply } from '../chips'

/** The agent's reply; [[widget:<id>]] tokens become chips that scroll to and flash the widget. */
export function Reply({ text, widgets, streaming = false }: { text: string; widgets: Widget[]; streaming?: boolean }) {
  const parts = useMemo(() => parseReply(text), [text])
  return (
    <div className="whitespace-pre-wrap leading-relaxed text-fg">
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <Chip key={i} onClick={() => highlightWidget(p.id)}>
            {widgets.find((w) => w.id === p.id)?.title ?? p.id}
          </Chip>
        ),
      )}
      {streaming && <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-accent align-middle" aria-hidden />}
    </div>
  )
}
