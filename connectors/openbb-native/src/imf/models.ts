// The IMF data models the PortWatch and shipping routes return rows through. Ported from openbb_imf/models/
// {country_activity,container_metrics,disruption_events,disruption_sankey,monthly_trade,maritime_chokepoint_info,
// maritime_chokepoint_volume,port_info,port_volume}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: each pydantic
// model is a table of its fields (`int`, `float`, `str`, `date`; `!` marks a required one) and the aliases from
// `__alias_dict__`, applied by `validateModel`, which does what pydantic does to these rows: renames, drops
// the fields an `extra="ignore"` model does not declare, converts the numbers and leaves out what is missing.
import type { Row } from '../types.js'

export type ModelSpec = {
  /** What happens to fields the model does not declare. */
  extra: 'ignore' | 'allow'
  /** Field name → the name in the source row (`__alias_dict__`). */
  alias?: Record<string, string>
  /** Field name → kind, `!` after it when the field is required. */
  fields: Record<string, string>
}

const isNil = (v: unknown): boolean => v === null || v === undefined

/** One value as a field of this kind (pydantic's lax mode); undefined for a missing optional one. */
function coerce(name: string, kind: string, required: boolean, value: unknown): unknown {
  if (isNil(value)) {
    if (required) throw new Error(`${name}: field required`)
    return undefined
  }
  switch (kind) {
    case 'int': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof n === 'boolean') return n ? 1 : 0
      if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error(`${name}: input should be a valid integer, got ${JSON.stringify(value)}`)
      return n
    }
    case 'float': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof n !== 'number') throw new Error(`${name}: input should be a valid number, got ${JSON.stringify(value)}`)
      return n
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) throw new Error(`${name}: input should be a valid date, got ${JSON.stringify(value)}`)
      return value.slice(0, 10)
    }
    default:
      if (typeof value !== 'string') throw new Error(`${name}: input should be a valid string, got ${JSON.stringify(value)}`)
      return value
  }
}

/** A source row as the model's fields (`Model.model_validate(row)` and `model_dump(exclude_none=True)`). */
export function validateModel(spec: ModelSpec, raw: Record<string, unknown>): Row {
  const byOrigin = new Map(Object.entries(spec.alias ?? {}).map(([field, origin]) => [origin, field] as const))
  const renamed = new Map<string, unknown>()
  for (const [key, value] of Object.entries(raw)) renamed.set(byOrigin.get(key) ?? key, value)
  const out: Row = {}
  for (const [name, declared] of Object.entries(spec.fields)) {
    const required = declared.endsWith('!')
    const value = coerce(name, required ? declared.slice(0, -1) : declared, required, renamed.get(name))
    if (value !== undefined) out[name] = value
  }
  if (spec.extra === 'allow') for (const [key, value] of renamed) if (!(key in spec.fields) && !isNil(value)) out[key] = value
  return out
}

export const COUNTRY_ACTIVITY: ModelSpec = {
  extra: 'ignore',
  alias: {
    country_code: 'ISO3',
    imports: 'import',
    imports_cargo: 'import_cargo',
    imports_container: 'import_container',
    imports_container_30ma: 'import_container_30MA',
    imports_container_30ma_yoy_doy: 'import_container_30MA_yoy_doy',
    imports_dry_bulk: 'import_dry_bulk',
    imports_general_cargo: 'import_general_cargo',
    imports_roro: 'import_roro',
    imports_tanker: 'import_tanker',
    exports: 'export',
    exports_cargo: 'export_cargo',
    exports_container: 'export_container',
    exports_container_30ma: 'export_container_30MA',
    exports_container_30ma_yoy_doy: 'export_container_30MA_yoy_doy',
    exports_dry_bulk: 'export_dry_bulk',
    exports_general_cargo: 'export_general_cargo',
    exports_roro: 'export_roro',
    exports_tanker: 'export_tanker',
    portcalls_container_30ma: 'portcalls_container_30MA',
    portcalls_container_30ma_yoy_doy: 'portcalls_container_30MA_yoy_doy',
    shipment_30ma: 'shipment_30MA',
    shipment_30ma_yoy_doy: 'shipment_30MA_yoy_doy',
  },
  fields: {
    date: 'str!',
    country_code: 'str!',
    country: 'str',
    portcalls: 'int',
    portcalls_cargo: 'int',
    portcalls_container: 'int',
    portcalls_dry_bulk: 'int',
    portcalls_general_cargo: 'int',
    portcalls_roro: 'int',
    portcalls_tanker: 'int',
    portcalls_container_30ma: 'float',
    portcalls_container_30ma_yoy_doy: 'float',
    imports: 'int',
    imports_cargo: 'int',
    imports_container: 'int',
    imports_dry_bulk: 'int',
    imports_general_cargo: 'int',
    imports_roro: 'int',
    imports_tanker: 'int',
    imports_container_30ma: 'float',
    imports_container_30ma_yoy_doy: 'float',
    exports: 'int',
    exports_cargo: 'int',
    exports_container: 'int',
    exports_dry_bulk: 'int',
    exports_general_cargo: 'int',
    exports_roro: 'int',
    exports_tanker: 'int',
    exports_container_30ma: 'float',
    exports_container_30ma_yoy_doy: 'float',
    shipment: 'int',
    shipment_30ma: 'float',
    shipment_30ma_yoy_doy: 'float',
  },
}

