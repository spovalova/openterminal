// The EIA dataset catalog at runtime. Ported from openbb_us_eia/utils/catalog.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: the catalog is the compact catalog.json that generate-catalog.py derives from the package's
// eia_catalog.json.xz (labels and descriptions dropped, vocabularies pooled), and only the functions the dataset
// routes call at runtime are here.
import catalogJson from './catalog.json' with { type: 'json' }

/** [value, slug]: an EIA facet code and the readable parameter value OpenBB derives from its label. */
type Choice = [string, string]

export type Facet = {
  /** The facet id in the API (`coalRankId`). */
  id: string
  /** Index into the vocabulary pool; absent when the dataset has none of its own (the group's vocabulary applies). */
  choices?: number
  /** Frequencies the filter exists for, when it is not all of them. */
  frequencies?: string[]
  /** false for a facet that is never a parameter. */
  filterable?: false
}

export type Dataset = {
  path: string
  start: string | null
  end: string | null
  frequency: string | null
  /** Frequency → [period format, API path]. */
  frequencies: Record<string, [string, string]>
  /** Column name → [API column id, 1 when numeric]. */
  columns: Record<string, [string, 0 | 1]>
  facets: Record<string, Facet>
}

type Catalog = {
  pool: Choice[][]
  groups: Record<string, { choices: Record<string, number>; datasets: Record<string, Dataset> }>
  /** OpenBB route → [group, dataset]; AEO and IEO name no dataset (the `release` parameter does) and carry its default. */
  routes: Record<string, [string, string | null, string?]>
}

export const CATALOG = catalogJson as unknown as Catalog

/** `snake_case`: API identifiers (`coalRankId`, `area-name`) to field names. */
export function snakeCase(name: string): string {
  return name.replaceAll('-', '_').replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_').toLowerCase()
}

export function getDataset(group: string, dataset: string): Dataset {
  const g = CATALOG.groups[group]
  if (!g) throw new Error(`Unknown EIA group '${group}'. Choices: ${Object.keys(CATALOG.groups).join(', ')}`)
  const spec = g.datasets[dataset]
  if (!spec) throw new Error(`Unknown dataset '${dataset}' for EIA group '${group}'. Choices: ${Object.keys(g.datasets).join(', ')}`)
  return spec
}

/** The requested frequency (default: the dataset's) and its [format, path]. */
export function resolveFrequency(spec: Dataset, frequency: string | undefined): [string, [string, string]] {
  const freq = frequency ?? spec.frequency ?? Object.keys(spec.frequencies)[0]!
  const found = spec.frequencies[freq]
  if (!found) throw new Error(`Frequency '${freq}' is not available for '${spec.path}'. Choices: ${Object.keys(spec.frequencies).join(', ')}`)
  return [freq, found]
}

/** The API column ids for a comma-separated `data_type` (all columns when empty). */
export function resolveDataColumns(spec: Dataset, dataType: string | undefined): string[] {
  const columns = spec.columns
  if (!dataType) return Object.values(columns).map((c) => c[0])
  const requested = dataType.split(',').map((item) => snakeCase(item.trim()))
  const invalid = requested.filter((item) => item && !(item in columns))
  if (invalid.length > 0) throw new Error(`Invalid data_type value(s) ${invalid.join(', ')} for '${spec.path}'. Choices: ${Object.keys(columns).join(', ')}`)
  return requested.filter(Boolean).map((item) => columns[item]![0])
}

/**
 * Canonical facet parameters → API facet ids and values, with each value checked against the vocabulary
 * (case-insensitively; a readable slug becomes its code). Facets with a single possible value are always sent.
 */
