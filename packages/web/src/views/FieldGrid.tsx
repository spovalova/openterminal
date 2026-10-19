import type { FC } from 'react'
import clsx from 'clsx'
import { shortLabel } from './labels'

export type FieldItem = {
  key: string
  label: string
  text: string
  /** Mono numbers (the `num` face): every field but prose and links. */
  mono?: boolean
  /** Text colour class (signed changes up or down, an empty cell muted). */
  tone?: string
  /** Full value on hover for a long string. */
  title?: string
}

/** A label this long, or a value this long, takes two pairs' width so it stays on one line. */
const WIDE_LABEL = 18
const WIDE_VALUE = 12

/**
 * A card's fields (taste round 2, change 2): label beside value in pairs at most 180px wide (two across in a 343px
 * column, three in a 503px one), never spread across the card; labels never wrap: a long one is shortened
 * (`shortLabel`) and, if still long, its pair takes two columns. The grid sits 8px under the hero with a hairline.
 */
export const FieldGrid: FC<{ fields: readonly FieldItem[]; rule?: boolean }> = ({ fields, rule = true }) => (
  <div data-details="" className={clsx('field-grid text-xs leading-5', rule && 'border-t border-border/60 pt-2')}>
    {fields.map((f) => {
      const label = shortLabel(f.label)
      const wide = label.length > WIDE_LABEL || f.text.length > WIDE_VALUE
      const prose = f.text.length > 24
      return (
        <div key={f.key} data-fact={f.key} className={clsx('flex min-w-0 items-baseline justify-between gap-3', prose ? 'col-span-full' : wide && 'col-span-2')}>
          <span className="shrink-0 whitespace-nowrap text-fg-3" title={label === f.label ? undefined : f.label}>
            {label}
          </span>
          <span data-field="value" title={f.title} className={clsx('min-w-0 text-right', prose ? 'break-words' : 'whitespace-nowrap', f.mono !== false && 'num', f.tone ?? 'text-fg')}>
            {f.text}
          </span>
        </div>
      )
    })}
  </div>
)