export const CONTAINER_METRICS: ModelSpec = {
  extra: 'allow',
  fields: {
    metric: 'str!',
    portid: 'str!',
    date: 'str!',
    value: 'float',
  },
}

export const DISRUPTION_EVENTS: ModelSpec = {
  extra: 'ignore',
  alias: {
    object_id: 'ObjectId',
    shape_area: 'Shape__Area',
    shape_length: 'Shape__Length',
    html_name: 'htmlname',
    html_description: 'htmldescription',
    page_id: 'pageid',
    longitude: 'long',
    latitude: 'lat',
  },
  fields: {
    eventid: 'int!',
    eventname: 'str!',
    eventtype: 'str',
    alertlevel: 'str',
    severitytext: 'str',
    country: 'str',
    fromdate: 'str',
    todate: 'str',
    editdate: 'str',
    year: 'int',
    n_affectedports: 'int',
    affectedports: 'str',
    affectedpopulation: 'str',
    latitude: 'float',
    longitude: 'float',
    html_name: 'str',
    html_description: 'str',
    page_id: 'str',
    object_id: 'int',
    shape_area: 'float',
    shape_length: 'float',
  },
}

export const DISRUPTION_SANKEY: ModelSpec = {
  extra: 'ignore',
  alias: {
    object_id: 'ObjectId',
    source_port: 'from_',
    source_port_id: 'from_id',
    source_country_code: 'from_iso3',
    target_port: 'to_',
    target_port_id: 'to_id',
    target_country_code: 'to_iso3',
  },
  fields: {
    eventid: 'int!',
    source: 'int!',
    target: 'int!',
    source_port: 'str!',
    target_port: 'str!',
    source_port_id: 'str',
    target_port_id: 'str',
    source_country_code: 'str',
    target_country_code: 'str',
    perc_disaster_capacity: 'float',
    object_id: 'int',
  },
}

export const MONTHLY_TRADE: ModelSpec = {
  extra: 'ignore',
  alias: {
    country_code: 'ISO3',
  },
  fields: {
    date: 'str!',
    country_code: 'str!',
    region: 'str',
    trade_value: 'float',
    trade_volume: 'float',
    value_import_total: 'float',
    value_export_total: 'float',
    volume_import_total: 'float',
    volume_export_total: 'float',
    ais_portcalls_container: 'int',
    ais_portcalls_dry_bulk: 'int',
    ais_portcalls_general_cargo: 'int',
    ais_portcalls_roro: 'int',
    ais_portcalls_tanker: 'int',
    ais_import_container: 'int',
    ais_import_dry_bulk: 'int',
    ais_import_general_cargo: 'int',
    ais_import_roro: 'int',
    ais_import_tanker: 'int',
    ais_export_container: 'int',
    ais_export_dry_bulk: 'int',
    ais_export_general_cargo: 'int',
    ais_export_roro: 'int',
    ais_export_tanker: 'int',
  },
}

