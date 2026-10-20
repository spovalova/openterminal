// Shared SDMX readers for the providers that publish through SDMX (ECB, IMF, OECD): SDMX-JSON data messages
// (ECB), SDMX-CSV with and without labels (OECD, ECB's fallback), SDMX structure-specific XML (IMF), and the
// period arithmetic they share. Ported from openbb_ecb/utils/helpers.py (parse_sdmx_json, parse_sdmx_csv,
// parse_series_keys, parse_sdmx_period) and from the pandas steps in openbb_oecd/utils/query_builder.py
// (read_csv, `_split_label_columns`); modified: plain records instead of dicts and DataFrames.
import { parseCsv, parseCsvRecords } from './csv.js'
import { asArray, parseXml } from './xml.js'

export type SdmxRecord = Record<string, unknown>

// ---------------------------------------------------------------------------------------------------------------
// Periods

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Python's `date(y, m, d).isoformat()`, or undefined where Python raises ValueError (year 1..9999, a real day). */
export function isoDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return undefined
  const last = new Date(Date.UTC(2001, month, 0)).getUTCDate() + (month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 1 : 0)
  if (day > last) return undefined
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** Python's `int(text)` for the digit strings SDMX periods carry; NaN where Python would raise. */
function pyInt(text: string): number {
  return /^\s*[+-]?\d+\s*$/.test(text) ? Number(text.trim()) : NaN
}

/** Python's `date.fromisocalendar(year, week, weekday)`: the ISO date, or undefined where Python raises ValueError. */
export function fromIsoCalendar(year: number, week: number, weekday: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(week) || year < 1 || year > 9999 || week < 1 || weekday < 1 || weekday > 7) return undefined
  // ISO week 1 is the week with January 4th; its Monday is the anchor.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const mondayOfWeek1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000
  const weeksInYear = (() => {
    const dec28 = new Date(Date.UTC(year, 11, 28))
    const monday = dec28.getTime() - ((dec28.getUTCDay() + 6) % 7) * 86400000
    return Math.round((monday - mondayOfWeek1) / (7 * 86400000)) + 1
  })()
  if (week > weeksInYear) return undefined
  const d = new Date(mondayOfWeek1 + ((week - 1) * 7 + (weekday - 1)) * 86400000)
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/**
 * An SDMX TIME_PERIOD as an ISO `YYYY-MM-DD` start date (`parse_sdmx_period`). `start` is the period's start
 * timestamp when the message carries one, and wins. Periods it cannot read come back unchanged.
 */
export function sdmxPeriodStart(period: string, start?: string | null): string {
  if (start) return start.slice(0, 10)
  if (!period) return period
  // Python unpacks `year, q = period.split(...)`: anything but two parts is a ValueError and the period stays as it is.
  if (period.includes('-Q')) {
    const parts = period.split('-Q')
    const month = parts.length === 2 ? ({ 1: 1, 2: 4, 3: 7, 4: 10 } as Record<number, number>)[pyInt(parts[1]!)] : undefined
    return (month === undefined ? undefined : isoDate(pyInt(parts[0]!), month, 1)) ?? period
  }
  if (period.includes('-S')) {
    const parts = period.split('-S')
    return (parts.length === 2 ? isoDate(pyInt(parts[0]!), pyInt(parts[1]!) === 1 ? 1 : 7, 1) : undefined) ?? period
  }
  if (period.includes('-W')) {
    const parts = period.split('-W')
    return (parts.length === 2 ? fromIsoCalendar(pyInt(parts[0]!), pyInt(parts[1]!), 1) : undefined) ?? period
  }
  const parts = period.split('-')
  if (parts.length === 1 && /^\d+$/.test(parts[0]!)) return isoDate(Number(parts[0]), 1, 1) ?? period
  if (parts.length === 2) return isoDate(pyInt(parts[0]!), pyInt(parts[1]!), 1) ?? period
  return period
}

// ---------------------------------------------------------------------------------------------------------------
// SDMX-JSON data messages (the ECB data API with `format=jsondata`)

