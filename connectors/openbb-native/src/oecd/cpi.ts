// economy/cpi, provider oecd. Ported from openbb_oecd/models/consumer_price_index.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models.
import { flag, text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { countryCodes, countryParam, fetchRows, observation, thisYear } from './common.js'
import { EXPENDITURE_CHOICES, EXPENDITURE_DICT_REV, EXPENDITURE_ORDER, FREQ_MAP, TRANSFORM_MAP, UNIT_LABELS } from './cpi-constants.js'
import { oecdDate, type Row as CsvRow } from './query-builder.js'

const EXPENDITURE_DICT = Object.fromEntries(Object.entries(EXPENDITURE_DICT_REV).map(([code, name]) => [name, code]))

/** The expenditure param as the model validates it: lower-case names from the choices (`validate_expenditure`). */
function expenditures(params: NativeParams): string {
  const items = (text(params, 'expenditure') ?? 'total').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  for (const item of items) {
    if (!EXPENDITURE_CHOICES.includes(item)) throw new Error(`Expenditure '${item}' is not a valid choice. Valid choices:\n\n${JSON.stringify([...EXPENDITURE_CHOICES].sort())}`)
  }
  return items.join(',')
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

export async function consumerPriceIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const country = countryParam(params, 'united_states')
  const expenditure = expenditures(params)
  const transform = text(params, 'transform') ?? 'yoy'
  const harmonized = flag(params, 'harmonized', false)
  const startDate = text(params, 'start_date') ?? '1950-01-01'
  const endDate = text(params, 'end_date') ?? `${String(thisYear(ctx)).padStart(4, '0')}-12-31`
  let frequency = text(params, 'frequency') ?? 'monthly'
  // Harmonized data is not published quarterly.
  if (harmonized && frequency === 'quarter') frequency = 'monthly'

  const expItems = expenditure.split(',').map((s) => s.trim()).filter(Boolean)
  const expenditureCode = expItems.includes('all') ? '' : expItems.map((e) => EXPENDITURE_DICT[e] ?? e).join('+')
  let rows: CsvRow[]
  try {
    rows = await fetchRows(ctx, 'DF_PRICES_ALL', {
      start: startDate,
      end: endDate,
      dimensions: { REF_AREA: countryCodes('DF_PRICES_ALL', country), FREQ: FREQ_MAP[frequency] ?? frequency[0]!.toUpperCase(), METHODOLOGY: harmonized ? 'HICP' : 'N', MEASURE: 'CPI', EXPENDITURE: expenditureCode, TRANSFORMATION: TRANSFORM_MAP[transform] ?? '_Z' },
    })
  } catch (exc) {
    throw new Error('No data found for the given query.', { cause: exc })
  }

  const isPct = transform === 'yoy' || transform === 'period'
  const unitLabel = UNIT_LABELS[transform] ?? transform
  const unitMult = isPct ? 100 : 1
  const methodology = harmonized ? 'HICP' : 'CPI'
  const output: Row[] = []
  for (const row of rows) {
    const d = oecdDate(row.TIME_PERIOD)
    if (d === undefined || d < startDate || d > endDate) continue
    let value = observation(row)
    if (value === undefined) continue
    if (isPct) value = value / 100
    const expCode = str(row.EXPENDITURE, '_T')
    const countryCode = str(row.REF_AREA)
    const freqLabel = str(row.FREQ_label)
    const measureLabel = str(row.MEASURE_label, 'Consumer price index')
    const expLabel = 'EXPENDITURE_label' in row ? str(row.EXPENDITURE_label) : (EXPENDITURE_DICT_REV[expCode] ?? expCode)
    const transformLabel = 'TRANSFORMATION_label' in row ? str(row.TRANSFORMATION_label) : unitLabel
    const titleParts = [`${freqLabel} ${measureLabel} (${methodology})`, expLabel]
    if (transformLabel && !['not applicable'].includes(transformLabel.toLowerCase())) titleParts.push(transformLabel)
    const seriesId = [str(row.REF_AREA), str(row.FREQ), str(row.METHODOLOGY, 'N'), str(row.MEASURE, 'CPI'), str(row.EXPENDITURE, '_T'), str(row.TRANSFORMATION, '_Z')].join('.')
    const out: Row = {
      date: d,
      country: 'REF_AREA_label' in row ? row.REF_AREA_label : countryCode,
      country_code: countryCode,
      value,
      unit: unitLabel,
      unit_multiplier: unitMult,
      series_id: seriesId,
      expenditure: expLabel,
      title: titleParts.join(' - '),
    }
    const order = EXPENDITURE_ORDER[expCode]
    if (order !== undefined) out.order = order
    output.push(out)
  }
  return output.sort((a, b) => {
    const da = a.date as string
    const db = b.date as string
    if (da !== db) return da < db ? -1 : 1
    const ca = str(a.country)
    const cb = str(b.country)
    if (ca !== cb) return ca < cb ? -1 : 1
    return ((a.order as number | undefined) ?? 99) - ((b.order as number | undefined) ?? 99)
  })
}
