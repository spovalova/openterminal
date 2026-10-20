// usda/cost_estimates_of_foodborne_illnesses, provider usda. Ported from openbb_government_us/usda/models/cost_estimates_of_foodborne_illnesses.py
// and utils/ers_cost_estimates_of_foodborne_illnesses.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optString, pyFloat } from './helpers.js'

const DEFAULT_TABLE = 'cases_and_cost'

type Kind = 'int' | 'float' | 'text'
type ValueColumn = { source: string; label: string; kind: Kind }

const col = (source: string, label: string, kind: Kind): ValueColumn => ({ source, label, kind })

const COST_ESTIMATES_TABLES: Record<string, { media: string; columns: ValueColumn[] }> = {
  cases_and_cost: {
    media: '/media/5317/cases-total-cost-and-per-case-cost-by-pathogen.csv',
    columns: [
      col('Mean number of cases', 'Mean number of cases', 'int'),
      col('Mean total cost (millions)', 'Mean total cost (2023 $ millions)', 'float'),
      col(' Mean per-case cost', 'Mean per-case cost (2023 $)', 'float'),
    ],
  },
  health_outcome_cost: {
    media: '/media/5319/mean-cost-for-specific-health-outcomes-by-pathogen.csv',
    columns: [
      col("No physician's visit mean", "No physician's visit", 'float'),
      col("No physician's visit CrI", "No physician's visit (CrI)", 'text'),
      col("Physician's visit only mean", "Physician's visit only", 'float'),
      col("Physician's visit only CrI", "Physician's visit only (CrI)", 'text'),
      col('Hospitalized, recovered', 'Hospitalized, recovered', 'float'),
      col('Hospitalized, recovered Crl', 'Hospitalized, recovered (CrI)', 'text'),
      col('Hospitalized, died', 'Hospitalized, died', 'float'),
      col('Hospitalized, died Crl', 'Hospitalized, died (CrI)', 'text'),
      col('Chronic outcomes', 'Chronic outcomes', 'float'),
      col('Chronic outcomes Crl', 'Chronic outcomes (CrI)', 'text'),
      col('Total', 'Total', 'float'),
      col('Total Crl', 'Total (CrI)', 'text'),
    ],
  },
}

/** `coerce_value`: a cell as an int, float or stripped text; empty cells and placeholder tokens are missing. */
function coerceValue(raw: string | undefined, kind: Kind): number | string | null {
  const value = (raw ?? '').trim()
  if (!value || isNullToken(value)) return null
  if (kind === 'text') return value
  const n = pyFloat(value)
  if (n === undefined) throw new Error(`could not convert string to float: '${value}'`)
  return kind === 'int' ? Math.trunc(n) : n
}

export async function costEstimatesOfFoodborneIllnesses(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = COST_ESTIMATES_TABLES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(COST_ESTIMATES_TABLES).join(', ')}`)

  const rows: Row[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, config.media))) {
    const pathogen = (row.Pathogen ?? '').trim()
    if (!pathogen) continue
    const record: Row = { pathogen_classification: (row['Pathogen classification'] ?? '').trim() || null, pathogen }
    for (const c of config.columns) record[c.label] = coerceValue(row[c.source], c.kind)
    // pathogen_classification is a required string in the model.
    if (nullTokensToNone(record).pathogen_classification === null) throw new Error('pathogen_classification: Input should be a valid string')
    rows.push(nullTokensToNone(record))
  }
  return rows
}
