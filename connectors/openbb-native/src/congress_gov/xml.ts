// A small ElementTree-like view of an XML document (find/findall by slash paths, .text, children in document
// order), the API openbb_government_us/congress's parsers are written against. Built on fast-xml-parser's
// order-preserving output.
import { XMLParser } from 'fast-xml-parser'

type RawNode = Record<string, unknown>

/** Numeric character references (`&#x2014;`), which fast-xml-parser leaves undecoded. */
function decodeCharRefs(s: string): string {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
}

export class El {
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string>,
    readonly children: El[],
    /** The text right after the start tag, before the first child (ElementTree's `.text`), or null. */
    readonly text: string | null,
  ) {}

  /** The first descendant along a path of child tags (`titles/item`). */
  find(path: string): El | undefined {
    return this.findall(path)[0]
  }

  findall(path: string): El[] {
    let level: El[] = [this]
    for (const step of path.split('/')) level = level.flatMap((e) => e.children.filter((c) => c.tag === step))
    return level
  }

  /** This element and every element below it, in document order. */
  iter(): El[] {
    const out: El[] = []
    const walk = (e: El): void => {
      out.push(e)
      for (const c of e.children) walk(c)
    }
    walk(this)
    return out
  }

  /** The first element called `tag` in this element's subtree, itself included (`next(el for el in root.iter() ...)`). */
  descendant(tag: string): El | undefined {
    if (this.tag === tag) return this
    for (const c of this.children) {
      const found = c.descendant(tag)
      if (found) return found
    }
    return undefined
  }

  get(name: string): string | undefined {
    return this.attrs[name]
  }
}

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: false, removeNSPrefix: true })

function toEl(node: RawNode): El | null {
  const tag = Object.keys(node).find((k) => k !== ':@' && k !== '#text')
  // The XML declaration and processing instructions (`?xml-stylesheet`) are not elements.
  if (tag === undefined || tag.startsWith('?')) return null
  const rawAttrs = (node[':@'] ?? {}) as Record<string, string>
  const attrs = Object.fromEntries(Object.entries(rawAttrs).map(([k, v]) => [k.replace(/^@_/, ''), decodeCharRefs(String(v))]))
  const kids = (node[tag] ?? []) as RawNode[]
  const children: El[] = []
  let text: string | null = null
  kids.forEach((kid, i) => {
    if ('#text' in kid) {
      if (i === 0) text = decodeCharRefs(String(kid['#text']))
      return
    }
    const el = toEl(kid)
    if (el) children.push(el)
  })
  return new El(tag, attrs, children, text)
}

/** The root element of an XML document. */
export function parseElement(xml: string): El {
  const root = (parser.parse(xml) as RawNode[]).map(toEl).find((e): e is El => e !== null)
  if (!root) throw new Error('no XML root element')
  return root
}

/** `element.find(path).text.strip()`, empty when absent (`_text`). */
export function textAt(el: El, path: string): string {
  return (el.find(path)?.text ?? '').trim()
}

/** The first non-empty text among the paths (`_first_text`). */
export function firstText(el: El, ...paths: string[]): string {
  for (const p of paths) {
    const t = textAt(el, p)
    if (t) return t
  }
  return ''
}

/** The items of the first path that matches anything (`_first_items`). */
export function firstItems(el: El, ...paths: string[]): El[] {
  for (const p of paths) {
    const items = el.findall(p)
    if (items.length > 0) return items
  }
  return []
}

/** A leaf `<item>` flattened to `{tag: text}` (`_item_dict`); a later child of the same tag wins. */
export function itemDict(item: El): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of item.children) out[c.tag] = (c.text ?? '').trim()
  return out
}
