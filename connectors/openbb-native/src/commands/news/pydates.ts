// Feed dates the way feedparser reads them. Ported from feedparser/datetimes/ (w3dtf.py, rfc822.py, iso8601.py,
// asctime.py, hungarian.py, greek.py, korean.py; feedparser 6.0.14, BSD-2-Clause); modified: a struct_time is a plain
// array of nine numbers, and the perforce format, which needs Python's email package, is left out.
import { split } from '../../sec/markdown/py.js'

/** A `time.struct_time` in UTC: year, month, day, hour, minute, second, weekday (Monday is 0), day of the year, DST flag. */
export type StructTime = number[]

/** Python's `int(text)` for the digit strings dates carry; NaN where Python raises ValueError. */
const pyInt = (text: string): number => (/^\s*[+-]?\d+\s*$/.test(text) ? Number(text.trim()) : NaN)

/** Python's `float(text)` for numbers; NaN where Python raises ValueError (and for inf and nan, which `int()` rejects too). */
const pyFloat = (text: string): number => (/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text) ? Number(text.trim()) : NaN)

const daysInMonth = (year: number, month: number): number => (month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31)

/** `datetime.datetime(...) - timedelta(minutes=…, hours=…)` as a UTC `utctimetuple()`, or null where Python raises. */
function utcTuple(year: number, month: number, day: number, hour: number, minute: number, second: number, deltaMinutes: number, deltaHours: number): StructTime | null {
  if (![year, month, day, hour, minute, second, deltaMinutes, deltaHours].every(Number.isFinite)) return null
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
  const stamp = new Date(0)
  stamp.setUTCFullYear(year, month - 1, day)
  stamp.setUTCHours(hour, minute, second, 0)
  const t = stamp.getTime() - (deltaMinutes + deltaHours * 60) * 60_000
  const d = new Date(t)
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return null
  return tupleOf(d)
}

function tupleOf(d: Date): StructTime {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  const yday = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86_400_000) + 1
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), (d.getUTCDay() + 6) % 7, yday, 0]
}

// ---- RFC 822 ----

const TIMEZONE_NAMES: Record<string, number> = { ut: 0, gmt: 0, z: 0, adt: -3, ast: -4, at: -4, edt: -4, est: -5, et: -5, cdt: -5, cst: -6, ct: -6, mdt: -6, mst: -7, mt: -7, pdt: -7, pst: -8, pt: -8, a: -1, n: 1, m: -12, y: 12, met: 1, mest: 2 }
const DAY_NAMES = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const own = (o: object, k: string): boolean => Object.hasOwn(o, k)

/** `_parse_date_rfc822`: RFC 822 dates, with two- or four-digit years, swapped day and month, and more zone names. */
function parseRfc822(date: string): StructTime | null {
  let parts = split(date.toLowerCase())
  if (parts.length < 5) parts.push('00:00:00', '0000')
  if (DAY_NAMES.has(parts[0]!.slice(0, 3))) parts = parts.slice(1)
  if (parts.length < 5) return null

  let month: number | undefined = own(MONTHS, parts[1]!.slice(0, 3)) ? MONTHS[parts[1]!.slice(0, 3)] : undefined
  let day = pyInt(parts[0]!)
  if (Number.isNaN(day)) {
    // The day and month may be swapped.
    if (!own(MONTHS, parts[0]!.slice(0, 3))) return null
    day = pyInt(parts[1]!)
    if (Number.isNaN(day)) return null
    month = MONTHS[parts[0]!.slice(0, 3)]
  }
  if (!month) return null

  let year = pyInt(parts[2]!)
  if (Number.isNaN(year)) return null
  if (parts[2]!.length <= 2) year += year < 90 ? 2000 : 1900

  const timeParts = parts[3]!.split(':')
  while (timeParts.length < 3) timeParts.push('0')
  if (timeParts.length > 3) return null
  const [hour, minute, second] = timeParts.map(pyInt) as [number, number, number]
  if ([hour, minute, second].some(Number.isNaN)) return null

  let zone = parts[4]!
  if (zone.startsWith('etc/')) zone = zone.slice(4)
  if (zone.startsWith('gmt')) zone = zone.slice(3).split(':').join('') || 'gmt'
  let zoneHours: number
  let zoneMinutes: number
  if (zone && (zone[0] === '-' || zone[0] === '+')) {
    zoneHours = pyInt(zone.slice(1, 3))
    zoneMinutes = pyInt(zone.includes(':') ? zone.slice(4) : zone.slice(3))
    if (Number.isNaN(zoneHours) || Number.isNaN(zoneMinutes)) return null
    if (zone[0] === '-') [zoneHours, zoneMinutes] = [-zoneHours, -zoneMinutes]
  } else {
    zoneHours = own(TIMEZONE_NAMES, zone) ? TIMEZONE_NAMES[zone]! : 0
    zoneMinutes = 0
  }
  return utcTuple(year, month, day, hour, minute, second, zoneMinutes, zoneHours)
}

