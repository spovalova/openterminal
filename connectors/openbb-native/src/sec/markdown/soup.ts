// A small Beautiful Soup for the sec ports. Emulates CPython 3.12's html.parser tokenizer and Beautiful Soup 4.15's
// HTMLParserTreeBuilder (convert_charrefs=False, bs4's own character-reference handling, void elements, script/style
// raw text, no implicit closing of p/li/td, `_popToTag` for end tags), plus the parts of the bs4 API the SEC code uses:
// find / find_all, get_text, decompose / extract / replace_with, attrs, siblings, copy, and str(tag) with the
// "minimal" formatter.
//
// STATUS: the html.parser mode and serialization (`toString()` / `decode()`, equal to Python's `str(tag)`) are
// usable: `parse(html, 'html.parser')`. The 'lxml' mode (used by html_to_markdown's entry point) lives in
// lxml-parser.ts and is reached through the same `parse()`.
//
// Ported from Python's html/parser.py and html/__init__.py (PSF License) and Beautiful Soup 4.15 (MIT); modified:
// TypeScript, iterative traversals, no pretty printing.
import { HTML5_ENTITIES, HTML_ENTITY_TO_CHARACTER } from './entities.js'
import { parseLxml } from './lxml-parser.js'
import { strip } from './py.js'

// ---------------------------------------------------------------------------------------------------------------
// Builder constants (bs4.builder.HTMLTreeBuilder)
// ---------------------------------------------------------------------------------------------------------------

const EMPTY_ELEMENT_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'command', 'frame', 'image', 'isindex', 'nextid', 'spacer'])
const PRESERVE_WHITESPACE_TAGS = new Set(['pre', 'textarea'])
const CDATA_LIST_ATTRIBUTES: Record<string, Set<string>> = {
  '*': new Set(['class', 'accesskey', 'dropzone']),
  a: new Set(['rel', 'rev']),
  link: new Set(['rel', 'rev']),
  td: new Set(['headers']),
  th: new Set(['headers']),
  form: new Set(['accept-charset']),
  object: new Set(['archive']),
  area: new Set(['rel']),
  icon: new Set(['sizes']),
  iframe: new Set(['sandbox']),
  output: new Set(['for']),
}

export type StringKind = 'text' | 'comment' | 'cdata' | 'doctype' | 'declaration' | 'pi' | 'script' | 'style' | 'template' | 'rt' | 'rp'
/** `DEFAULT_STRING_CONTAINERS`: the string class for text directly inside these tags. */
const STRING_CONTAINERS: Record<string, StringKind> = { rt: 'rt', rp: 'rp', style: 'style', script: 'script', template: 'template' }

const ASCII_SPACES = ' \n\t\f\r'

export const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// ---------------------------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------------------------

export type AttrValue = string | string[]
export type AttrInput = Record<string, string> | Map<string, string> | [string, string][]

/** Base of Tag and NavigableString (`bs4.element.PageElement`). */
export abstract class PageElement {
  parent: Tag | null = null
  /** True once decompose() has run: bs4 clears the object, so attributes read as None. */
  decomposed = false
  private _idx = -1

  /** @internal position hint in parent.contents */
  setIndexHint(i: number): void {
    this._idx = i
  }

  /** Position in the parent's contents, -1 without a parent. */
  indexInParent(): number {
    const p = this.parent
    if (!p) return -1
    if (p.contents[this._idx] === this) return this._idx
    this._idx = p.contents.indexOf(this)
    return this._idx
  }

  get nextSibling(): PageElement | null {
    const p = this.parent
    if (!p) return null
    return p.contents[this.indexInParent() + 1] ?? null
  }

  get previousSibling(): PageElement | null {
    const p = this.parent
    if (!p) return null
    const i = this.indexInParent()
    return i > 0 ? p.contents[i - 1]! : null
  }

  /** Remove this element from the tree (`extract()`); returns it. */
  extract(): this {
    const p = this.parent
    if (p) {
      const i = this.indexInParent()
      if (i >= 0) p.contents.splice(i, 1)
      this.parent = null
    }
    return this
  }

  /** `replace_with(*args)`: put the arguments (strings become NavigableStrings) where this element was. */
  replaceWith(...items: (PageElement | string)[]): void {
    const parent = this.parent
    if (!parent) throw new Error('Cannot replace one element with another when the element to be replaced is not part of a tree.')
    if (items.length === 1 && items[0] === this) return
    const at = this.indexInParent()
    this.extract()
    items.forEach((item, k) => parent.insert(at + k, item))
  }

  /** `insert_before` / `insert_after` for one element. */
  insertBefore(item: PageElement | string): void {
    const parent = this.parent
    if (!parent) throw new Error('Element has no parent, so \'before\' has no meaning.')
    parent.insert(this.indexInParent(), item)
  }

  insertAfter(item: PageElement | string): void {
    const parent = this.parent
    if (!parent) throw new Error('Element has no parent, so \'after\' has no meaning.')
    parent.insert(this.indexInParent() + 1, item)
  }

  /** Walk up: the closest ancestor tag (or the tag itself is excluded) matching the name. */
  findParent(name?: NameMatcher | null, opts: { attrs?: Record<string, AttrMatcher> } = {}): Tag | null {
    for (let p = this.parent; p; p = p.parent) if (matchTag(p, name ?? true, opts.attrs)) return p
    return null
  }
}

/** A string in the tree. Comments, CDATA, doctypes and the like are NavigableStrings of another `kind`. */
export class NavigableString extends PageElement {
  constructor(
    public text: string,
    public kind: StringKind = 'text',
  ) {
    super()
  }