type JsonValue = { id?: string; name?: string; start?: string; end?: string } | string
type JsonComponent = { id?: string; values?: JsonValue[] }
export type SdmxJsonMessage = {
  dataSets?: { series?: Record<string, { attributes?: (number | null)[]; observations?: Record<string, (number | string | null)[]> }> }[]
  structure?: {
    dimensions?: { series?: JsonComponent[]; observation?: JsonComponent[] }
    attributes?: { series?: JsonComponent[]; observation?: JsonComponent[] }
  }
}

function decodeValue(values: JsonValue[] | undefined, idx: unknown): [string | undefined, string | undefined] {
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= (values?.length ?? 0)) return [undefined, undefined]
  const item = values![idx]
  if (item !== null && typeof item === 'object') return [item.id, item.name]
  return [item, undefined]
}

/**
 * One record per observation, flattened (`parse_sdmx_json`): every series dimension as `DIM` (code) and `DIM__label`,
 * the series' attributes the same way, the observation's attributes by code, and `series_key`, `period`, `date`
 * (the period's start, ISO), `OBS_VALUE` and `_dim_ids`.
 */
export function parseSdmxJson(message: SdmxJsonMessage | null | undefined): SdmxRecord[] {
  const datasets = message?.dataSets ?? []
  if (datasets.length === 0) return []
  const dims = message?.structure?.dimensions ?? {}
  const seriesDims = dims.series ?? []
  const obsDims = dims.observation?.length ? dims.observation : [{ id: 'TIME_PERIOD', values: [] }]
  const attrs = message?.structure?.attributes ?? {}
  const seriesAttrs = attrs.series ?? []
  const obsAttrs = attrs.observation ?? []
  const timeValues = obsDims[0]?.values ?? []

  const rows: SdmxRecord[] = []
  for (const dataset of datasets) {
    for (const [seriesKey, series] of Object.entries(dataset.series ?? {})) {
      const base: SdmxRecord = {}
      const keyCodes: string[] = []
      const dimIds: string[] = []
      const positions = seriesKey ? seriesKey.split(':') : []
      for (let pos = 0; pos < positions.length; pos++) {
        if (pos >= seriesDims.length) break
        const dim = seriesDims[pos]!
        const [code, label] = decodeValue(dim.values, pyInt(positions[pos]!))
        base[dim.id as string] = code
        base[`${dim.id}__label`] = label
        dimIds.push(dim.id as string)
        if (code !== undefined) keyCodes.push(code)
      }
      base.series_key = keyCodes.join('.')
      base._dim_ids = dimIds

      for (const [aPos, aIdx] of (series.attributes ?? []).entries()) {
        if (aIdx === null || aIdx === undefined || aPos >= seriesAttrs.length) continue
        const attr = seriesAttrs[aPos]!
        const [code, label] = decodeValue(attr.values, aIdx)
        if (code !== undefined) {
          base[attr.id as string] = code
          base[`${attr.id}__label`] = label
        }
      }

      for (const [obsKey, obs] of Object.entries(series.observations ?? {})) {
        const row: SdmxRecord = { ...base }
        const at = pyInt(obsKey)
        const tv = at < timeValues.length ? timeValues[at] : undefined
        const time = tv !== null && typeof tv === 'object' ? tv : {}
        row.period = time.id
        row.date = sdmxPeriodStart(time.id ?? '', time.start)
        row.OBS_VALUE = obs.length > 0 ? obs[0] : undefined
        for (const [oPos, oAttr] of obsAttrs.entries()) {
          const valPos = oPos + 1
          if (valPos < obs.length && obs[valPos] !== null && obs[valPos] !== undefined) {
            const [code] = decodeValue(oAttr.values, obs[valPos])
            if (code !== undefined) row[oAttr.id as string] = code
          }
        }
        rows.push(row)
      }
    }
  }
  return rows
}

