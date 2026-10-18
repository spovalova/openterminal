import { useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Chip } from '@terminal/ui'
import { WIDGET_CHIP_RE, type Widget } from '@terminal/core'
import { highlightWidget } from '../chips'

/** Link target that marks a chip; never a real URL, so the default URL sanitiser lets it through. */
const CHIP_HREF = '#widget:'
const plugins = [remarkGfm]

/**
 * `[[widget:<id>]]` tokens become markdown links to `#widget:<id>` (the id is the link text), so they survive
 * the markdown pass as link nodes that the renderer turns back into chips, inline wherever the agent put them.
 */
export function chipsToLinks(text: string): string {
  return text.replace(new RegExp(WIDGET_CHIP_RE.source, 'g'), (_m, id: string) => `[${id}](${CHIP_HREF}${id})`)
}

/**
 * The agent's reply as markdown (GFM: bold, lists, inline code, tables, strikethrough). Raw HTML is shown
 * as text, never rendered. `[[widget:<id>]]` tokens become chips that scroll to and flash the widget.
 */
export function Reply({ text, widgets, streaming = false }: { text: string; widgets: Widget[]; streaming?: boolean }) {
  const source = useMemo(() => chipsToLinks(text), [text])
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => {
        if (href?.startsWith(CHIP_HREF)) {
          const id = href.slice(CHIP_HREF.length)
          return <Chip onClick={() => highlightWidget(id)}>{widgets.find((w) => w.id === id)?.title ?? id}</Chip>
        }
        return (
          <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
            {children}
          </a>
        )
      },
    }),
    [widgets],
  )
  return (
    <div className="markdown leading-relaxed text-fg">
      <Markdown remarkPlugins={plugins} components={components}>
        {source}
      </Markdown>
      {streaming && <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-accent align-middle" aria-hidden />}
    </div>
  )
}