  /** `.name` of a string is None. */
  get name(): null {
    return null
  }

  /** `str.strip()` of the text. */
  strip(): string {
    return strip(this.text)
  }

  override toString(): string {
    return this.text
  }

  /** `output_ready(formatter="minimal")`. */
  outputReady(): string {
    switch (this.kind) {
      case 'comment':
        return `<!--${this.text}-->`
      case 'cdata':
        return `<![CDATA[${this.text}]]>`
      case 'doctype':
        return `<!DOCTYPE ${this.text}>\n`
      case 'declaration':
        return `<?${this.text}?>`
      case 'pi':
        return `<?${this.text}>`
      default: {
        // Text inside <script> and <style> is not escaped.
        const parent = this.parent
        if (parent && (parent.name === 'script' || parent.name === 'style')) return this.text
        return substituteXml(this.text)
      }
    }
  }
}

export class Comment extends NavigableString {
  constructor(text: string) {
    super(text, 'comment')
  }
}

export class CData extends NavigableString {
  constructor(text: string) {
    super(text, 'cdata')
  }
}

export class Doctype extends NavigableString {
  constructor(text: string) {
    super(text, 'doctype')
  }
}

export class Declaration extends NavigableString {
  constructor(text: string) {
    super(text, 'declaration')
  }
}

export class ProcessingInstruction extends NavigableString {
  constructor(text: string) {
    super(text, 'pi')
  }
}

/** A string node of the class its kind names (Comment, CData, Doctype, …), as bs4's `containerClass` does. */
export function makeString(text: string, kind: StringKind = 'text'): NavigableString {
  switch (kind) {
    case 'comment':
      return new Comment(text)
    case 'cdata':
      return new CData(text)
    case 'doctype':
      return new Doctype(text)
    case 'declaration':
      return new Declaration(text)
    case 'pi':
      return new ProcessingInstruction(text)
    default:
      return new NavigableString(text, kind)
  }
}

/** `EntitySubstitution.substitute_xml`: & < > only. */
export function substituteXml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

function quotedAttributeValue(value: string): string {
  let quote = '"'
  if (value.includes('"')) {
    if (value.includes("'")) value = value.replaceAll('"', '&quot;')
    else quote = "'"
  }
  return quote + value + quote
}

// --- find / find_all matching ---------------------------------------------------------------------------------

/** A tag-name filter: a name, a list of names, true (any tag), a pattern, or a predicate. */
export type NameMatcher = string | readonly string[] | RegExp | true | ((tag: Tag) => boolean)
/** An attribute filter: a value, a pattern, true (attribute present), false/null (absent), or a predicate. */
export type AttrMatcher = string | RegExp | boolean | null | ((value: string | undefined) => boolean)

export type FindOpts = {
  attrs?: Record<string, AttrMatcher>
  /** Shortcut for `attrs: { class: … }` (bs4's `class_`). */
  class_?: AttrMatcher
  recursive?: boolean
  limit?: number
  /** Match strings instead of tags: true (any), a value, a pattern or a predicate. */
  string?: true | string | RegExp | ((s: NavigableString) => boolean)
}

function matchesString(value: string, m: AttrMatcher): boolean {
  if (typeof m === 'string') return value === m
  if (m instanceof RegExp) {
    m.lastIndex = 0
    return m.test(value)
  }
  if (typeof m === 'function') return m(value)
  return m === true
}

function matchAttr(raw: AttrValue | undefined, m: AttrMatcher): boolean {
  if (m === true) return raw !== undefined
  if (m === false || m === null) return raw === undefined
  if (raw === undefined) return typeof m === 'function' ? m(undefined) : false
  if (Array.isArray(raw)) {
    if (typeof m === 'function') return m(raw.join(' '))
    return raw.some((item) => matchesString(item, m)) || matchesString(raw.join(' '), m)
  }
  return matchesString(raw, m)
}

function matchName(name: string, m: NameMatcher, tag: Tag): boolean {
  if (m === true) return true
  if (typeof m === 'string') return name === m
  if (m instanceof RegExp) {
    m.lastIndex = 0
    return m.test(name)
  }
  if (typeof m === 'function') return m(tag)
  return m.includes(name)
}

function matchTag(tag: Tag, name: NameMatcher | null | undefined, attrs?: Record<string, AttrMatcher>): boolean {
  if (name !== null && name !== undefined && !matchName(tag.name, name, tag)) return false
  if (attrs) for (const [k, m] of Object.entries(attrs)) if (!matchAttr(tag.attrs.get(k), m)) return false
  return true
}

/** Tag identity for `in set` the way bs4's Tag.__eq__ / __hash__ define it: same name, attributes and contents. */
export function tagEquals(a: PageElement, b: PageElement): boolean {
  if (a === b) return true
  if (a instanceof NavigableString || b instanceof NavigableString) {
    return a instanceof NavigableString && b instanceof NavigableString && a.text === b.text && a.kind === b.kind
  }
  const x = a as Tag
  const y = b as Tag
  if (x.name !== y.name || x.contents.length !== y.contents.length || x.attrs.size !== y.attrs.size) return false
  for (const [k, v] of x.attrs) {
    const w = y.attrs.get(k)
    if (w === undefined || (Array.isArray(v) ? !Array.isArray(w) || v.join('\0') !== w.join('\0') : v !== w)) return false
  }
  return x.contents.every((c, i) => tagEquals(c, y.contents[i]!))
}

