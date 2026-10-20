// economy/shipping/{chokepoint_info,chokepoint_volume,port_info,port_volume}, provider imf. Ported from
// openbb_imf/models/{maritime_chokepoint_info,maritime_chokepoint_volume,port_info,port_volume}.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows through the model tables in models.ts, the pydantic validators written out.
import { text, whole } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { CHOKEPOINTS_NAME_TO_ID, PORT_CONTINENTS, PORT_COUNTRIES } from './constants.js'
import { CHOKEPOINT_INFO, CHOKEPOINT_VOLUME, PORT_INFO, PORT_VOLUME, validateModel } from './models.js'
import { allDailyChokepointData, dailyChokepointData, dailyPortActivityData, listPorts, portIdsByCountry, pyUrlencode, type Attributes } from './portwatch-helpers.js'

// --- economy/shipping/chokepoint_info

const CHOKEPOINTS_URL = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_chokepoints_database/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson'

export async function chokepointInfo(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const res = await ctx.http.response(CHOKEPOINTS_URL)
  if (res.status !== 200) throw new Error(`Failed to fetch data: ${res.status}`)
  const data = (await res.json()) as { features?: { properties: Attributes }[] }
  if (!data || !data.features) throw new Error('No data found in the response.')
  return data.features.map((f) => validateModel(CHOKEPOINT_INFO, f.properties))
}

// --- economy/shipping/chokepoint_volume

const CHOKEPOINT_IDS = new Set(Object.values(CHOKEPOINTS_NAME_TO_ID))

/** The chokepoint param as the query model validates it: names or `chokepointN` ids, comma separated (`validate_chokepoint`). */
function chokepointParam(raw: string | undefined): string[] {
  if (!raw) return []
  const known = (v: string): boolean => v in CHOKEPOINTS_NAME_TO_ID || CHOKEPOINT_IDS.has(v)
  const items = raw.split(',')
  for (const item of items) {
    if (!known(item)) throw new Error(`Invalid chokepoint name: ${item} -> Expected one of ${JSON.stringify(Object.keys(CHOKEPOINTS_NAME_TO_ID))} - or chokepointN, where N is a number between 1 and 24`)
  }
  return items
}

export async function chokepointVolume(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const chokepoints = chokepointParam(text(params, 'chokepoint'))
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  let data: Attributes[]
  if (chokepoints.length === 0) data = await allDailyChokepointData(ctx, start, end)
  else {
    const ids = chokepoints.map((c) => CHOKEPOINTS_NAME_TO_ID[c] ?? c)
    data = (await Promise.all(ids.map((id) => dailyChokepointData(ctx, id, start, end)))).flat()
    if (data.length === 0) throw new Error('The response was returned empty with no error message.')
  }
  return data.map((r) => validateModel(CHOKEPOINT_VOLUME, r))
}

// --- economy/shipping/port_info

const PORTS_URL = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query'

export async function portInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = text(params, 'country')
  const continent = text(params, 'continent')
  const limit = whole(params, 'limit')
  let where = '1=1'
  if (country) where = `ISO3='${country.toUpperCase()}'`
  else if (continent) where = `continent='${PORT_CONTINENTS.find((c) => c.value === continent)!.label}'`
  const base: [string, string][] = [['where', where], ['outFields', '*'], ['returnGeometry', 'false'], ['outSR', ''], ['f', 'json'], ['orderByFields', 'vessel_count_total DESC']]
  if (limit) base.push(['resultRecordCount', String(limit)])

  let output: { attributes: Attributes }[] = []
  let offset = 0
  for (;;) {
    const res = await ctx.http.response(`${PORTS_URL}?${pyUrlencode([...base, ['resultOffset', String(offset)]])}`)
    if (res.status !== 200) throw new Error(`Failed to fetch data: ${res.status} -> ${res.statusText}`)
    const data = (await res.json()) as { features?: { attributes: Attributes }[]; exceededTransferLimit?: boolean }
    const features = data.features ?? []
    output.push(...features)
    if (limit && output.length >= limit) {
      output = output.slice(0, limit)
      break
    }
    if (!data.exceededTransferLimit || features.length === 0) break
    offset = output.length
  }
  return output.map((d) => {
    const row = validateModel(PORT_INFO, d.attributes)
    // The share validator: a zero share becomes missing, anything else a fraction.
    for (const field of ['share_country_maritime_import', 'share_country_maritime_export']) {
      const v = row[field] as number | undefined
      if (v) row[field] = v / 100
      else delete row[field]
    }
    return row
  })
}

