import { descriptorKey, routeNamespace, type Descriptor, type DescriptorRef, type Liveness } from './descriptor.js'

/**
 * The catalog (PLAN.md section 17): the searchable union of every connector's descriptors, with liveness.
 * Generated, never edited. `find` is what the agent's `find_route` tool and the Data page call: BM25 over the
 * route path, summary, description, param and field names, no embeddings, no network, with a bias toward the
 * trading namespaces. Dead routes (liveness `ok: false`) are hidden unless asked for; unknown liveness is visible.
 */

export type CatalogHit = {
  connector: string
  route: string
  summary: string
  score: number
  providers: string[]
  requiredParams: string[]
  /** The first few field names. */
  fields: string[]
  liveness?: Liveness
}

export type FindOptions = {
  limit?: number
  /** Only routes in these namespaces (first path segment: equity, fixedincome, …). */
  namespaces?: string[]
  connectors?: string[]
  /** Include routes whose last probe failed. */
  includeDead?: boolean
}

/**
 * Score multipliers by namespace: the trading namespaces first, the agricultural and energy series last, so
 * "price history" finds equities before hog futures. 1 for anything not listed.
 */
export const NAMESPACE_BIAS: Record<string, number> = {
  equity: 1.3,
  derivatives: 1.25,
  options: 1.25,
  fixedincome: 1.2,
  news: 1.2,
  economy: 1.15,
  index: 1.15,
  etf: 1.1,
  currency: 1,
  crypto: 1,
  commodity: 0.7,
  eia: 0.5,
  usda: 0.5,
  bls: 0.8,
  jodi: 0.5,
  cftc: 0.8,
  uscongress: 0.5,
  famafrench: 0.7,
  // provider-prefixed routes duplicate unified ones with provider-specific extras
  yfinance: 0.9,
  nasdaq: 0.9,
  cboe: 0.9,
  tmx: 0.6,
  sec: 0.9,
  federal_reserve: 0.9,
  ustreasury: 0.9,
  deribit: 0.8,
  imf: 0.8,
  oecd: 0.8,
  ecb: 0.8,
  fred: 0.9,
}

/** Term weights per zone: a hit in the route path counts more than one in a field name. */
const ZONE_WEIGHT = { route: 3, summary: 2, description: 1, params: 1.5, fields: 1 } as const
const BM25_K1 = 1.2
const BM25_B = 0.75
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'in', 'on', 'by', 'with', 'data', 'get', 'is', 'at', 'from', 'this', 'that', 'as', 'be'])

type IndexEntry = { d: Descriptor; tf: Map<string, number>; length: number }

export class Catalog {
  private readonly byKey = new Map<string, Descriptor>()
  private index: IndexEntry[] = []
  private df = new Map<string, number>()
  private avgLength = 1

  constructor(descriptors: Descriptor[] = []) {
    for (const d of descriptors) this.byKey.set(descriptorKey(d), d)
    this.rebuild()
  }

  get size(): number {
    return this.byKey.size
  }

  all(): Descriptor[] {
    return [...this.byKey.values()]
  }

  connectors(): string[] {
    return [...new Set(this.all().map((d) => d.connector))]
  }

  get(connector: string, route: string): Descriptor | undefined {
    return this.byKey.get(descriptorKey({ connector, route }))
  }

  /** Replace a connector's descriptors (after a regeneration) and re-index. */
  replace(connector: string, descriptors: Descriptor[]): void {
    for (const [k, d] of this.byKey) if (d.connector === connector) this.byKey.delete(k)
    for (const d of descriptors) this.byKey.set(descriptorKey(d), d)
    this.rebuild()
  }

  /** Record a probe result. Unknown routes are ignored. */
  setLiveness(ref: DescriptorRef, liveness: Liveness): void {
    const d = this.byKey.get(descriptorKey(ref))
    if (d) d.liveness = liveness
  }

  /** Per connector: how many routes, how many alive, how many dead, the latest probe time. */
  stats(): Record<string, { routes: number; alive: number; dead: number; unknown: number; probedAt?: number }> {
    const out: Record<string, { routes: number; alive: number; dead: number; unknown: number; probedAt?: number }> = {}
    for (const d of this.byKey.values()) {
      const s = (out[d.connector] ??= { routes: 0, alive: 0, dead: 0, unknown: 0 })
      s.routes++
      if (!d.liveness) s.unknown++
      else if (d.liveness.ok) s.alive++
      else s.dead++
      if (d.liveness) s.probedAt = Math.max(s.probedAt ?? 0, d.liveness.checkedAt)
    }
    return out
  }

  find(query: string, opts: FindOptions = {}): CatalogHit[] {
    const limit = opts.limit ?? 5
    const terms = tokenize(query)
    if (terms.length === 0) return []
    const n = this.index.length
    const hits: CatalogHit[] = []
    for (const e of this.index) {
      const d = e.d
      if (opts.connectors && !opts.connectors.includes(d.connector)) continue
      const ns = routeNamespace(d.route)
      if (opts.namespaces && !opts.namespaces.includes(ns)) continue
      if (!opts.includeDead && d.liveness && !d.liveness.ok) continue
      let score = 0
      let matched = 0
      for (const t of terms) {
        const tf = e.tf.get(t)
        if (!tf) continue
        matched++
        const df = this.df.get(t) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * e.length) / this.avgLength))
      }
      if (matched === 0) continue
      // Every query term matched: a bonus so "price historical" prefers routes with both words.
      if (matched === terms.length && terms.length > 1) score *= 1.25
      score *= NAMESPACE_BIAS[ns] ?? 1
      hits.push({
        connector: d.connector,
        route: d.route,
        summary: d.summary,
        score: Math.round(score * 1000) / 1000,
        providers: d.providers,
        requiredParams: d.params.filter((p) => p.required).map((p) => p.name),
        fields: d.fields.slice(0, 8).map((f) => f.name),
        ...(d.liveness ? { liveness: d.liveness } : {}),
      })
    }
    return hits.sort((a, b) => b.score - a.score || a.route.localeCompare(b.route)).slice(0, limit)
  }

  private rebuild(): void {
    this.index = []
    this.df = new Map()
    let total = 0
    for (const d of this.byKey.values()) {
      const tf = new Map<string, number>()
      const add = (text: string, weight: number) => {
        for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight)
      }
      add(d.route, ZONE_WEIGHT.route)
      add(d.summary, ZONE_WEIGHT.summary)
      if (d.description) add(d.description, ZONE_WEIGHT.description)
      add(d.params.map((p) => p.name).join(' '), ZONE_WEIGHT.params)
      add(d.fields.map((f) => f.name).join(' '), ZONE_WEIGHT.fields)
      let length = 0
      for (const [t, w] of tf) {
        length += w
        this.df.set(t, (this.df.get(t) ?? 0) + 1)
      }
      total += length
      this.index.push({ d, tf, length })
    }
    this.avgLength = this.index.length ? total / this.index.length : 1
  }
}

/** Lowercase word tokens from paths, snake_case and camelCase, with a light plural strip and stop words removed. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem)
}

function stem(t: string): string {
  if (t.length > 6 && t.endsWith('ical')) return `${t.slice(0, -4)}y` // historical → history
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}
