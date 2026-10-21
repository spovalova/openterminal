// The RSS feed registry `news/rss` resolves its `outlet` and `source` with. Ported from openbb_news/registry.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: the tables the module builds in code are registry.json (built by
// generate-registry.py), and the user's own [news] table in openbb.toml, which OpenBB layers over them, is not read.
import { compareText } from '../../lib/compare-text.js'
import registry from './registry.json' with { type: 'json' }

type Registry = { feeds: Record<string, string>; meta: Record<string, [provider: string, label: string]>; providers: Record<string, string>; defaults: Record<string, string> }
const { feeds, meta, defaults } = registry as unknown as Registry

/** `list_feed_choices`: the feeds of a provider as `{label, value}`, by label. */
export function listFeedChoices(provider: string | undefined): { label: string; value: string }[] {
  if (!provider) return []
  return Object.entries(meta)
    .filter(([, [feedProvider]]) => feedProvider === provider)
    .map(([value, [, label]]) => ({ label, value }))
    .sort((a, b) => compareText(a.label, b.label))
}

/** `default_feed_for`: the feed to use for an outlet when the call names no source. */
export function defaultFeedFor(provider: string | undefined): string | undefined {
  if (!provider) return undefined
  const preferred = Object.hasOwn(defaults, provider) ? defaults[provider] : undefined
  if (preferred && Object.hasOwn(feeds, preferred)) return preferred
  return listFeedChoices(provider)[0]?.value
}

/** `get_feed_url`: a feed's URL by key. */
export function getFeedUrl(key: string): string {
  const url = Object.hasOwn(feeds, key) ? feeds[key] : undefined
  if (url === undefined) throw new Error(`Unknown RSS feed source '${key}'. Known sources: ${Object.keys(feeds).sort(compareText).join(', ')}.`)
  return url
}