/** A set of tags with bs4's structural membership (hash of `str(tag)` plus `==`). */
export class TagSet {
  private byHash = new Map<string, Tag[]>()

  add(tag: Tag): void {
    const h = tag.toString()
    const bucket = this.byHash.get(h)
    if (!bucket) this.byHash.set(h, [tag])
    else if (!bucket.some((t) => tagEquals(t, tag))) bucket.push(tag)
  }

  has(tag: Tag): boolean {
    return this.byHash.get(tag.toString())?.some((t) => tagEquals(t, tag)) ?? false
  }

  *[Symbol.iterator](): Generator<Tag> {
    for (const bucket of this.byHash.values()) yield* bucket
  }
}

// --- Tag ------------------------------------------------------------------------------------------------------

export class Tag extends PageElement {
  name: string
  attrs: Map<string, AttrValue>
  contents: PageElement[] = []
  /** Hidden tags (the document) print only their contents. */
  hidden = false
  canBeEmptyElement: boolean
  /** `<meta>` attributes whose value is rewritten to the output encoding on output (bs4's *MetaAttributeValue). */
  private metaSubstitutions: Map<string, 'charset' | 'content'> | undefined

  constructor(name: string, attrs: Map<string, AttrValue> = new Map()) {
    super()
    this.name = name
    this.attrs = attrs
    this.canBeEmptyElement = EMPTY_ELEMENT_TAGS.has(name)
  }

  /** `tag.get(name)`: a string, or a list for multi-valued attributes such as class; undefined when absent. */
  get(name: string): AttrValue | undefined {
    return this.attrs.get(name)
  }

  /** `tag.get(name, default)` as a single string (lists joined by a space). */
  getStr(name: string, def = ''): string {
    const v = this.attrs.get(name)
    return v === undefined ? def : Array.isArray(v) ? v.join(' ') : v
  }

  has(name: string): boolean {
    return this.attrs.has(name)
  }

  set(name: string, value: AttrValue): void {
    this.attrs.set(name, value)
    this.metaSubstitutions?.delete(name)
  }

  /** `del tag[name]` */
  delete(name: string): void {
    this.attrs.delete(name)
    this.metaSubstitutions?.delete(name)
  }

  get isEmptyElement(): boolean {
    return this.contents.length === 0 && this.canBeEmptyElement
  }

  /** `tag.children` */
  get children(): PageElement[] {
    return this.contents
  }

  /** The tags among the children. */
  get childTags(): Tag[] {
    return this.contents.filter((c): c is Tag => c instanceof Tag)
  }

  get lastChild(): PageElement | null {
    return this.contents[this.contents.length - 1] ?? null
  }

  // --- building ---

  append(item: PageElement | string): void {
    this.insert(this.contents.length, item)
  }

  insert(position: number, item: PageElement | string): void {
    const el = typeof item === 'string' ? new NavigableString(item) : item
    if (el === this) throw new Error('Cannot insert a tag into itself.')
    if (el.parent) {
      if (el.parent === this) {
        const current = el.indexInParent()
        if (current < position) position--
      }
      el.extract()
    }
    position = Math.min(position, this.contents.length)
    el.parent = this
    this.contents.splice(position, 0, el)
    el.setIndexHint(position)
  }

  /** `tag.clear()`: remove (and keep alive) every child. */
  clear(): void {
    for (const c of this.contents) c.parent = null
    this.contents = []
  }

  /** `tag.string`: the only string inside, looking through single-child tags; null otherwise. */
  get string(): NavigableString | null {
    if (this.contents.length !== 1) return null
    const child = this.contents[0]!
    return child instanceof NavigableString ? child : (child as Tag).string
  }

  /** `tag.string = value` */
  set string(value: string | NavigableString | null) {
    this.clear()
    if (value !== null) this.append(value instanceof NavigableString ? makeString(value.text, value.kind) : new NavigableString(value))
  }

  /** `decompose()`: unlink the tag and mark it and its descendants as destroyed. */
  decompose(): void {
    this.extract()
    const stack: PageElement[] = [this]
    while (stack.length) {
      const el = stack.pop()!
      el.decomposed = true
      el.parent = null
      if (el instanceof Tag) {
        stack.push(...el.contents)
        el.contents = []
        el.attrs = new Map()
      }
    }
  }

  // --- traversal ---

  /** Every descendant, in document order. */
  *descendants(): Generator<PageElement> {
    const stack: { tag: Tag; i: number }[] = [{ tag: this, i: 0 }]
    while (stack.length) {
      const top = stack[stack.length - 1]!
      if (top.i >= top.tag.contents.length) {
        stack.pop()
        continue
      }
      const child = top.tag.contents[top.i++]!
      yield child
      if (child instanceof Tag && child.contents.length) stack.push({ tag: child, i: 0 })
    }
  }

  /** `find_all(name, attrs, recursive, string, limit)`; with `string` the result holds strings instead of tags. */
  findAll(name?: NameMatcher | null, opts: FindOpts = {}): Tag[] {
    return this.search(name, opts) as Tag[]
  }

  findAllStrings(opts: Pick<FindOpts, 'string' | 'recursive' | 'limit'> = { string: true }): NavigableString[] {
    return this.search(null, { ...opts, string: opts.string ?? true }) as NavigableString[]
  }

  find(name?: NameMatcher | null, opts: Omit<FindOpts, 'limit'> = {}): Tag | null {
    return (this.search(name, { ...opts, limit: 1 })[0] as Tag | undefined) ?? null
  }