export function resolveFacets(group: string, spec: Dataset, frequency: string, values: Record<string, string | undefined>): Map<string, string[]> {
  const g = CATALOG.groups[group]!
  const vocabulary = (canonical: string, facet: Facet): Choice[] | undefined => {
    const index = facet.choices ?? g.choices[canonical]
    return index === undefined ? undefined : CATALOG.pool[index]
  }
  const query = new Map<string, string[]>()
  // The model lists its filters in the catalog's order, and so does the request.
  const order = [...Object.keys(spec.facets), ...Object.keys(values).filter((k) => !(k in spec.facets))]
  for (const canonical of order) {
    const raw = values[canonical]
    if (raw === undefined || raw === null || raw === '') continue
    const facet = spec.facets[canonical]
    if (!facet) {
      const applicable = Object.keys(spec.facets).join(', ') || 'none'
      throw new Error(`The '${canonical}' filter does not apply to '${spec.path}'. Applicable filters: ${applicable}`)
    }
    if (facet.frequencies && !facet.frequencies.includes(frequency)) {
      throw new Error(`The '${canonical}' filter only applies to frequency: ${facet.frequencies.join(', ')}`)
    }
    let items = String(raw).split(',').map((item) => item.trim()).filter(Boolean)
    const embedded = vocabulary(canonical, facet)
    if (embedded && embedded.length > 0) {
      const lookup = new Map<string, string[]>()
      const add = (key: string, code: string) => lookup.set(key, [...(lookup.get(key) ?? []), code])
      for (const [value, slug] of embedded) {
        add(value.toLowerCase(), value)
        if (slug) add(slug.toLowerCase(), value)
      }
      const corrected: string[] = []
      const invalid: string[] = []
      for (const item of items) {
        const matches = lookup.get(item.toLowerCase())
        if (matches === undefined) invalid.push(item)
        else for (const code of matches) if (!corrected.includes(code)) corrected.push(code)
      }
      if (invalid.length > 0) {
        const valid = [...new Set(embedded.map(([value, slug]) => slug || value))].sort()
        let shown = valid.slice(0, 50).join(', ')
        if (valid.length > 50) shown += `, plus ${valid.length - 50} more - use the \`facet_options\` endpoint for the full list`
        throw new Error(`Invalid ${canonical} value(s): ${invalid.join(', ')}. Valid choices: ${shown}`)
      }
      items = corrected
    }
    query.set(facet.id, items)
  }
  // A facet with exactly one possible value is not a real filter, so the model does not expose it; the request still carries it.
  for (const [canonical, facet] of Object.entries(spec.facets)) {
    if (query.has(facet.id) || facet.filterable === false) continue
    if (facet.frequencies && !facet.frequencies.includes(frequency)) continue
    const fixed = vocabulary(canonical, facet) ?? []
    if (fixed.length === 1) query.set(facet.id, [fixed[0]![0]])
  }
  return query
}

/** A date as the EIA period string of a frequency's format, cut to its granularity. */
export function formatPeriod(date: string, format: string): string {
  const [y, m, d] = date.slice(0, 10).split('-') as [string, string, string]
  if (format === 'YYYY') return y.padStart(4, '0')
  if (format === 'YYYY-MM') return `${y.padStart(4, '0')}-${m}`
  if (format === 'YYYY-"Q"Q') return `${y.padStart(4, '0')}-Q${Math.floor((Number(m) - 1) / 3) + 1}`
  if (format === 'YYYY-MM-DD') return `${y.padStart(4, '0')}-${m}-${d}`
  // A date has no hour: the request starts at midnight.
  if (format.startsWith('YYYY-MM-DD"T"HH24')) return `${y.padStart(4, '0')}-${m}-${d}T00`
  throw new Error(`Unsupported EIA period format: ${format}`)
}

export type Period = {
  /** `YYYY-MM-DD`, or the datetime as pydantic writes it: naive, or with its offset (`Z` for UTC). */
  iso: string
  /** The instant, for ordering. */
  time: number
}

/** An EIA period string as the date (or datetime, for hourly data) it starts at. */
export function parsePeriod(value: string, format: string): Period {
  const utc = (y: number, mo: number, d: number, h = 0) => Date.UTC(y, mo - 1, d, h)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const bad = () => new Error(`time data '${value}' does not match format '${format}'`)
  if (format === 'YYYY') {
    if (!/^\d+$/.test(value)) throw bad()
    return { iso: `${pad(Number(value), 4)}-01-01`, time: utc(Number(value), 1, 1) }
  }
  if (format === 'YYYY-MM') {
    const [y, m] = value.split('-')
    if (!/^\d+$/.test(y ?? '') || !/^\d+$/.test(m ?? '')) throw bad()
    return { iso: `${pad(Number(y), 4)}-${pad(Number(m))}-01`, time: utc(Number(y), Number(m), 1) }
  }
  if (format === 'YYYY-"Q"Q') {
    const [y, q] = value.split('-Q')
    if (!/^\d+$/.test(y ?? '') || !/^\d+$/.test(q ?? '')) throw bad()
    const month = (Number(q) - 1) * 3 + 1
    return { iso: `${pad(Number(y), 4)}-${pad(month)}-01`, time: utc(Number(y), month, 1) }
  }
  if (format === 'YYYY-MM-DD') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!m) throw bad()
    return { iso: value, time: utc(Number(m[1]), Number(m[2]), Number(m[3])) }
  }
  if (format.startsWith('YYYY-MM-DD"T"HH24')) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(value.slice(0, 13))
    if (!m) throw bad()
    const base = utc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))
    const naive = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00`
    const offset = value.slice(13)
    if (!offset) return { iso: naive, time: base }
    // "-04", "+00:00", "-0400": the sign, hours and minutes of the offset the hour is local to.
    const digits = offset.slice(1).replaceAll(':', '')
    const minutes = Number(digits.slice(0, 2) || 0) * 60 + Number(digits.slice(2, 4) || 0)
    const signed = offset[0] === '-' ? -minutes : minutes
    const tz = signed === 0 ? 'Z' : `${signed < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(signed) / 60))}:${pad(Math.abs(signed) % 60)}`
    return { iso: naive + tz, time: base - signed * 60_000 }
  }
  throw new Error(`Unsupported EIA period format: ${format}`)
}
