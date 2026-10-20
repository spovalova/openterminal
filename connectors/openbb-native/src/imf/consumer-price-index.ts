// economy/cpi, provider imf. Ported from openbb_imf/models/consumer_price_index.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models.
import { flag, text, whole } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { CPI_COUNTRIES, EXPENDITURE_CHOICES, EXPENDITURE_DICT_REV, EXPENDITURE_ORDER, TRANSFORMATION_MAP } from './cpi-constants.js'
import { compareText, normalizeCountryLabel } from './helpers.js'
import { fetchImfData } from './query-builder.js'

const CPI_LABEL_TO_CODE = new Map(CPI_COUNTRIES.map((c) => [normalizeCountryLabel(c.label), c.value] as const))
const CPI_CODE_SET = new Set(CPI_COUNTRIES.map((c) => c.value))
const EXPENDITURE_DICT = Object.fromEntries(Object.entries(EXPENDITURE_DICT_REV).map(([code, name]) => [name, code]))

/** ISO3 codes or country names as the dataflow's country codes (`validate_country`). */
function resolveCountries(raw: string): string[] {
  return raw.replace(/ /g, '_').split(',').map((v) => {
    const upper = v.toUpperCase()
    const lower = v.toLowerCase()
    if (CPI_CODE_SET.has(upper)) return upper
    const code = CPI_LABEL_TO_CODE.get(lower)
    if (code !== undefined) return code
    throw new Error(`Country '${v}' is not a valid IMF country code (ISO3) or country name.`)
  })
}

/** Expenditure names, lower case (`validate_expenditure`). */
function resolveExpenditures(raw: string): string[] {
  return raw.replace(/ /g, '_').split(',').map((e) => {
    if (!EXPENDITURE_CHOICES.includes(e.toLowerCase()) && !(e.toUpperCase() in EXPENDITURE_DICT_REV)) throw new Error(`Expenditure '${e}' is not a valid choice. Valid choices:\n\n${JSON.stringify(EXPENDITURE_CHOICES)}`)
    return e.toLowerCase()
  })
}

const stripped = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export async function consumerPriceIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const countries = resolveCountries(text(params, 'country') ?? 'USA')
  const expenditures = resolveExpenditures(text(params, 'expenditure') ?? 'total')
  const transform = text(params, 'transform') ?? 'yoy'
  if (!(transform in TRANSFORMATION_MAP)) throw new Error(`'${transform}'`)
  const frequency = text(params, 'frequency') ?? 'monthly'
  const limit = whole(params, 'limit')
  const startDate = text(params, 'start_date')
  const endDate = text(params, 'end_date')

  const dimensions: Record<string, string | number> = {
    COUNTRY: countries.includes('*') ? '*' : countries.map((c) => c.toUpperCase()).join('+'),
    INDEX_TYPE: flag(params, 'harmonized', false) ? 'HICP' : 'CPI',
    COICOP_1999: expenditures.includes('all') ? '*' : expenditures.map((e) => (e.toUpperCase() in EXPENDITURE_DICT_REV ? e.toUpperCase() : EXPENDITURE_DICT[e]!)).join('+'),
    TYPE_OF_TRANSFORMATION: TRANSFORMATION_MAP[transform]!,
    FREQUENCY: frequency[0]!.toUpperCase(),
  }
  if (limit !== undefined) dimensions.lastNObservations = limit
  const { data } = await fetchImfData(ctx, 'CPI', { startDate, endDate, dimensions })

  const rows: Row[] = []
  for (const item of data) {
    const date = item.TIME_PERIOD as string | undefined
    if (startDate && date && date < startDate) continue
    if (endDate && date && date > endDate) continue
    const frequencyLabel = stripped(item.FREQUENCY)
    const indexType = stripped(item.INDEX_TYPE)
    const expenditure = stripped(item.COICOP_1999) || stripped(item.title)
    const expenditureCode = stripped(item.COICOP_1999_code)
    const transformation = stripped(item.TYPE_OF_TRANSFORMATION)
    const title = `${frequencyLabel} ${indexType} - ${expenditure} - ${transformation}`.trim()
    const unit = (transformation.split(', ').at(-1) ?? '').trim()
    let value = item.OBS_VALUE as number | undefined
    let multiplier = (item.UNIT_MULT as number | undefined) ?? 1
    if (unit.toLowerCase().includes('percent') && value !== undefined) {
      value = value / 100
      multiplier = 100
    }
    rows.push({
      date,
      country: stripped(item.COUNTRY) || undefined,
      country_code: stripped(item.country_code) || undefined,
      series_id: stripped(item.series_id),
      expenditure: expenditure || undefined,
      title,
      unit,
      unit_multiplier: multiplier,
      value,
      order: EXPENDITURE_ORDER[expenditureCode] ?? 99,
    })
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return rows.sort((a, b) => compareText(str(a.date), str(b.date)) || compareText(str(a.country), str(b.country)) || (a.order as number) - (b.order as number))
}
