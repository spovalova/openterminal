// The dictionary feedparser keeps a feed and its entries in. Ported from feedparser/util.py (FeedParserDict;
// feedparser 6.0.14, BSD-2-Clause); modified: a KeyError is a missing key (`get` gives undefined, `has` is false) and a
// stored None is null.

type Key = string

/** What `__getitem__` returns instead of raising KeyError. */
const MISSING = Symbol('missing')

const KEYMAP: Record<Key, string | string[]> = {
  channel: 'feed',
  items: 'entries',
  guid: 'id',
  date: 'updated',
  date_parsed: 'updated_parsed',
  description: ['summary', 'subtitle'],
  description_detail: ['summary_detail', 'subtitle_detail'],
  url: ['href'],
  modified: 'updated',
  modified_parsed: 'updated_parsed',
  issued: 'published',
  issued_parsed: 'published_parsed',
  copyright: 'rights',
  copyright_detail: 'rights_detail',
  tagline: 'subtitle',
  tagline_detail: 'subtitle_detail',
}

export class FeedParserDict {
  private readonly data = new Map<Key, any>()

  constructor(init?: Iterable<readonly [Key, any]> | Record<Key, any>) {
    if (!init) return
    // `dict(...)` fills the dictionary without going through `__setitem__`, so the key map does not apply.
    const pairs = Symbol.iterator in init ? (init as Iterable<readonly [Key, any]>) : Object.entries(init)
    for (const [k, v] of pairs) this.data.set(k, v)
  }

  /** `dict.__contains__`. */
  rawHas(key: Key): boolean {
    return this.data.has(key)
  }

  /** `dict.__getitem__`; undefined where Python raises KeyError (a stored None is null). */
  rawGet(key: Key): any {
    return this.data.get(key)
  }

  /** `__getitem__`: the key map, the `updated` fallbacks and the derived keys. MISSING stands for KeyError. */
  private getItem(key: Key): any {
    if (key === 'category') {
      const tags = this.data.get('tags') as FeedParserDict[] | undefined
      return tags && tags.length > 0 ? tags[0]!.rawGet('term') : MISSING
    }
    if (key === 'enclosures') {
      if (!this.data.has('links')) return MISSING
      const links = this.data.get('links') as FeedParserDict[]
      return links.filter((link) => link.rawGet('rel') === 'enclosure').map((link) => new FeedParserDict([...link.entries()].filter(([name]) => name !== 'rel')))
    }
    if (key === 'license') {
      for (const link of (this.data.get('links') ?? []) as FeedParserDict[]) if (link.rawGet('rel') === 'license' && link.rawHas('href')) return link.rawGet('href')
      return this.data.has(key) ? this.data.get(key) : MISSING
    }
    if (key === 'updated' || key === 'updated_parsed') {
      // The old, broken behaviour of issue 310: `updated` falls back to `published`.
      const published = key === 'updated' ? 'published' : 'published_parsed'
      const from = !this.data.has(key) && this.data.has(published) ? published : key
      return this.data.has(from) ? this.data.get(from) : MISSING
    }
    const realkey = KEYMAP[key] ?? key
    if (Array.isArray(realkey)) {
      for (const k of realkey) if (this.data.has(k)) return this.data.get(k)
    } else if (this.data.has(realkey)) return this.data.get(realkey)
    return this.data.has(key) ? this.data.get(key) : MISSING
  }

  /** `__contains__`. */
  has(key: Key): boolean {
    if (key === 'updated' || key === 'updated_parsed') return this.data.has(key)
    return this.getItem(key) !== MISSING
  }

  /** `get(key)`: undefined where the key is not there. */
  get(key: Key): any {
    const value = this.getItem(key)
    return value === MISSING ? undefined : value
  }

  /** `__setitem__`: the key map renames the key. */
  set(key: Key, value: any): void {
    const mapped = KEYMAP[key] ?? key
    // A value Python has as None is null here, so the key is still there.
    this.data.set(Array.isArray(mapped) ? mapped[0]! : mapped, value === undefined ? null : value)
  }

  setdefault<T>(key: Key, value: T): T {
    if (!this.has(key)) {
      this.set(key, value)
      return value
    }
    return this.get(key) as T
  }

  delete(key: Key): void {
    this.data.delete(key)
  }

  clear(): void {
    this.data.clear()
  }

  entries(): IterableIterator<[Key, any]> {
    return this.data.entries()
  }

  get size(): number {
    return this.data.size
  }

  /** `copy.deepcopy`. */
  deepCopy(): FeedParserDict {
    const copy = new FeedParserDict()
    for (const [k, v] of this.data) copy.data.set(k, deepCopyValue(v))
    return copy
  }
}

function deepCopyValue(v: any): any {
  if (v instanceof FeedParserDict) return v.deepCopy()
  if (Array.isArray(v)) return v.map(deepCopyValue)
  return v
}