  private search(name: NameMatcher | null | undefined, opts: FindOpts): PageElement[] {
    const attrs: Record<string, AttrMatcher> | undefined = opts.class_ !== undefined ? { ...opts.attrs, class: opts.class_ } : opts.attrs
    const out: PageElement[] = []
    const limit = opts.limit ?? Infinity
    const wantStrings = opts.string !== undefined
    const test = (el: PageElement): boolean => {
      if (wantStrings) {
        if (!(el instanceof NavigableString)) return false
        const s = opts.string!
        if (s === true) return true
        if (typeof s === 'string') return el.text === s
        if (s instanceof RegExp) {
          s.lastIndex = 0
          return s.test(el.text)
        }
        return s(el)
      }
      return el instanceof Tag && matchTag(el, name, attrs)
    }
    if (opts.recursive === false) {
      for (const c of this.contents) if (test(c) && out.push(c) >= limit) break
      return out
    }
    for (const el of this.descendants()) if (test(el) && out.push(el) >= limit) break
    return out
  }

  /** Strings that `get_text()` of this tag includes: `NavigableString` and `CData` (or the tag's own container kind). */
  private get interestingKinds(): StringKind[] {
    const own = hasOwn(STRING_CONTAINERS, this.name) ? STRING_CONTAINERS[this.name] : undefined
    return own ? [own] : ['text', 'cdata']
  }

  /** `_all_strings(strip)` */
  allStrings(stripText = false): string[] {
    const kinds = this.interestingKinds
    const out: string[] = []
    for (const el of this.descendants()) {
      if (!(el instanceof NavigableString) || !kinds.includes(el.kind)) continue
      let text = el.text
      if (stripText) {
        text = strip(text)
        if (text.length === 0) continue
      }
      out.push(text)
    }
    return out
  }

  /** `get_text(separator, strip)` */
  getText(separator = '', stripText = false): string {
    return this.allStrings(stripText).join(separator)
  }

  /** `tag.text` */
  get text(): string {
    return this.getText()
  }

  /** `copy.copy(tag)`: a deep copy, unattached. */
  copy(): Tag {
    const clone = new Tag(this.name, new Map([...this.attrs].map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])))
    clone.hidden = this.hidden
    clone.canBeEmptyElement = this.canBeEmptyElement
    if (this.metaSubstitutions) clone.metaSubstitutions = new Map(this.metaSubstitutions)
    for (const c of this.contents) clone.append(c instanceof Tag ? c.copy() : makeString((c as NavigableString).text, (c as NavigableString).kind))
    return clone
  }

  /** @internal `HTMLTreeBuilder.set_up_substitutions` */
  setUpSubstitutions(): void {
    if (this.name !== 'meta') return
    const content = this.attrs.get('content')
    const charset = this.attrs.get('charset')
    const httpEquiv = this.attrs.get('http-equiv')
    const equivList = httpEquiv === undefined ? [] : Array.isArray(httpEquiv) ? httpEquiv : [httpEquiv]
    if (charset !== undefined) (this.metaSubstitutions ??= new Map()).set('charset', 'charset')
    else if (content !== undefined && equivList.some((x) => x.toLowerCase() === 'content-type')) {
      if (CHARSET_RE.test(Array.isArray(content) ? content.join(' ') : content)) (this.metaSubstitutions ??= new Map()).set('content', 'content')
    }
  }

  // --- output ---

  private formatTag(opening: boolean): string {
    if (this.hidden) return ''
    let attributeString = ''
    if (opening) {
      const items = [...this.attrs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      const parts: string[] = []
      for (const [key, raw] of items) {
        let val = Array.isArray(raw) ? raw.join(' ') : raw
        const sub = this.metaSubstitutions?.get(key)
        if (sub === 'charset') val = 'utf-8'
        else if (sub === 'content') val = val.replace(CHARSET_RE_G, (_m, g1: string) => `${g1}utf-8`)
        parts.push(`${key}=${quotedAttributeValue(substituteXml(val))}`)
      }
      if (parts.length) attributeString = ` ${parts.join(' ')}`
    }
    return `<${opening ? '' : '/'}${this.name}${attributeString}${this.isEmptyElement ? '/' : ''}>`
  }

  /** `decode()`: the HTML of this tag with the "minimal" formatter (Python's `str(tag)`). */
  decode(): string {
    const pieces: string[] = []
    // Iterative event walk: tag.decode() must cope with the deep trees html.parser builds from unclosed tags.
    const stack: { tag: Tag; i: number }[] = []
    const open = (tag: Tag): void => {
      if (tag.isEmptyElement) {
        pieces.push(tag.formatTag(true))
        return
      }
      pieces.push(tag.formatTag(true))
      stack.push({ tag, i: 0 })
    }
    open(this)
    while (stack.length) {
      const top = stack[stack.length - 1]!
      if (top.i >= top.tag.contents.length) {
        pieces.push(top.tag.formatTag(false))
        stack.pop()
        continue
      }
      const child = top.tag.contents[top.i++]!
      if (child instanceof Tag) open(child)
      else pieces.push((child as NavigableString).outputReady())
    }
    return pieces.join('')
  }

  /** The inner HTML (`decode_contents()`). */
  decodeContents(): string {
    return this.contents.map((c) => (c instanceof Tag ? c.decode() : (c as NavigableString).outputReady())).join('')
  }

  override toString(): string {
    return this.decode()
  }
}