/** One record per existing series of a `detail=serieskeysonly` message (`parse_series_keys`), with `series_key` and `name`. */
export function parseSdmxSeriesKeys(message: SdmxJsonMessage | null | undefined): SdmxRecord[] {
  const datasets = message?.dataSets ?? []
  if (datasets.length === 0) return []
  const seriesDims = message?.structure?.dimensions?.series ?? []
  const rows: SdmxRecord[] = []
  for (const dataset of datasets) {
    for (const seriesKey of Object.keys(dataset.series ?? {})) {
      const record: SdmxRecord = {}
      const codes: string[] = []
      const labels: string[] = []
      const positions = seriesKey ? seriesKey.split(':') : []
      for (let pos = 0; pos < positions.length; pos++) {
        if (pos >= seriesDims.length) break
        const dim = seriesDims[pos]!
        const [code, label] = decodeValue(dim.values, pyInt(positions[pos]!))
        record[dim.id as string] = code
        record[`${dim.id}__label`] = label
        if (code !== undefined) codes.push(code)
        if (label) labels.push(label)
      }
      record.series_key = codes.join('.')
      record.name = labels.join(' — ')
      rows.push(record)
    }
  }
  return rows
}

/** Python's `float(text)` for a number written in a data file, or undefined where Python raises ValueError. */
export function pyFloat(text: string): number | undefined {
  const s = text.trim()
  if (/^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(s)) return Number(s.replace(/_/g, ''))
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(s)) return NaN
  return undefined
}

/** A `format=csvdata` response as observation records (`parse_sdmx_csv`): every filled column, plus `series_key`, `period`, `date`, `OBS_VALUE`. */
export function parseSdmxCsv(text: string, flowRef = ''): SdmxRecord[] {
  const rows: SdmxRecord[] = []
  for (const raw of parseCsvRecords(text)) {
    const record: SdmxRecord = {}
    for (const [column, value] of Object.entries(raw)) {
      if (column === '' || column === 'KEY' || column === 'TIME_PERIOD' || column === 'OBS_VALUE' || !value) continue
      record[column] = value
    }
    const key = raw.KEY ?? ''
    const parts = key.split('.')
    record.series_key = parts.length > 1 && parts[0] === flowRef ? parts.slice(1).join('.') : key
    const period = raw.TIME_PERIOD ?? ''
    record.period = period
    record.date = sdmxPeriodStart(period)
    const obs = raw.OBS_VALUE
    record.OBS_VALUE = obs ? (pyFloat(obs) ?? null) : null
    rows.push(record)
  }
  return rows
}

// ---------------------------------------------------------------------------------------------------------------
// SDMX-CSV with labels (OECD's `labels=both`), read the way the OECD fetchers read it with pandas

/** What pandas' `read_csv` takes as missing by default. */
const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export type CsvValue = string | number | null

/**
 * `pandas.read_csv` on a text: columns named by the header, missing cells as null, and a column whose filled cells
 * all read as numbers turned into numbers. Returns the column names and the rows (every row has every column).
 */
export function readCsvFrame(text: string): { columns: string[]; rows: Record<string, CsvValue>[] } {
  const [header, ...body] = parseCsv(text)
  if (!header) return { columns: [], rows: [] }
  // pandas renames duplicate headers "a", "a.1"; the SDMX CSVs do not repeat a header.
  const columns = header
  const numeric = columns.map((_, i) => {
    let any = false
    for (const r of body) {
      const cell = r[i] ?? ''
      if (PANDAS_NA.has(cell)) continue
      any = true
      if (!NUMBER.test(cell.trim())) return false
    }
    return any
  })
  const rows = body.map((r) => {
    const row: Record<string, CsvValue> = {}
    columns.forEach((name, i) => {
      const cell = r[i] ?? ''
      row[name] = PANDAS_NA.has(cell) ? null : numeric[i] ? Number(cell) : cell
    })
    return row
  })
  return { columns, rows }
}

const NON_LABEL_COLUMNS = new Set(['TIME_PERIOD', 'OBS_VALUE', 'DATAFLOW', 'STRUCTURE', 'STRUCTURE_ID', 'ACTION'])

