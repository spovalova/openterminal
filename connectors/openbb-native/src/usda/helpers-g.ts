// Shared by the rural-geography ports of usda (part g). Ported from openbb_government_us/usda/utils/ers_rural_urban_continuum_codes.py
// (STATE_NAMES, clean_text, parse_population) and the identical helpers in its sibling ers_*.py modules (OpenBB Platform 5.0.0,
// Apache-2.0); modified: the pandas/xlrd value conversions (str() of a cell) are functions here.
import type { Cell, Sheet } from '../lib/xlsx.js'
import { pyFloat, pyInt } from './helpers.js'

/** Postal code → name, in the order of the Python table. */
export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', VI: 'U.S. Virgin Islands',
}

/** `{name: code}`. */
export const STATE_CODES_BY_NAME: Record<string, string> = Object.fromEntries(Object.entries(STATE_NAMES).map(([code, name]) => [name, code]))

/** Python's `repr(float)`: the shortest round-trip digits, in exponent form below 1e-4 and from 1e16. */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return 'nan'
  if (!Number.isFinite(n)) return n < 0 ? '-inf' : 'inf'
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`.replace(/^-0\.0$/, '-0.0')
  const exp = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)))
  if (exp < -4 || exp >= 16) {
    const [mant, e] = n.toExponential().split('e') as [string, string]
    const sign = e.startsWith('-') ? '-' : '+'
    const digits = e.replace(/^[+-]/, '').padStart(2, '0')
    return `${mant}e${sign}${digits}`
  }
  return String(n)
}

/**
 * What `str(value)` gives for a cell pandas read with `dtype=str`: text as is, an integral number without a decimal point
 * (pandas turns whole xlrd floats into ints), other numbers as Python prints floats, a boolean as `True`/`False`, empty as `nan`.
 */
export function cellStr(value: Cell | undefined): string {
  if (value === null || value === undefined) return 'nan'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return value
}

/** `clean_text`: stripped text, or null when blank or `nan`. Accepts the raw cell or CSV field; undefined and null are missing. */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = (typeof value === 'number' || typeof value === 'boolean' ? cellStr(value) : String(value)).trim()
  if (!text || text.toLowerCase() === 'nan') return null
  return text
}

/** Python's `str.capitalize()`: first character upper case, the rest lower case. */
export function capitalize(text: string): string {
  const first = [...text][0] ?? ''
  return first.toUpperCase() + text.slice(first.length).toLowerCase()
}

/** `capitalize_text`. */
export function capitalizeText(value: unknown): string | null {
  const text = cleanText(value)
  return text ? capitalize(text) : null
}

const MISSING_NUMBER = new Set(['nan', 'na', 'n/a'])

/** `parse_population`: an integer count with optional thousands separators; null when blank or not numeric. */
export function parsePopulation(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const text = String(typeof value === 'number' ? cellStr(value) : value).replace(/,/g, '').trim()
  if (!text || MISSING_NUMBER.has(text.toLowerCase())) return null
  const n = pyInt(text)
  if (n !== undefined) return n
  const f = pyFloat(text)
  if (f === undefined) return null
  if (!Number.isFinite(f)) throw new Error(Number.isNaN(f) ? 'cannot convert float NaN to integer' : 'cannot convert float infinity to integer')
  return Math.trunc(f)
}

/** `parse_float`: a float with optional thousands separators; null when blank or not numeric. */
export function parseFloatCell(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const text = String(typeof value === 'number' ? cellStr(value) : value).replace(/,/g, '').trim()
  if (!text || MISSING_NUMBER.has(text.toLowerCase())) return null
  return pyFloat(text) ?? null
}

/** A required string param in a closed set, trimmed (a list takes its first item), or the default for a blank one. */
export function pickParam(value: unknown, allowed: readonly string[], fallback: string, label: string, plural: string): string {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return fallback
  const text = String(Array.isArray(value) ? value[0] : value).trim()
  if (!allowed.includes(text)) throw new Error(`Invalid ${label}: ${text}. Valid ${plural} are: ${allowed.join(', ')}`)
  return text
}

/** State FIPS prefix → postal code, for the 50 states and DC. */
export const STATE_FIPS_ABBR: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
}

/** A cell as `pandas.read_excel(..., dtype=object)` returns it: the value, or null where pandas has NaN (empty or a default NA string). */
export function pdObj(value: Cell | undefined): Cell {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && PANDAS_NA.has(value) ? null : value
}

/** `str(value).strip()` of a cell, or null when it is missing or empty (the `cell_str` of the ERS parsers, where pandas already made NaN missing). */
export function textOf(value: Cell | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = (typeof value === 'string' ? value : cellStr(value)).trim()
  return text || null
}

/** Python's `str.zfill(width)`: zeros on the left, after a sign. */
export function zfill(text: string, width: number): string {
  if (text.length >= width) return text
  const sign = text.startsWith('-') || text.startsWith('+') ? text[0]! : ''
  return sign + '0'.repeat(width - text.length) + text.slice(sign.length)
}

/** `str(int(float(text)))` where that works, else null (Python raises ValueError for text that is not a number). */
export function intOfFloatText(text: string): number | null {
  const f = pyFloat(text)
  return f === undefined || Number.isNaN(f) || !Number.isFinite(f) ? null : Math.trunc(f)
}

/** A sheet's rows the way xlrd's `cell_value` gives them: numbers as floats, '' for an empty cell. */
export function xlrdRows(sheet: Sheet): (string | number | boolean)[][] {
  return sheet.rows.map((row) => row.map((c) => (c === null ? '' : c)))
}

/** `str(value)` of an xlrd cell value: floats print with a decimal point (`1001.0`). */
export function xlrdStr(value: string | number | boolean | null | undefined): string {
  if (typeof value === 'number') return pyFloatRepr(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return value === null || value === undefined ? 'None' : value
}

/** The strings pandas reads as missing by default (`STR_NA_VALUES`). */
const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])

/** A cell as `pandas.read_excel(..., dtype=str)` returns it: text (numbers as `str()` of the number), or null where pandas has NaN. */
export function pdStr(value: Cell | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return PANDAS_NA.has(value) ? null : value
  return cellStr(value)
}

/** The sheet called `name` (`sheet_name=name`); pandas raises when there is none. */
export function sheetNamed(sheets: Sheet[], name: string): Sheet {
  const sheet = sheets.find((s) => s.name === name)
  if (!sheet) throw new Error(`Worksheet named '${name}' not found`)
  return sheet
}

/**
 * The records of a sheet as pandas builds its frame: the first row names the columns (stripped, empty ones `Unnamed: N`, repeats
 * `name.1`), the rest are rows. Cells are left as the reader gave them; `pdStr` them for `dtype=str`.
 */
export function sheetRecords(sheet: Sheet, header = 0, strip = true): Record<string, Cell>[] {
  const head = sheet.rows[header] ?? []
  const seen = new Map<string, number>()
  const names = head.map((h, i) => {
    const text = h === null || h === undefined || h === '' ? '' : typeof h === 'string' ? h : cellStr(h)
    const base = text === '' ? `Unnamed: ${i}` : strip ? text.trim() : text
    const n = seen.get(base)
    seen.set(base, (n ?? 0) + 1)
    return n === undefined ? base : `${base}.${n}`
  })
  return sheet.rows.slice(header + 1).map((r) => Object.fromEntries(names.map((name, i) => [name, r[i] ?? null])))
}

/** `str.sort(key=lambda r: r[key] or "")`: a stable sort of rows by a text key, by code point. */
export function sortByText<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.row)
}