export const CHOKEPOINT_INFO: ModelSpec = {
  extra: 'ignore',
  alias: {
    chokepoint_code: 'portid',
    name: 'portname',
    vessel_count_roro: 'vessel_count_RoRo',
    latitude: 'lat',
    longitude: 'lon',
  },
  fields: {
    chokepoint_code: 'str!',
    name: 'str!',
    latitude: 'float!',
    longitude: 'float!',
    vessel_count_total: 'int!',
    vessel_count_tanker: 'int!',
    vessel_count_container: 'int!',
    vessel_count_general_cargo: 'int!',
    vessel_count_dry_bulk: 'int!',
    vessel_count_roro: 'int!',
    industry_top1: 'str',
    industry_top2: 'str',
    industry_top3: 'str',
  },
}

export const CHOKEPOINT_VOLUME: ModelSpec = {
  extra: 'ignore',
  alias: {
    chokepoint: 'portname',
    vessels_total: 'n_total',
    vessels_cargo: 'n_cargo',
    vessels_tanker: 'n_tanker',
    vessels_container: 'n_container',
    vessels_general_cargo: 'n_general_cargo',
    vessels_dry_bulk: 'n_dry_bulk',
    vessels_roro: 'n_roro',
    capacity_total: 'capacity',
  },
  fields: {
    date: 'date!',
    chokepoint: 'str!',
    vessels_total: 'int!',
    vessels_cargo: 'int!',
    vessels_tanker: 'int!',
    vessels_container: 'int!',
    vessels_general_cargo: 'int!',
    vessels_dry_bulk: 'int!',
    vessels_roro: 'int!',
    capacity_total: 'float!',
    capacity_cargo: 'float!',
    capacity_tanker: 'float!',
    capacity_container: 'float!',
    capacity_general_cargo: 'float!',
    capacity_dry_bulk: 'float!',
    capacity_roro: 'float!',
  },
}

export const PORT_INFO: ModelSpec = {
  extra: 'ignore',
  alias: {
    port_code: 'portid',
    port_name: 'portname',
    port_full_name: 'fullname',
    country_code: 'ISO3',
    vessel_count_roro: 'vessel_count_RoRo',
    latitude: 'lat',
    longitude: 'lon',
    country: 'countrynoaccents',
  },
  fields: {
    port_code: 'str!',
    continent: 'str!',
    country: 'str!',
    country_code: 'str!',
    port_name: 'str!',
    port_full_name: 'str!',
    latitude: 'float!',
    longitude: 'float!',
    vessel_count_total: 'int!',
    vessel_count_tanker: 'int!',
    vessel_count_container: 'int!',
    vessel_count_general_cargo: 'int!',
    vessel_count_dry_bulk: 'int!',
    vessel_count_roro: 'int!',
    industry_top1: 'str',
    industry_top2: 'str',
    industry_top3: 'str',
    share_country_maritime_import: 'float!',
    share_country_maritime_export: 'float!',
  },
}

export const PORT_VOLUME: ModelSpec = {
  extra: 'ignore',
  alias: {
    port_code: 'portid',
    port_name: 'portname',
    country_code: 'ISO3',
    imports: 'import',
    imports_cargo: 'import_cargo',
    imports_tanker: 'import_tanker',
    imports_container: 'import_container',
    imports_general_cargo: 'import_general_cargo',
    imports_dry_bulk: 'import_dry_bulk',
    imports_roro: 'import_roro',
    exports: 'export',
    exports_cargo: 'export_cargo',
    exports_tanker: 'export_tanker',
    exports_container: 'export_container',
    exports_general_cargo: 'export_general_cargo',
    exports_dry_bulk: 'export_dry_bulk',
    exports_roro: 'export_roro',
  },
  fields: {
    date: 'date!',
    port_code: 'str',
    port_name: 'str',
    country: 'str',
    country_code: 'str!',
    portcalls: 'int!',
    portcalls_tanker: 'int!',
    portcalls_container: 'int!',
    portcalls_general_cargo: 'int!',
    portcalls_dry_bulk: 'int!',
    portcalls_roro: 'int!',
    imports: 'float!',
    imports_cargo: 'float!',
    imports_tanker: 'float!',
    imports_container: 'float!',
    imports_general_cargo: 'float!',
    imports_dry_bulk: 'float!',
    imports_roro: 'float!',
    exports: 'float!',
    exports_cargo: 'float!',
    exports_tanker: 'float!',
    exports_container: 'float!',
    exports_general_cargo: 'float!',
    exports_dry_bulk: 'float!',
    exports_roro: 'float!',
  },
}