const CHARSET_RE = /((^|;)\s*charset=)([^;]*)/m
const CHARSET_RE_G = /((^|;)\s*charset=)([^;]*)/gm

// ---------------------------------------------------------------------------------------------------------------
// The tree builder (bs4.BeautifulSoup): what both parsers feed
// ---------------------------------------------------------------------------------------------------------------

export class BeautifulSoup extends Tag {
  private tagStack: Tag[] = []
  private currentTag: Tag
  private openTagCounter = new Map<string, number>()
  private preserveWhitespaceTagStack: Tag[] = []
  private stringContainerStack: Tag[] = []
  private currentData: string[] = []

  constructor() {
    super('[document]')
    this.hidden = true
    this.currentTag = this
    this.tagStack = [this]
  }

  // --- the tree-building API html.parser and lxml drive ---

  /** `handle_starttag`: open a tag and make it current. */
  handleStartTag(name: string, attrs: Iterable<[string, string]>): Tag {
    this.endData()
    const map = new Map<string, AttrValue>()
    for (const [k, v] of attrs) map.set(k, v)
    replaceCdataListAttributeValues(name, map)
    const tag = new Tag(name, map)
    tag.setUpSubstitutions()
    this.currentTag.append(tag)
    this.tagStack.push(tag)
    this.currentTag = tag
    this.openTagCounter.set(name, (this.openTagCounter.get(name) ?? 0) + 1)
    if (PRESERVE_WHITESPACE_TAGS.has(name)) this.preserveWhitespaceTagStack.push(tag)
    if (hasOwn(STRING_CONTAINERS, name)) this.stringContainerStack.push(tag)
    return tag
  }

  /** `handle_endtag`: close the most recent open tag of that name (and everything opened after it). */
  handleEndTag(name: string): void {
    this.endData()
    this.popToTag(name)
  }

  /** `handle_data` */
  handleData(data: string): void {
    this.currentData.push(data)
  }

  /** `endData(containerClass)`: turn the collected text into a string node. */
  endData(kind?: StringKind): void {
    if (this.currentData.length === 0) return
    let data = this.currentData.join('')
    if (this.preserveWhitespaceTagStack.length === 0) {
      let strippable = true
      for (const c of data) {
        if (!ASCII_SPACES.includes(c)) {
          strippable = false
          break
        }
      }
      if (strippable) data = data.includes('\n') ? '\n' : ' '
    }
    this.currentData = []
    let k: StringKind = kind ?? 'text'
    if (this.stringContainerStack.length && k === 'text') k = STRING_CONTAINERS[this.stringContainerStack[this.stringContainerStack.length - 1]!.name] ?? k
    this.currentTag.append(makeString(data, k))
  }

  private popTag(): void {
    const tag = this.tagStack.pop()
    if (!tag) return
    const n = this.openTagCounter.get(tag.name)
    if (n !== undefined) this.openTagCounter.set(tag.name, n - 1)
    if (this.preserveWhitespaceTagStack.length && tag === this.preserveWhitespaceTagStack[this.preserveWhitespaceTagStack.length - 1]) this.preserveWhitespaceTagStack.pop()
    if (this.stringContainerStack.length && tag === this.stringContainerStack[this.stringContainerStack.length - 1]) this.stringContainerStack.pop()
    if (this.tagStack.length) this.currentTag = this.tagStack[this.tagStack.length - 1]!
  }

  private popToTag(name: string): void {
    if (name === '[document]') return
    for (let i = this.tagStack.length - 1; i > 0; i--) {
      if (!this.openTagCounter.get(name)) break
      const t = this.tagStack[i]!
      if (name === t.name) {
        this.popTag()
        break
      }
      this.popTag()
    }
  }

  /** @internal after the parser has run: flush text and close whatever is still open. */
  finish(): void {
    this.endData()
    while (this.currentTag.name !== '[document]') this.popTag()
    this.endData()
  }

  /** `object_was_parsed(o)`: add a finished node (a doctype, say) to the tag being built. */
  appendToCurrent(el: PageElement): void {
    this.endData()
    this.currentTag.append(el)
  }

  /** The open tags, innermost last (for builders that need to look at the stack). */
  get openTags(): readonly Tag[] {
    return this.tagStack
  }

  /** `soup.new_tag(name)` */
  newTag(name: string, attrs: Iterable<[string, string]> = []): Tag {
    const map = new Map<string, AttrValue>()
    for (const [k, v] of attrs) map.set(k, v)
    return new Tag(name, map)
  }

  /** `soup.body` */
  get body(): Tag | null {
    return this.find('body')
  }
}

function replaceCdataListAttributeValues(tagName: string, attrs: Map<string, AttrValue>): void {
  if (attrs.size === 0) return
  const universal = CDATA_LIST_ATTRIBUTES['*']!
  const specific = hasOwn(CDATA_LIST_ATTRIBUTES, tagName.toLowerCase()) ? CDATA_LIST_ATTRIBUTES[tagName.toLowerCase()] : undefined
  for (const [k, v] of [...attrs]) {
    if ((universal.has(k) || specific?.has(k)) && typeof v === 'string') attrs.set(k, v.match(/\S+/g) ?? [])
  }
}

// ---------------------------------------------------------------------------------------------------------------
// html.unescape (html/__init__.py)
// ---------------------------------------------------------------------------------------------------------------

const INVALID_CHARREFS: Record<number, string> = {
  0x00: '�', 0x0d: '\r', 0x80: '€', 0x81: '\x81', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8d: '\x8d', 0x8e: 'Ž', 0x8f: '\x8f',
  0x90: '\x90', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9d: '\x9d', 0x9e: 'ž', 0x9f: 'Ÿ',
}