/**
 * Process SDMX-CSV `labels=both` (`_split_label_columns`): headers "DIM: Label" become `DIM`, cells "code: label"
 * become `DIM` (the code) and `DIM_label`, `OBS_VALUE` becomes a number, and missing cells are null. Dimension
 * columns whose first ten filled cells carry no ": " are left as they are.
 */
export function parseSdmxCsvLabels(text: string): Record<string, CsvValue>[] {
  const { columns, rows } = readCsvFrame(text)
  if (rows.length === 0) return []
  const names = columns.map((c) => (c.includes(': ') ? c.split(':')[0]!.trim() : c))
  const index = new Map(names.map((n, i) => [n, columns[i]!] as const))
  const out = rows.map((r) => {
    const row: Record<string, CsvValue> = {}
    for (const n of names) row[n] = r[index.get(n)!] ?? null
    return row
  })
  const splitColumns: string[] = []
  for (const col of names) {
    if (NON_LABEL_COLUMNS.has(col)) continue
    const filled = out.map((r) => r[col]).filter((v) => v !== null)
    if (filled.length === 0 || !filled.every((v) => typeof v === 'string')) continue
    if (filled.slice(0, 10).some((v) => (v as string).includes(': '))) splitColumns.push(col)
  }
  for (const col of splitColumns) {
    for (const row of out) {
      const v = row[col]
      if (typeof v !== 'string') {
        row[`${col}_label`] = null
        continue
      }
      const at = v.indexOf(': ')
      row[col] = (at < 0 ? v : v.slice(0, at)).trim()
      row[`${col}_label`] = at < 0 ? null : v.slice(at + 2).trim()
    }
  }
  for (const row of out) {
    if ('OBS_VALUE' in row) {
      const v = row.OBS_VALUE
      row.OBS_VALUE = typeof v === 'number' ? v : v === null ? null : (pyFloat(v) ?? null)
      if (typeof row.OBS_VALUE === 'number' && Number.isNaN(row.OBS_VALUE)) row.OBS_VALUE = null
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// SDMX structure-specific XML (the IMF data API: `Accept: application/xml`)

export type SdmxXmlSeries = { attributes: Record<string, string>; observations: Record<string, string>[] }
export type SdmxXmlData = {
  /** Series-level `Group` attributes by the group's first non-type attribute value. */
  groups: Record<string, Record<string, string>>
  series: SdmxXmlSeries[]
}

function attributesOf(node: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) if (k.startsWith('@_') && typeof v === 'string') out[k.slice(2)] = v
  return out
}

/** The first DataSet of a structure-specific message with its series, each series' attributes and its observations' attributes. */
export function parseSdmxXml(xml: string): SdmxXmlData | undefined {
  const doc = parseXml(xml)
  const find = (node: unknown, tag: string): unknown => {
    if (!node || typeof node !== 'object') return undefined
    const o = node as Record<string, unknown>
    if (tag in o) return o[tag]
    for (const v of Object.values(o)) {
      const hit = find(v, tag)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const dataSet = asArray(find(doc, 'DataSet'))[0] as Record<string, unknown> | undefined
  if (!dataSet) return undefined
  const groups: Record<string, Record<string, string>> = {}
  for (const g of asArray(dataSet.Group as unknown)) {
    const attrs = attributesOf(g)
    const key = Object.entries(attrs).find(([name, value]) => !(name.toLowerCase().includes('type') && value.toLowerCase().includes('group')))?.[1]
    if (!key) continue
    const values: Record<string, string> = {}
    for (const comp of asArray((g as Record<string, unknown>).Comp)) {
      const c = comp as Record<string, unknown>
      const id = c['@_id']
      const value = c.Value
      const text = typeof value === 'string' ? value : value && typeof value === 'object' ? ((value as Record<string, unknown>)['#text'] as string | undefined) : undefined
      if (typeof id === 'string' && text) values[id] = text
    }
    if (Object.keys(values).length > 0) groups[key] = values
  }
  const series = asArray(dataSet.Series as unknown).map((s) => {
    const obs = asArray((s as Record<string, unknown>).Obs).map((o) => attributesOf(o))
    return { attributes: attributesOf(s), observations: obs }
  })
  return { groups, series }
}
