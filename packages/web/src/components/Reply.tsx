import { useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Chip } from '@terminal/ui'
import { WIDGET_CHIP_RE, type AnyWidget } from '@terminal/core'
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

const CHIP_TOKEN = new RegExp(WIDGET_CHIP_RE.source, 'g')

/**
 * One placement rule for chips (taste round, change 9): every chip moves to the end of the paragraph it sits in, in
 * the order written, and the sentence it was lifted from closes up ("3.45% [chip] [chip] ." becomes "3.45%."), so
 * nothing follows a chip on its line and no full stop is stranded after one. List items and headings count as
 * paragraphs of their own (one line each).
 */
export function chipsToParagraphEnd(text: string): string {
  return text
    .split(/(\n\s*\n)/)
    .map((block) => {
      if (/^\n\s*\n$/.test(block)) return block
      const lines = block.split('\n')
      // A block of list items or a table: each line keeps its own chips at its end.
      const perLine = lines.length > 1 && lines.every((l) => /^\s*([-*+]|\d+[.)]|\|)/.test(l) || l.trim() === '')
      const units = perLine ? lines : [block]
      const out = units.map((unit) => {
        const chips = unit.match(CHIP_TOKEN) ?? []
        if (chips.length === 0) return unit
        const prose = unit
          .replace(CHIP_TOKEN, '')
          .replace(/[ \t]+([.,;:!?])/g, '$1')
          .replace(/\(\s*\)/g, '')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/[ \t]+$/gm, '')
          .replace(/\s+$/, '')
        return prose ? `${prose} ${chips.join(' ')}` : chips.join(' ')
      })
      return perLine ? out.join('\n') : out[0]!
    })
    .join('')
}

/** Link target for a figure the server could not match to any preview (change 8): rendered with a dotted underline. */
const UNVERIFIED_HREF = '#unverified'

/**
 * Wrap each unverified figure's first occurrence as a link to `#unverified`, outside chip tokens and not inside a
 * longer number, so the renderer can underline it with a hover instead of listing the figures in red.
 */
export function markUnverified(text: string, figures: readonly string[]): string {
  let out = text
  for (const f of [...new Set(figures)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|[^\\w.,$\\[])(${esc})(?![\\w%]|[.,]\\d)`)
    out = out.replace(re, (_m, pre: string, fig: string) => `${pre}[${fig}](${UNVERIFIED_HREF})`)
  }
  return out
}

/**
 * The agent's reply as markdown (GFM: bold, lists, inline code, tables, strikethrough). Raw HTML is shown
 * as text, never rendered. `[[widget:<id>]]` tokens become chips that scroll to and flash the widget.
 */
export function Reply({ text, widgets, streaming = false, unverified = [] }: { text: string; widgets: AnyWidget[]; streaming?: boolean; unverified?: readonly string[] }) {
  const key = unverified.join('\u0000')
  const source = useMemo(() => chipsToLinks(markUnverified(chipsToParagraphEnd(text), unverified)), [text, key])
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => {
        if (href === UNVERIFIED_HREF) {
          return (
            <span data-unverified="" className="cursor-help underline decoration-fg-3 decoration-dotted underline-offset-2" title="Not found in any widget's data">
              {children}
            </span>
          )
        }
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