// ---- W3C date and time format ----

const W3DTF_ZONES: Record<string, number> = { ut: 0, gmt: 0, z: 0, adt: -3, ast: -4, at: -4, edt: -4, est: -5, et: -5, cdt: -5, cst: -6, ct: -6, mdt: -6, mst: -7, mt: -7, pdt: -7, pst: -8, pt: -8, a: -1, n: 1, m: -12, y: 12 }

/** `_parse_date_w3dtf`: W3C date and time, also MSSQL-style datetimes with a space as the separator. */
function parseW3dtf(datestr: string): StructTime | null {
  if (!datestr.trim()) return null
  let parts = datestr.toLowerCase().split('t')
  if (parts.length === 1) {
    // A date only, or an MSSQL-style date.
    parts = split(parts[0]!)
    if (parts.length === 1) parts.push('00:00:00z')
  } else if (parts.length > 2) return null
  const date = splitMax(parts[0]!, '-', 2)
  if (date.length === 0 || date[0]!.length !== 4) return null
  while (date.length < 3) date.push('1')
  if (date.length > 3) return null
  const [year, month, day] = date.map(pyInt) as [number, number, number]
  if ([year, month, day].some(Number.isNaN)) return null
  if (parts[1]!.endsWith('z')) {
    parts[1] = parts[1]!.slice(0, -1)
    parts.push('z')
  }
  // The numeric offset, if any, goes last. Adding 1 to each find() makes -1 false.
  let loc = (parts[1]!.indexOf('-') + 1) || (parts[1]!.indexOf('+') + 1) || parts[1]!.length + 1
  loc -= 1
  parts.push(parts[1]!.slice(loc))
  parts[1] = parts[1]!.slice(0, loc)
  const time = splitMax(parts[1]!, ':', 2)
  while (time.length < 3) time.push('0')
  let tzhour: number
  let tzmin: number
  if (['-', '+'].includes(parts[2]!.slice(0, 1))) {
    tzhour = pyInt(parts[2]!.slice(1, 3))
    tzmin = pyInt(parts[2]!.slice(4))
    if (Number.isNaN(tzhour) || Number.isNaN(tzmin)) return null
    if (parts[2]!.startsWith('-')) [tzhour, tzmin] = [-tzhour, -tzmin]
  } else {
    tzhour = own(W3DTF_ZONES, parts[2]!) ? W3DTF_ZONES[parts[2]!]! : 0
    tzmin = 0
  }
  const [hour, minute, second] = time.map((t) => Math.trunc(pyFloat(t))) as [number, number, number]
  if ([hour, minute, second].some((n) => !Number.isFinite(n))) return null
  return utcTuple(year, month, day, hour, minute, second, tzmin, tzhour)
}

/** `text.split(sep, maxsplit)`. */
function splitMax(text: string, sep: string, maxsplit: number): string[] {
  const out: string[] = []
  let rest = text
  while (out.length < maxsplit) {
    const at = rest.indexOf(sep)
    if (at < 0) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at + sep.length)
  }
  out.push(rest)
  return out
}

