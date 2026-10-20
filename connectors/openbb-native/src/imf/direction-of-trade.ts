// economy/direction_of_trade, provider imf. Ported from openbb_imf/models/direction_of_trade.py and
// utils/dot_helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, the IMTS
// country lists from the metadata data file.
import { text, whole } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compareText, normalizeCountryLabel } from './helpers.js'
import { dataflowParameters } from './metadata.js'
import { fetchImfData, type DimensionValue } from './query-builder.js'
import { validateModel, type ModelSpec } from './models.js'

const DOT_INDICATORS: Record<string, string> = { exports: 'XG_FOB_USD', imports: 'MG_CIF_USD', balance: 'TBG_USD', all: '*' }

/** The IMTS countries, ordered as OpenBB lists them: countries, then the G regions, then the TX groups (`load_country_choices`). */
function countryChoices(): { label: string; value: string }[] {
  const countries: { label: string; value: string }[] = []
  const gRegions: { label: string; value: string }[] = []
  const txGroups: { label: string; value: string }[] = []
  for (const item of dataflowParameters('IMTS').COUNTRY ?? []) {
    const v = item.value
    if (v.startsWith('G') && (/^\d+$/.test(v.slice(1)) || (v[1] === 'X' && /^\d+$/.test(v.slice(2))))) gRegions.push(item)
    else if (v.startsWith('TX')) txGroups.push(item)
    else countries.push(item)
  }
  const byLabel = (a: { label: string }, b: { label: string }): number => compareText(a.label, b.label)
  return [...countries.sort(byLabel), ...gRegions.sort(byLabel), ...txGroups.sort(byLabel)]
}

const ALIASES: Record<string, string> = { world: 'G001', euro_area: 'G163', eurozone: 'G163', eu: 'G998', european_union: 'G998', europe: 'GX170' }

/** A country code or a name such as `united_states` as the IMF code (`resolve_country_input`). */
function resolveCountryInput(value: string): string {
  if (!value) throw new Error('Country value cannot be empty.')
  if (['all', '*'].includes(value.toLowerCase())) return '*'
  const lower = value.toLowerCase().replace(/ /g, '_')
  if (Object.hasOwn(ALIASES, lower)) return ALIASES[lower]!
  const choices = countryChoices()
  const upper = value.toUpperCase()
  if (choices.some((c) => c.value === upper)) return upper
  const byName = new Map(choices.map((c) => [normalizeCountryLabel(c.label), c.value] as const))
  const hit = byName.get(lower)
  if (hit !== undefined) return hit
  throw new Error(`Country '${value}' is not a valid IMF country code or country name. Use ISO3 codes (e.g., 'USA', 'DEU') or snake_case names (e.g., 'united_states', 'germany').`)
}

/** The country and counterpart params as codes, `*` for all (`_validate_country_fields`). */
function countryField(raw: string | undefined): string {
  if (!raw) throw new Error('Required parameter for IMF provider not supplied.')
  if (['all', '*'].includes(raw.toLowerCase())) return '*'
  const values = raw.split(',')
  const result: string[] = []
  for (const item of values) {
    const trimmed = item.trim()
    if (['all', '*'].includes(trimmed.toLowerCase())) {
      if (values.length > 1) throw new Error("'all' cannot be used with other country codes in a list.")
      return '*'
    }
    result.push(resolveCountryInput(trimmed))
  }
  return result.join(',')
}

/** A selection checked against the values the dataflow has (`_validate_selection`). */
function validateSelection(selection: string, valid: Set<string>, name: string): string | string[] {
  if (valid.size === 0 || selection === '*') return selection
  const list = selection.includes(',') ? selection.split(',').map((s) => s.trim()) : [selection]
  if (list.includes('*')) return '*'
  const invalid = list.filter((item) => !valid.has(item))
  if (invalid.length > 0) throw new Error(`Invalid ${name}(s): ${invalid.join(', ')}`)
  return list.length > 1 ? list : list[0]!
}

const SPEC: ModelSpec = {
  extra: 'ignore',
  alias: { date: 'TIME_PERIOD', symbol: 'series_id', country: 'COUNTRY', counterpart: 'COUNTERPART_COUNTRY', counterpart_code: 'counterpart_country_code', value: 'OBS_VALUE', scale: 'SCALE', frequency: 'FREQUENCY' },
  fields: { date: 'date!', country: 'str!', unit: 'str', country_code: 'str!', counterpart: 'str!', counterpart_code: 'str!', symbol: 'str', title: 'str', value: 'float!', scale: 'str', unit_multiplier: 'int' },
}

export async function directionOfTrade(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryField(text(params, 'country'))
  const counterpart = countryField(text(params, 'counterpart'))
  const direction = text(params, 'direction') ?? 'balance'
  if (!(direction in DOT_INDICATORS)) throw new Error(`Input should be 'exports', 'imports', 'balance' or 'all', got '${direction}' (direction)`)
  const frequency = text(params, 'frequency') ?? 'month'
  if (!['month', 'quarter', 'annual'].includes(frequency)) throw new Error(`Input should be 'month', 'quarter' or 'annual', got '${frequency}' (frequency)`)
  const limit = whole(params, 'limit')

  const imts = dataflowParameters('IMTS')
  const countryValues = new Set((imts.COUNTRY ?? []).map((o) => o.value))
  const counterpartValues = new Set((imts.COUNTERPART_COUNTRY ?? imts.COUNTRY ?? []).map((o) => o.value))
  const dimensions: Record<string, DimensionValue> = {
    FREQUENCY: frequency[0]!.toUpperCase(),
    COUNTRY: validateSelection(country, countryValues, 'country'),
    COUNTERPART_COUNTRY: validateSelection(counterpart, counterpartValues, 'counterpart'),
    INDICATOR: DOT_INDICATORS[direction]!,
  }
  if (limit) dimensions.lastNObservations = limit
  const { data } = await fetchImfData(ctx, 'IMTS', { startDate: text(params, 'start_date'), endDate: text(params, 'end_date'), dimensions })
  if (data.length === 0) throw new Error('No data found for the given query parameters.')
  return data.map((record) => {
    // The symbol validator: the IMTS_ prefix cut off, then `IMTS::` put on.
    const symbol = record.series_id
    const row = validateModel(SPEC, { ...record, series_id: typeof symbol === 'string' ? `IMTS::${symbol.split('IMTS_').at(-1)}` : symbol })
    return row
  })
}