function isInvalidCodepoint(n: number): boolean {
  if ((n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) || (n >= 0x7f && n <= 0x9f) || (n >= 0xfdd0 && n <= 0xfdef)) return true
  return n <= 0x10ffff && (n & 0xfffe) === 0xfffe
}

/** `html.unescape`: HTML5 character references, with the longest legacy prefix for names without a semicolon. */
export function unescape(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (_m, body: string) => {
    if (body[0] === '#') {
      const num = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2).replace(/;$/, ''), 16) : parseInt(body.slice(1).replace(/;$/, ''), 10)
      if (hasOwn(INVALID_CHARREFS, String(num))) return INVALID_CHARREFS[num]!
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�'
      if (isInvalidCodepoint(num)) return ''
      return String.fromCodePoint(num)
    }
    if (hasOwn(HTML5_ENTITIES, body)) return HTML5_ENTITIES[body]!
    for (let x = body.length - 1; x > 1; x--) {
      const prefix = body.slice(0, x)
      if (hasOwn(HTML5_ENTITIES, prefix)) return HTML5_ENTITIES[prefix]! + body.slice(x)
    }
    return `&${body}`
  })
}

// ---------------------------------------------------------------------------------------------------------------
// bs4 numeric character references (dammit.EntitySubstitution / UnicodeDammit.numeric_character_reference)
// ---------------------------------------------------------------------------------------------------------------

const WINDOWS_1252_80_9F: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

function numericCharacterReference(numeric: number): string {
  const replacement = '�'
  if (numeric === 0 || numeric > 0x10ffff) return replacement
  if (numeric >= 0xd800 && numeric <= 0xdfff) return replacement
  if (numeric >= 0x80 && numeric <= 0x9f && hasOwn(WINDOWS_1252_80_9F, String(numeric))) return WINDOWS_1252_80_9F[numeric]!
  return String.fromCodePoint(numeric)
}

/** `BeautifulSoupHTMLParser._dereference_numeric_character_reference` → [character, extra data]. */
function dereferenceNumeric(name: string): [string, string] {
  let base = 10
  let reg = /^([0-9]+)([\s\S]*)/
  if (name.startsWith('x') || name.startsWith('X')) {
    name = name.slice(1)
    base = 16
    reg = /^([0-9a-f]+)([\s\S]*)/
  }
  const wholeOk = base === 10 ? /^\s*[+-]?[0-9_]+\s*$/.test(name) : /^\s*[+-]?(0[xX])?[0-9a-fA-F_]+\s*$/.test(name)
  let real: number | null = null
  let extra = ''
  if (wholeOk) real = parseInt(name.replaceAll('_', ''), base)
  else {
    const m = reg.exec(name)
    if (m) {
      real = parseInt(m[1]!, base)
      extra = m[2]!
    }
  }
  if (real === null || Number.isNaN(real)) return ['', name]
  return [numericCharacterReference(real), extra]
}

// ---------------------------------------------------------------------------------------------------------------
// html.parser (CPython 3.12) + bs4's BeautifulSoupHTMLParser
// ---------------------------------------------------------------------------------------------------------------

const CDATA_CONTENT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes'])
const RCDATA_CONTENT_ELEMENTS = new Set(['textarea', 'title'])