// ---- ISO 8601 ----

const TEMPLATES = ['YYYY-?MM-?DD', 'YYYY-0MM?-?DD', 'YYYY-MM', 'YYYY-?OOO', 'YY-?MM-?DD', 'YY-?OOO', 'YYYY', '-YY-?MM', '-OOO', '-YY', '--MM-?DD', '--MM', '---DD', 'CC', '']
const ISO8601 = TEMPLATES.map(
  (tmpl) =>
    new RegExp(
      `^${tmpl.replace('YYYY', '(?<year>\\d{4})').replace('YY', '(?<year>\\d\\d)').replace('MM', '(?<month>[01]\\d)').replace('DD', '(?<day>[0123]\\d)').replace('OOO', '(?<ordinal>[0123]\\d\\d)').replace('CC', '(?<century>\\d\\d$)')}` +
        '(T?(?<hour>\\d{2}):(?<minute>\\d{2})(:(?<second>\\d{2}))?(\\.(?<fracsecond>\\d+))?(?<tz>[+-](?<tzhour>\\d{2})(:(?<tzmin>\\d{2}))?|Z)?)?',
    ),
)

/** `_parse_date_iso8601`: ISO 8601 in many spellings. Python builds the tuple with mktime and localtime, so it is in local time. */
function parseIso8601(dateString: string, now: Date): StructTime | null {
  let m: RegExpMatchArray | null = null
  for (const re of ISO8601) {
    m = re.exec(dateString)
    if (m) break
  }
  if (!m || m[0].length === 0) return null
  const g = m.groups ?? {}
  const ordinal = g.ordinal ? Number(g.ordinal) : 0
  let year: number
  if (!g.year) year = now.getFullYear()
  else if (g.year.length === 2) year = 100 * Math.trunc(now.getFullYear() / 100) + Number(g.year)
  else year = Number(g.year)
  const month = g.month ? Number(g.month) : ordinal ? 1 : now.getMonth() + 1
  let day: number
  if (!g.day) day = ordinal ? ordinal : g.century || g.year || g.month ? 1 : now.getDate()
  else day = Number(g.day)
  if (g.century !== undefined) year = (Number(g.century) - 1) * 100 + 1
  let hour = Number(g.hour || 0)
  let minute = Number(g.minute || 0)
  const second = Math.trunc(Number(g.second || 0))
  const tz = g.tz
  if (tz && tz !== 'Z') {
    if (tz[0] === '-') {
      hour += Number(g.tzhour || 0)
      minute += Number(g.tzmin || 0)
    } else {
      hour -= Number(g.tzhour || 0)
      minute -= Number(g.tzmin || 0)
    }
  }
  // mktime normalises an out-of-range field; Date does the same, in local time.
  const d = new Date(2000, 0, 1)
  d.setFullYear(year, month - 1, day)
  d.setHours(hour, minute, second, 0)
  if (Number.isNaN(d.getTime())) return null
  const start = new Date(d.getFullYear(), 0, 1).getTime()
  const yday = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - start) / 86_400_000) + 1
  // tm_isdst: daylight saving is in force when the offset is below the larger of the year's two (January and July).
  const standard = Math.max(new Date(d.getFullYear(), 0, 1).getTimezoneOffset(), new Date(d.getFullYear(), 6, 1).getTimezoneOffset())
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), (d.getDay() + 6) % 7, yday, d.getTimezoneOffset() < standard ? 1 : 0]
}

// ---- asctime ----

/** `_parse_date_asctime`: `{weekday} {month} dd hh:mm:ss [{tz}] yyyy`, through the RFC 822 parser. */
function parseAsctime(dt: string): StructTime | null {
  const parts = split(dt)
  if (parts.length === 5) parts.splice(4, 0, '+0000')
  if (parts.length !== 6) return null
  return parseRfc822([parts[0], parts[2], parts[1], parts[5], parts[3], parts[4]].join(' '))
}