// --- economy/shipping/port_volume

const PORT_ISO3 = new Set(Object.values(PORT_COUNTRIES))
const snake = (s: string): string => s.replace(/ - /g, '_').replace(/-/g, '_').toLowerCase().replace(/ /g, '_')

/** The port_code param as port ids: ids, port names or a country's ISO3 code (`validate_port_code`). */
async function resolvePortCodes(ctx: NativeCtx, raw: string): Promise<string> {
  const ports = await listPorts(ctx)
  const idMap = new Map(ports.map((p) => [p.portid.toLowerCase(), p.portname] as const))
  const labels = [...idMap.values()]
  const resolved: string[] = []
  for (const item of raw.split(',')) {
    if (item === 'all') return 'all'
    if (PORT_ISO3.has(item.toUpperCase())) {
      const countryPorts = ports.filter((p) => p.ISO3 === item.toUpperCase()).map((p) => p.portid)
      if (countryPorts.length > 0) {
        resolved.push(...countryPorts)
        continue
      }
    }
    const itemLower = (item.includes('(') ? item.toLowerCase().split('(')[0]!.replace(/ /g, '_') : item.toLowerCase().replace(/ /g, '_')).replace(/ - /g, '_').replace(/-/g, '_')
    if (idMap.has(item)) resolved.push(item)
    else if (labels.includes(item)) resolved.push([...idMap].find(([, label]) => label === item)![0])
    else if (labels.some((label) => snake(label) === itemLower)) throw new Error(`port_code ${item}: the name matched, but PortWatch looks the id up by position (KeyError in OpenBB)`)
    else if (labels.some((label) => label.split(' - ')[0]!.toLowerCase().replace(/ /g, '_') === itemLower)) {
      const at = labels.findIndex((label) => label.split(' - ')[0]!.toLowerCase().replace(/ /g, '_') === itemLower)
      resolved.push([...idMap.keys()][at]!)
    } else throw new Error(`Invalid port_code: ${item}. Must be a valid port ID or name.`)
  }
  if (resolved.length === 0) throw new Error('No valid port_code provided.')
  return resolved.join(',')
}

export async function portVolume(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  if (start && start < '2019-01-01') throw new Error(`Minimum start_date is 2019-01-01. Got ${start} instead.`)
  const country = text(params, 'country')
  let portCode = text(params, 'port_code')
  // A country is its ports, unless ports were named too; with neither, the busiest port.
  if (country && !portCode) portCode = await portIdsByCountry(ctx, country)
  if (!portCode) portCode = 'port1114'
  const codes = (await resolvePortCodes(ctx, portCode)).split(',')
  if (codes.length === 0) throw new Error('Expected values as valid portIDs, got None instead.')

  const batches = await Promise.all(
    codes.map(async (code) => {
      try {
        return await dailyPortActivityData(ctx, code, start, end)
      } catch (e) {
        throw new Error(`Error fetching port data: Failed to fetch data for port ${code}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
    }),
  )
  const output = batches.flat()
  if (output.length === 0) throw new Error(`No data found for the specified port(s). ${JSON.stringify(codes)} Ensure the port_code is correct and available in the IMF PortWatch dataset.`)
  const byDateThenName = (a: Attributes, b: Attributes): number => {
    const da = String(a.date)
    const db = String(b.date)
    if (da !== db) return da < db ? -1 : 1
    const na = String(a.portname)
    const nb = String(b.portname)
    return na < nb ? -1 : na > nb ? 1 : 0
  }
  return [...output].sort(byDateThenName).map((r) => validateModel(PORT_VOLUME, r))
}