const INTERESTING_NORMAL = /[&<]/g
const INCOMPLETE = /&[a-zA-Z#]/y
const ENTITYREF = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/y
const CHARREF = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/y
const STARTTAGOPEN = /<[a-zA-Z]/y
const ENDTAGOPEN = /<\/[a-zA-Z]/y
const COMMENTCLOSE = /--!?>/g
const COMMENTABRUPTCLOSE = /-?>/y
const TAGFIND_TOLERANT = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y
const ATTRFIND_TOLERANT = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y
const LOCATETAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y

function matchAt(re: RegExp, s: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(s)
}

function searchFrom(re: RegExp, s: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(s)
}

class PyHtmlParser {
  rawdata = ''
  private cdataElem: string | null = null
  private interesting: RegExp = INTERESTING_NORMAL
  private alreadyClosedEmptyElement: string[] = []

  constructor(private soup: BeautifulSoup) {}

  feed(data: string): void {
    this.rawdata += data
    this.goahead(false)
  }

  close(): void {
    this.goahead(true)
  }

  private setCdataMode(elem: string, escapable: boolean): void {
    this.cdataElem = elem.toLowerCase()
    if (this.cdataElem === 'plaintext') this.interesting = /$(?![\s\S])/g
    else if (escapable) this.interesting = new RegExp(`&|</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, 'gi')
    else this.interesting = new RegExp(`</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, 'gi')
  }

  private clearCdataMode(): void {
    this.interesting = INTERESTING_NORMAL
    this.cdataElem = null
  }

  private goahead(end: boolean): void {
    const rawdata = this.rawdata
    let i = 0
    const n = rawdata.length
    while (i < n) {
      let j: number
      const match = searchFrom(this.interesting, rawdata, i)
      if (match) j = match.index
      else {
        if (this.cdataElem) break
        j = n
      }
      if (i < j) this.handleData(rawdata.slice(i, j))
      i = j
      if (i === n) break
      if (rawdata.startsWith('<', i)) {
        let k: number
        if (matchAt(STARTTAGOPEN, rawdata, i)) k = this.parseStarttag(i)
        else if (rawdata.startsWith('</', i)) k = this.parseEndtag(i)
        else if (rawdata.startsWith('<!--', i)) k = this.parseComment(i)
        else if (rawdata.startsWith('<?', i)) k = this.parsePi(i)
        else if (rawdata.startsWith('<!', i)) k = this.parseHtmlDeclaration(i)
        else if (i + 1 < n || end) {
          this.handleData('<')
          k = i + 1
        } else break
        if (k < 0) {
          if (!end) break
          if (matchAt(STARTTAGOPEN, rawdata, i)) {
            // pass
          } else if (rawdata.startsWith('</', i)) {
            if (i + 2 === n) this.handleData('</')
            else if (matchAt(ENDTAGOPEN, rawdata, i)) {
              // pass
            } else this.handleComment(rawdata.slice(i + 2))
          } else if (rawdata.startsWith('<!--', i)) {
            let jj = n
            for (const suffix of ['--!', '--', '-']) {
              if (rawdata.endsWith(suffix) && n - suffix.length >= i + 4) {
                jj -= suffix.length
                break
              }
            }
            this.handleComment(rawdata.slice(i + 4, jj))
          } else if (rawdata.startsWith('<![CDATA[', i)) {
            this.unknownDecl(rawdata.slice(i + 3))
          } else if (rawdata.slice(i, i + 9).toLowerCase() === '<!doctype') {
            this.handleDecl(rawdata.slice(i + 2))
          } else if (rawdata.startsWith('<!', i)) {
            this.handleComment(rawdata.slice(i + 2))
          } else if (rawdata.startsWith('<?', i)) {
            this.handlePi(rawdata.slice(i + 2))
          } else throw new Error('we should not get here!')
          k = n
        }
        i = k
      } else if (rawdata.startsWith('&#', i)) {
        const m = matchAt(CHARREF, rawdata, i)
        if (m) {
          const name = m[0].slice(2, -1)
          this.handleCharref(name)
          let k = m.index + m[0].length
          if (!rawdata.startsWith(';', k - 1)) k = k - 1
          i = k
          continue
        }
        if (rawdata.indexOf(';', i) >= 0) {
          // bail by consuming &#
          this.handleData(rawdata.slice(i, i + 2))
          i = i + 2
        }
        break
      } else if (rawdata.startsWith('&', i)) {
        const m = matchAt(ENTITYREF, rawdata, i)
        if (m) {
          this.handleEntityref(m[1]!)
          let k = m.index + m[0].length
          if (!rawdata.startsWith(';', k - 1)) k = k - 1
          i = k
          continue
        }
        const inc = matchAt(INCOMPLETE, rawdata, i)
        if (inc) {
          // match.group() will contain at least 2 chars
          if (end && inc[0] === rawdata.slice(i)) i = i + 1
          // incomplete
          break
        } else if (i + 1 < n) {
          // not the end of the buffer, and can't be confused with some other construct
          this.handleData('&')
          i = i + 1
        } else break
      } else throw new Error('interesting.search() lied')
    }
    if (end && i < n) {
      this.handleData(rawdata.slice(i, n))
      i = n
    }
    this.rawdata = rawdata.slice(i)
  }

  private parseHtmlDeclaration(i: number): number {
    const rawdata = this.rawdata
    if (rawdata.slice(i, i + 4) === '<!--') return this.parseComment(i)
    if (rawdata.slice(i, i + 9) === '<![CDATA[') {
      const j = rawdata.indexOf(']]>', i + 9)
      if (j < 0) return -1
      this.unknownDecl(rawdata.slice(i + 3, j))
      return j + 3
    }
    if (rawdata.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gtpos = rawdata.indexOf('>', i + 9)
      if (gtpos === -1) return -1
      this.handleDecl(rawdata.slice(i + 2, gtpos))
      return gtpos + 1
    }
    if (rawdata.slice(i, i + 3) === '<![') {
      const j = rawdata.indexOf('>', i + 3)
      if (j < 0) return -1
      if (rawdata[j - 1] === ']') this.unknownDecl(rawdata.slice(i + 3, j - 1))
      else this.handleComment(rawdata.slice(i + 2, j))
      return j + 1
    }
    return this.parseBogusComment(i)
  }

  private parseComment(i: number): number {
    const rawdata = this.rawdata
    let match = searchFrom(COMMENTCLOSE, rawdata, i + 4)
    if (!match) {
      match = matchAt(COMMENTABRUPTCLOSE, rawdata, i + 4)
      if (!match) return -1
    }
    this.handleComment(rawdata.slice(i + 4, match.index))
    return match.index + match[0].length
  }

  private parseBogusComment(i: number): number {
    const rawdata = this.rawdata
    const pos = rawdata.indexOf('>', i + 2)
    if (pos === -1) return -1
    this.handleComment(rawdata.slice(i + 2, pos))
    return pos + 1
  }

  private parsePi(i: number): number {
    const rawdata = this.rawdata
    const j = rawdata.indexOf('>', i + 2)
    if (j < 0) return -1
    this.handlePi(rawdata.slice(i + 2, j))
    return j + 1
  }

  private parseStarttag(i: number): number {
    const rawdata = this.rawdata
    const endpos = this.checkForWholeStartTag(i)
    if (endpos < 0) return endpos
    const attrs: [string, string | null][] = []
    const match = matchAt(TAGFIND_TOLERANT, rawdata, i + 1)!
    let k = match.index + match[0].length
    const tag = match[1]!.toLowerCase()
    while (k < endpos) {
      const m = matchAt(ATTRFIND_TOLERANT, rawdata, k)
      if (!m) break
      const attrname = m[1]!
      const rest = m[2]
      let attrvalue: string | null | undefined = m[3]
      if (!rest) attrvalue = null
      else if (attrvalue !== undefined && ((attrvalue[0] === "'" && attrvalue.endsWith("'") && attrvalue.length >= 1) || (attrvalue[0] === '"' && attrvalue.endsWith('"') && attrvalue.length >= 1))) {
        attrvalue = attrvalue.length >= 2 ? attrvalue.slice(1, -1) : ''
      }
      if (attrvalue) attrvalue = unescape(attrvalue)
      attrs.push([attrname.toLowerCase(), attrvalue ?? null])
      k = m.index + m[0].length
    }
    const endText = strip(rawdata.slice(k, endpos))
    if (endText !== '>' && endText !== '/>') {
      this.handleData(rawdata.slice(i, endpos))
      return endpos
    }
    if (endText.endsWith('/>')) {
      // XHTML-style empty tag: <span attr="value" />
      this.handleStartendtag(tag, attrs)
    } else {
      this.handleStarttag(tag, attrs)
      if (CDATA_CONTENT_ELEMENTS.has(tag) || tag === 'plaintext') this.setCdataMode(tag, false)
      else if (RCDATA_CONTENT_ELEMENTS.has(tag)) this.setCdataMode(tag, true)
    }
    return endpos
  }

  private checkForWholeStartTag(i: number): number {
    const rawdata = this.rawdata
    const match = matchAt(LOCATETAGEND, rawdata, i + 1)!
    const j = match.index + match[0].length
    if (rawdata[j - 1] !== '>') return -1
    return j
  }

  private parseEndtag(i: number): number {
    const rawdata = this.rawdata
    if (rawdata.indexOf('>', i + 2) < 0) return -1
    if (!matchAt(ENDTAGOPEN, rawdata, i)) {
      if (rawdata.slice(i + 2, i + 3) === '>') return i + 3
      return this.parseBogusComment(i)
    }
    const m = matchAt(LOCATETAGEND, rawdata, i + 2)!
    const j = m.index + m[0].length
    if (rawdata[j - 1] !== '>') return -1
    const tagMatch = matchAt(TAGFIND_TOLERANT, rawdata, i + 2)!
    this.handleEndtag(tagMatch[1]!.toLowerCase())
    this.clearCdataMode()
    return j
  }

  // --- BeautifulSoupHTMLParser handlers ---

  private handleStartendtag(tag: string, attrs: [string, string | null][]): void {
    this.handleStarttag(tag, attrs, false)
    this.handleEndtag(tag, false)
  }

  private handleStarttag(tag: string, attrs: [string, string | null][], handleEmptyElement = true): void {
    const dict = new Map<string, string>()
    for (const [key, value] of attrs) dict.set(key, value ?? '')
    const tagObj = this.soup.handleStartTag(tag, dict)
    if (tagObj.isEmptyElement && handleEmptyElement) {
      // html.parser sends no end event for void tags written <br>, so close it here and remember to ignore a real </br>.
      this.handleEndtag(tag, false)
      this.alreadyClosedEmptyElement.push(tag)
    }
  }

  private handleEndtag(tag: string, checkAlreadyClosed = true): void {
    const at = this.alreadyClosedEmptyElement.indexOf(tag)
    if (checkAlreadyClosed && at >= 0) this.alreadyClosedEmptyElement.splice(at, 1)
    else this.soup.handleEndTag(tag)
  }

  private handleData(data: string): void {
    this.soup.handleData(data)
  }

  private handleCharref(name: string): void {
    const [dereferenced, extra] = dereferenceNumeric(name)
    this.handleData(dereferenced)
    this.handleData(extra)
  }

  private handleEntityref(name: string): void {
    const character = hasOwn(HTML_ENTITY_TO_CHARACTER, name) ? HTML_ENTITY_TO_CHARACTER[name] : undefined
    // An unknown name is the literal text "&name" (bs4 drops the semicolon).
    this.handleData(character !== undefined ? character : `&${name}`)
  }

  private handleComment(data: string): void {
    this.soup.endData()
    this.soup.handleData(data)
    this.soup.endData('comment')
  }

  private handleDecl(decl: string): void {
    this.soup.endData()
    this.soup.handleData(decl.slice('DOCTYPE '.length))
    this.soup.endData('doctype')
  }

  private unknownDecl(data: string): void {
    let kind: StringKind = 'declaration'
    if (data.toUpperCase().startsWith('CDATA[')) {
      kind = 'cdata'
      data = data.slice('CDATA['.length)
    }
    this.soup.endData()
    this.soup.handleData(data)
    this.soup.endData(kind)
  }

  private handlePi(data: string): void {
    this.soup.endData()
    this.soup.handleData(data)
    this.soup.endData('pi')
  }
}

/** Feed markup through html.parser into a BeautifulSoup tree. */
function feedHtmlParser(soup: BeautifulSoup, markup: string): void {
  const parser = new PyHtmlParser(soup)
  parser.feed(markup)
  parser.close()
  soup.finish()
}

export type ParserName = 'html.parser' | 'lxml'

/** `BeautifulSoup(markup, parser)`. */
export function parse(markup: string, parser: ParserName = 'html.parser'): BeautifulSoup {
  if (parser === 'lxml') return parseLxml(markup)
  const soup = new BeautifulSoup()
  feedHtmlParser(soup, markup)
  return soup
}

export { parse as BeautifulSoupParse }