// ---- regional formats ----

const HUNGARIAN_MONTHS: Record<string, string> = { január: '01', februári: '02', március: '03', április: '04', máujus: '05', június: '06', július: '07', augusztus: '08', szeptember: '09', október: '10', november: '11', december: '12' }

function parseHungarian(dateString: string): StructTime | null {
  const m = /^(\d{4})-([^-]+)-(\d{0,2})T(\d{0,2}):(\d{2})([+-](\d{0,2}:\d{2}))/.exec(dateString)
  if (!m || !own(HUNGARIAN_MONTHS, m[2]!)) return null
  const day = m[3]!.length === 1 ? `0${m[3]}` : m[3]!
  const hour = m[4]!.length === 1 ? `0${m[4]}` : m[4]!
  return parseW3dtf(`${m[1]}-${HUNGARIAN_MONTHS[m[2]!]}-${day}T${hour}:${m[5]}${m[6]}`)
}

const GREEK_MONTHS: Record<string, string> = { Ιαν: 'Jan', Φεβ: 'Feb', Μάώ: 'Mar', Μαώ: 'Mar', Απρ: 'Apr', Μάι: 'May', Μαϊ: 'May', Μαι: 'May', Ιούν: 'Jun', Ιον: 'Jun', Ιούλ: 'Jul', Ιολ: 'Jul', Αύγ: 'Aug', Αυγ: 'Aug', Σεπ: 'Sep', Οκτ: 'Oct', Νοέ: 'Nov', Νοε: 'Nov', Δεκ: 'Dec' }
const GREEK_WDAYS: Record<string, string> = { Κυρ: 'Sun', Δευ: 'Mon', Τρι: 'Tue', Τετ: 'Wed', Πεμ: 'Thu', Παρ: 'Fri', Σαβ: 'Sat' }

function parseGreek(dateString: string): StructTime | null {
  const m = /^([^,]+),\s+(\d{2})\s+([^\s]+)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([^\s]+)/.exec(dateString)
  if (!m) return null
  // Python indexes its tables directly, so an unknown day or month is a KeyError, which moves on to the next format.
  if (!own(GREEK_WDAYS, m[1]!) || !own(GREEK_MONTHS, m[3]!)) return null
  return parseRfc822(`${GREEK_WDAYS[m[1]!]}, ${m[2]} ${GREEK_MONTHS[m[3]!]} ${m[4]} ${m[5]}:${m[6]}:${m[7]} ${m[8]}`)
}

function parseOnblog(dateString: string): StructTime | null {
  const m = /^(\d{4})년\s+(\d{2})월\s+(\d{2})일\s+(\d{2}):(\d{2}):(\d{2})/.exec(dateString)
  return m ? parseW3dtf(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`) : null
}

function parseNate(dateString: string): StructTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(오전|오후)\s+(\d{0,2}):(\d{0,2}):(\d{0,2})/.exec(dateString)
  if (!m) return null
  let hour = pyInt(m[5]!)
  if (m[4] === '오후') hour += 12
  const text = String(hour).length === 1 ? `0${hour}` : String(hour)
  return parseW3dtf(`${m[1]}-${m[2]}-${m[3]}T${text}:${m[6]}:${m[7]}+09:00`)
}

/** The handlers in the order feedparser tries them (the last one registered first). */
const HANDLERS: ((dateString: string, now: Date) => StructTime | null)[] = [parseW3dtf, parseRfc822, parseIso8601, parseAsctime, parseHungarian, parseGreek, parseNate, parseOnblog]

/** `_parse_date`: a variety of date formats as a UTC struct_time, or null. */
export function parseDate(dateString: string | undefined, now: Date): StructTime | null {
  if (!dateString) return null
  for (const handler of HANDLERS) {
    let tuple: StructTime | null
    try {
      tuple = handler(dateString, now)
    } catch {
      continue
    }
    if (tuple && tuple.length === 9) return tuple
  }
  return null
}
